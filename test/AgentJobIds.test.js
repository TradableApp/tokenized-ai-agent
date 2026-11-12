const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

/**
 * An agent job and a prompt can never share an escrow.
 *
 * Agent jobs ride the prompt rails: the same escrow record, the same finalization flag, the same
 * cancel and refund. Their ids used to come from a counter of their own, and both counters began
 * at zero, so an agent job's trigger id could equal a pending prompt's answer id and overwrite
 * that prompt's escrow. Trigger ids are now drawn from the message id counter: one id space.
 */
describe("Agent job ids — one id space with prompts", function () {
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
  // Enough agent jobs that a counter of their own, starting at zero, would reach the answer id.
  const AGENT_JOBS = 3;
  const ESCROW_COMPLETE = 1n; // EscrowStatus.COMPLETE

  const parseEvent = (receipt, contract, name) => {
    const topic = contract.interface.getEvent(name).topicHash;
    const log = receipt.logs.find((l) => l.topics[0] === topic);
    if (!log) throw new Error(`${name} not found in the receipt — recompile?`);
    return contract.interface.parseLog(log);
  };

  const chains = {
    EVM: {
      async deploy() {
        const [deployer, promptUser, oracle, treasury, jobUser, keeper] = await ethers.getSigners();
        const token = await (await ethers.getContractFactory("MockAbleToken")).deploy();
        await token.waitForDeployment();
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
        for (const account of [promptUser, jobUser]) {
          await token.mint(account.address, ALLOWANCE);
          await token.connect(account).approve(await escrow.getAddress(), ALLOWANCE);
          await escrow.connect(account).setSpendingLimit(ALLOWANCE, (await time.latest()) + 100000);
        }
        return { aiAgent, escrow, promptUser, jobUser, oracle, keeper };
      },
      prompt: (escrow, user) => escrow.connect(user).initiatePrompt(0, "0x", "0x"),
      agentJob: (escrow, oracle, user) =>
        escrow.connect(oracle).initiateAgentJob(user.address, 0, "0x", "0x"),
    },
    Sapphire: {
      async deploy() {
        const [deployer, promptUser, oracle, treasury, jobUser, keeper] = await ethers.getSigners();
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
        for (const account of [promptUser, jobUser]) {
          await escrow.connect(account).deposit({ value: ALLOWANCE });
          await escrow.connect(account).setSpendingLimit((await time.latest()) + 100000);
        }
        return { aiAgent, escrow, promptUser, jobUser, oracle, keeper };
      },
      prompt: (escrow, user) => escrow.connect(user).initiatePrompt(0, "payload"),
      agentJob: (escrow, oracle, user) =>
        escrow.connect(oracle).initiateAgentJob(user.address, 0, "payload"),
    },
  };

  for (const [chainName, chain] of Object.entries(chains)) {
    describe(chainName, function () {
      // One user's prompt is pending; then the oracle starts agent jobs for another user.
      async function promptThenAgentJobsFixture() {
        const deployed = await chain.deploy();
        const { aiAgent, escrow, promptUser, jobUser, oracle } = deployed;

        const promptReceipt = await (await chain.prompt(escrow, promptUser)).wait();
        const { promptMessageId, answerMessageId } = parseEvent(
          promptReceipt,
          aiAgent,
          "PromptSubmitted",
        ).args;

        const triggerIds = [];
        for (let i = 0; i < AGENT_JOBS; i++) {
          const receipt = await (await chain.agentJob(escrow, oracle, jobUser)).wait();
          triggerIds.push(parseEvent(receipt, aiAgent, "AgentJobSubmitted").args.triggerId);
        }

        return { ...deployed, promptMessageId, answerMessageId, triggerIds };
      }

      it("gives every agent job a trigger id no message has", async function () {
        const { promptMessageId, answerMessageId, triggerIds } = await loadFixture(
          promptThenAgentJobsFixture,
        );
        const ids = [promptMessageId, answerMessageId, ...triggerIds];
        expect(new Set(ids.map(String)).size).to.equal(ids.length);
      });

      it("leaves the pending prompt's escrow with the user who paid for it", async function () {
        const { escrow, promptUser, answerMessageId } = await loadFixture(
          promptThenAgentJobsFixture,
        );
        expect((await escrow.escrows(answerMessageId)).user).to.equal(promptUser.address);
      });

      it("answering the prompt settles the prompt user's escrow, not an agent job's", async function () {
        const { aiAgent, escrow, promptUser, jobUser, oracle, promptMessageId, answerMessageId } =
          await loadFixture(promptThenAgentJobsFixture);

        await aiAgent.connect(oracle).submitAnswer(promptMessageId, answerMessageId, CID_BUNDLE);

        expect((await escrow.escrows(answerMessageId)).status).to.equal(ESCROW_COMPLETE);
        expect(await escrow.pendingEscrowCount(promptUser.address)).to.equal(0n);
        expect(await escrow.pendingEscrowCount(jobUser.address)).to.equal(BigInt(AGENT_JOBS));
      });

      it("the job's user can cancel it, and nobody else can", async function () {
        const { aiAgent, escrow, promptUser, jobUser, triggerIds } = await loadFixture(
          promptThenAgentJobsFixture,
        );
        await time.increase(Number(await escrow.CANCELLATION_TIMEOUT()) + 1);

        await expect(
          escrow.connect(promptUser).cancelPrompt(triggerIds[0]),
        ).to.be.revertedWithCustomError(escrow, "NotPromptOwner");
        await expect(escrow.connect(jobUser).cancelPrompt(triggerIds[0]))
          .to.emit(aiAgent, "PromptCancelled")
          .withArgs(jobUser.address, triggerIds[0]);
        expect(await escrow.pendingEscrowCount(jobUser.address)).to.equal(BigInt(AGENT_JOBS - 1));
      });

      it("an oracle answer naming a trigger id settles that job's escrow and leaves the prompt answerable", async function () {
        // The oracle chooses the answer ID, so it can settle any pending escrow: that is the
        // trust placed in it, unchanged here. This pins exactly what such a call does.
        const { aiAgent, escrow, oracle, promptMessageId, answerMessageId, triggerIds } =
          await loadFixture(promptThenAgentJobsFixture);

        await aiAgent.connect(oracle).submitAnswer(promptMessageId, triggerIds[0], CID_BUNDLE);

        expect((await escrow.escrows(triggerIds[0])).status).to.equal(ESCROW_COMPLETE);
        expect(await aiAgent.isJobFinalized(answerMessageId)).to.equal(false);
        await expect(
          aiAgent.connect(oracle).submitAnswer(promptMessageId, answerMessageId, CID_BUNDLE),
        ).to.not.be.reverted;
      });

      it("a trigger id is not a prompt: the agent refuses an answer filed against it", async function () {
        const { aiAgent, oracle, triggerIds } = await loadFixture(promptThenAgentJobsFixture);
        await expect(
          aiAgent.connect(oracle).submitAnswer(triggerIds[0], triggerIds[1], CID_BUNDLE),
        ).to.be.revertedWithCustomError(aiAgent, "InvalidPromptMessageId");
      });

      it("refunding an agent job leaves the prompt open and answerable", async function () {
        const {
          aiAgent,
          escrow,
          promptUser,
          oracle,
          keeper,
          promptMessageId,
          answerMessageId,
          triggerIds,
        } = await loadFixture(promptThenAgentJobsFixture);
        // The prompt is past its own timeout as well, but only the agent jobs are refunded here.
        await time.increase(Number(await escrow.REFUND_TIMEOUT()) + 1);

        for (const triggerId of triggerIds) {
          await escrow.connect(keeper).processRefund(triggerId);
        }

        expect(await aiAgent.isJobFinalized(answerMessageId)).to.equal(false);
        expect((await escrow.escrows(answerMessageId)).user).to.equal(promptUser.address);
        await expect(
          aiAgent.connect(oracle).submitAnswer(promptMessageId, answerMessageId, CID_BUNDLE),
        ).to.not.be.reverted;
      });

      it("a message reserved after an agent job does not reuse its trigger id", async function () {
        const { aiAgent, escrow, promptUser, triggerIds } = await loadFixture(
          promptThenAgentJobsFixture,
        );
        const receipt = await (await chain.prompt(escrow, promptUser)).wait();
        const later = parseEvent(receipt, aiAgent, "PromptSubmitted").args;

        for (const triggerId of triggerIds) {
          expect(later.promptMessageId).to.not.equal(triggerId);
          expect(later.answerMessageId).to.not.equal(triggerId);
        }
      });
    });
  }
});
