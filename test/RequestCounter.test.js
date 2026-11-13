const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time, mine, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

/**
 * The agent counts every request the oracle must handle and records the block of each.
 *
 * An oracle on a free RPC tier cannot afford to scan block ranges for events: the log query is
 * capped at a few blocks and metered. With `requestCount` and `requestBlock` it reads one cheap
 * view to learn whether anything is new, then fetches the logs of exactly the blocks that hold a
 * request, however long it was away. Events are unchanged; the counter is read by `eth_call`.
 */
describe("Request counter — every oracle-bound request is counted with its block", function () {
  const ALLOWANCE = ethers.parseEther("100");
  const PROMPT_FEE = ethers.parseEther("10");
  const CANCELLATION_FEE = ethers.parseEther("1");
  const METADATA_FEE = ethers.parseEther("0.5");
  const BRANCH_FEE = ethers.parseEther("2");
  const MOCK_CID = "QmXg9j4f8zYf8t7f8zYf8t7f8zYf8t7f8zYf8t7f8zYf8t7";
  const CID_BUNDLE = {
    conversationCID: MOCK_CID,
    metadataCID: MOCK_CID,
    promptMessageCID: MOCK_CID,
    answerMessageCID: MOCK_CID,
    searchDeltaCID: MOCK_CID,
  };

  const parseEvent = (receipt, contract, name) => {
    const topic = contract.interface.getEvent(name).topicHash;
    const log = receipt.logs.find((l) => l.topics[0] === topic);
    if (!log) throw new Error(`${name} not found in the receipt — recompile?`);
    return contract.interface.parseLog(log);
  };

  const chains = {
    EVM: {
      async deploy() {
        const [deployer, user, oracle, treasury, keeper] = await ethers.getSigners();
        const token = await (await ethers.getContractFactory("MockAbleToken")).deploy();
        await token.waitForDeployment();
        await token.mint(user.address, ALLOWANCE);
        const aiAgent = await upgrades.deployProxy(
          await ethers.getContractFactory("EVMAIAgent"),
          ["example.com", oracle.address, deployer.address],
          { initializer: "initialize", kind: "uups" },
        );
        await aiAgent.waitForDeployment();
        const escrow = await upgrades.deployProxy(
          await ethers.getContractFactory("EVMAIAgentEscrow"),
          [
            await token.getAddress(),
            await aiAgent.getAddress(),
            treasury.address,
            deployer.address,
            PROMPT_FEE,
            CANCELLATION_FEE,
            METADATA_FEE,
            BRANCH_FEE,
          ],
          { initializer: "initialize", kind: "uups" },
        );
        await escrow.waitForDeployment();
        await aiAgent.connect(deployer).setAgentEscrow(await escrow.getAddress());
        await token.connect(user).approve(await escrow.getAddress(), ALLOWANCE);
        await escrow.connect(user).setSpendingLimit(ALLOWANCE, (await time.latest()) + 100000);
        return { aiAgent, escrow, user, oracle, keeper };
      },
      prompt: (escrow, user) => escrow.connect(user).initiatePrompt(0, "0x", "0x"),
      regenerate: (escrow, user, conversationId, promptId, answerId) =>
        escrow.connect(user).initiateRegeneration(conversationId, promptId, answerId, "0x", "0x"),
      branch: (escrow, user, conversationId, messageId) =>
        escrow.connect(user).initiateBranch(conversationId, messageId, "0x", "0x"),
      metadata: (escrow, user, conversationId) =>
        escrow.connect(user).initiateMetadataUpdate(conversationId, "0x", "0x"),
      agentJob: (escrow, oracle, user) =>
        escrow.connect(oracle).initiateAgentJob(user.address, 0, "0x", "0x"),
    },
    Sapphire: {
      async deploy() {
        const [deployer, user, oracle, treasury, keeper] = await ethers.getSigners();
        const aiAgent = await (
          await ethers.getContractFactory("SapphireAIAgent")
        ).deploy("example.com", ethers.zeroPadBytes("0x00", 21), oracle.address, deployer.address);
        await aiAgent.waitForDeployment();
        const escrow = await (
          await ethers.getContractFactory("SapphireAIAgentEscrow")
        ).deploy(
          await aiAgent.getAddress(),
          treasury.address,
          deployer.address,
          PROMPT_FEE,
          CANCELLATION_FEE,
          METADATA_FEE,
          BRANCH_FEE,
        );
        await escrow.waitForDeployment();
        await aiAgent.connect(deployer).setAgentEscrow(await escrow.getAddress());
        await escrow.connect(user).deposit({ value: ALLOWANCE });
        await escrow.connect(user).setSpendingLimit((await time.latest()) + 100000);
        return { aiAgent, escrow, user, oracle, keeper };
      },
      prompt: (escrow, user) => escrow.connect(user).initiatePrompt(0, "payload"),
      regenerate: (escrow, user, conversationId, promptId, answerId) =>
        escrow.connect(user).initiateRegeneration(conversationId, promptId, answerId, "payload"),
      branch: (escrow, user, conversationId, messageId) =>
        escrow.connect(user).initiateBranch(conversationId, messageId, "payload"),
      metadata: (escrow, user, conversationId) =>
        escrow.connect(user).initiateMetadataUpdate(conversationId, "payload"),
      agentJob: (escrow, oracle, user) =>
        escrow.connect(oracle).initiateAgentJob(user.address, 0, "payload"),
    },
  };

  describe("requests that share a block", function () {
    // The rule a reader of the counter must follow: when requestBlock[n] equals requestBlock[n+1],
    // one query of that block returns both events, and both must be handled before either number
    // is treated as done. Events carry no request number, so the block is the unit of work.
    const agents = {
      EVM: async (oracle, deployer) => {
        const aiAgent = await upgrades.deployProxy(
          await ethers.getContractFactory("EVMAIAgent"),
          ["example.com", oracle.address, deployer.address],
          { initializer: "initialize", kind: "uups" },
        );
        await aiAgent.waitForDeployment();
        return { aiAgent, mockEscrowName: "MockEVMAIAgentEscrow" };
      },
      Sapphire: async (oracle, deployer) => {
        const aiAgent = await (
          await ethers.getContractFactory("SapphireAIAgent")
        ).deploy("example.com", ethers.zeroPadBytes("0x00", 21), oracle.address, deployer.address);
        await aiAgent.waitForDeployment();
        return { aiAgent, mockEscrowName: "MockSapphireAIAgentEscrow" };
      },
    };

    for (const [chainName, deployAgent] of Object.entries(agents)) {
      it(`${chainName}: two requests in one transaction get two numbers, one block, two events`, async function () {
        const [deployer, user, oracle] = await ethers.getSigners();
        const { aiAgent, mockEscrowName } = await deployAgent(oracle, deployer);
        const mockEscrow = await (
          await ethers.getContractFactory(mockEscrowName)
        ).deploy(await aiAgent.getAddress());
        await mockEscrow.waitForDeployment();
        await aiAgent.connect(deployer).setAgentEscrow(await mockEscrow.getAddress());
        // The two prompts open conversations 1 and 2, which the agent accepts only once handed out.
        await mockEscrow.callReserveConversationId();
        await mockEscrow.callReserveConversationId();

        const receipt = await (await mockEscrow.callSubmitTwoPrompts(user.address)).wait();

        expect(await aiAgent.requestCount()).to.equal(2n);
        expect(await aiAgent.requestBlock(1)).to.equal(BigInt(receipt.blockNumber));
        expect(await aiAgent.requestBlock(2)).to.equal(BigInt(receipt.blockNumber));
        const events = await aiAgent.queryFilter(
          aiAgent.filters.PromptSubmitted(),
          receipt.blockNumber,
          receipt.blockNumber,
        );
        expect(events).to.have.lengthOf(2);
      });
    }
  });

  for (const [chainName, chain] of Object.entries(chains)) {
    describe(chainName, function () {
      // One answered prompt: request 1 is on the books and there is a conversation to act on.
      async function answeredPromptFixture() {
        const deployed = await chain.deploy();
        const { aiAgent, escrow, user, oracle } = deployed;
        const countAtDeploy = await aiAgent.requestCount();

        const receipt = await (await chain.prompt(escrow, user)).wait();
        const { conversationId, promptMessageId, answerMessageId } = parseEvent(
          receipt,
          aiAgent,
          "PromptSubmitted",
        ).args;
        await aiAgent.connect(oracle).submitAnswer(promptMessageId, answerMessageId, CID_BUNDLE);

        return {
          ...deployed,
          countAtDeploy,
          promptBlock: receipt.blockNumber,
          conversationId,
          promptMessageId,
          answerMessageId,
        };
      }

      it("starts at zero, and the first prompt is request 1 with its block", async function () {
        const { aiAgent, countAtDeploy, promptBlock } = await loadFixture(answeredPromptFixture);
        expect(countAtDeploy).to.equal(0n);
        expect(await aiAgent.requestCount()).to.equal(1n);
        expect(await aiAgent.requestBlock(1)).to.equal(BigInt(promptBlock));
      });

      it("has no block for a request that does not exist", async function () {
        const { aiAgent } = await loadFixture(answeredPromptFixture);
        expect(await aiAgent.requestBlock(0)).to.equal(0n);
        expect(await aiAgent.requestBlock(2)).to.equal(0n);
      });

      const requestKinds = {
        "a regeneration": (c, f) =>
          c.regenerate(f.escrow, f.user, f.conversationId, f.promptMessageId, f.answerMessageId),
        "a branch": (c, f) => c.branch(f.escrow, f.user, f.conversationId, f.answerMessageId),
        "a metadata update": (c, f) => c.metadata(f.escrow, f.user, f.conversationId),
        "an agent job": (c, f) => c.agentJob(f.escrow, f.oracle, f.user),
      };

      for (const [kind, send] of Object.entries(requestKinds)) {
        it(`${kind} is the next request, recorded with the block it was mined in`, async function () {
          const fixture = await loadFixture(answeredPromptFixture);
          await mine(3);

          const receipt = await (await send(chain, fixture)).wait();

          expect(await fixture.aiAgent.requestCount()).to.equal(2n);
          expect(await fixture.aiAgent.requestBlock(2)).to.equal(BigInt(receipt.blockNumber));
        });
      }

      it("requests in later blocks record later blocks, in order", async function () {
        const { aiAgent, escrow, user, conversationId, promptBlock } =
          await loadFixture(answeredPromptFixture);
        await mine(5);
        const second = await (await chain.metadata(escrow, user, conversationId)).wait();
        await mine(2);
        const third = await (await chain.prompt(escrow, user)).wait();

        expect(await aiAgent.requestCount()).to.equal(3n);
        expect(await aiAgent.requestBlock(2)).to.equal(BigInt(second.blockNumber));
        expect(await aiAgent.requestBlock(3)).to.equal(BigInt(third.blockNumber));
        expect(second.blockNumber).to.be.greaterThan(promptBlock);
        expect(third.blockNumber).to.be.greaterThan(second.blockNumber);
      });

      it("a request that reverts is not counted", async function () {
        const fixture = await loadFixture(answeredPromptFixture);
        const { aiAgent, escrow, user, conversationId, promptMessageId, answerMessageId } = fixture;
        await chain.regenerate(escrow, user, conversationId, promptMessageId, answerMessageId);
        const countBefore = await aiAgent.requestCount();

        // A second regeneration of the same prompt is refused while the first is pending.
        await expect(
          chain.regenerate(escrow, user, conversationId, promptMessageId, answerMessageId),
        ).to.be.revertedWithCustomError(aiAgent, "RegenerationAlreadyPending");

        expect(await aiAgent.requestCount()).to.equal(countBefore);
        expect(await aiAgent.requestBlock(countBefore + 1n)).to.equal(0n);
      });

      it("the request's event is in the block the agent recorded for it", async function () {
        const { aiAgent, escrow, user, conversationId } = await loadFixture(answeredPromptFixture);
        await mine(4);
        await chain.metadata(escrow, user, conversationId);

        const recordedBlock = await aiAgent.requestBlock(await aiAgent.requestCount());
        const events = await aiAgent.queryFilter(
          aiAgent.filters.MetadataUpdateRequested(),
          Number(recordedBlock),
          Number(recordedBlock),
        );

        expect(events).to.have.lengthOf(1);
      });

      it("an answer, a cancellation and a refund are not requests", async function () {
        const { aiAgent, escrow, user, keeper } = await loadFixture(answeredPromptFixture);
        // The fixture's answer has already been submitted against request 1.
        expect(await aiAgent.requestCount()).to.equal(1n);
        const cancelReceipt = await (await chain.prompt(escrow, user)).wait();
        const refundReceipt = await (await chain.prompt(escrow, user)).wait();
        const countAfterPrompts = await aiAgent.requestCount();

        await time.increase(Number(await escrow.CANCELLATION_TIMEOUT()) + 1);
        await escrow
          .connect(user)
          .cancelPrompt(parseEvent(cancelReceipt, escrow, "PaymentEscrowed").args[0]);
        await time.increase(Number(await escrow.REFUND_TIMEOUT()) + 1);
        await escrow
          .connect(keeper)
          .processRefund(parseEvent(refundReceipt, escrow, "PaymentEscrowed").args[0]);

        expect(countAfterPrompts).to.equal(3n);
        expect(await aiAgent.requestCount()).to.equal(3n);
      });
    });
  }
});
