const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

/**
 * The regeneration lock is released by every way a regeneration can end.
 *
 * `submitRegenerationRequest` locks the prompt (`isRegenerationPending`) so two regenerations of
 * one prompt cannot run at once. An answer released the lock; a cancellation or a timeout refund
 * did not, because the agent was told only the regeneration's answer id and had no way back to
 * the prompt it locked. The prompt could then never be regenerated again.
 */
describe("Regeneration lock — released however the regeneration ends", function () {
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
  // A regeneration answer carries no prompt CID; that is how the agent tells the two apart.
  const REGENERATION_BUNDLE = { ...CID_BUNDLE, conversationCID: "", promptMessageCID: "" };

  const parseEvent = (receipt, contract, name) => {
    const topic = contract.interface.getEvent(name).topicHash;
    const log = receipt.logs.find((l) => l.topics[0] === topic);
    if (!log) throw new Error(`${name} not found in the receipt — recompile?`);
    return contract.interface.parseLog(log);
  };

  // Each chain supplies deploy + the two calls whose signatures differ; the cases are shared.
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
    },
  };

  for (const [chainName, chain] of Object.entries(chains)) {
    describe(chainName, function () {
      // An answered prompt with one regeneration in flight.
      async function pendingRegenerationFixture() {
        const deployed = await chain.deploy();
        const { aiAgent, escrow, user, oracle } = deployed;

        const promptReceipt = await (await chain.prompt(escrow, user)).wait();
        const { conversationId, promptMessageId, answerMessageId } = parseEvent(
          promptReceipt,
          aiAgent,
          "PromptSubmitted",
        ).args;
        await aiAgent.connect(oracle).submitAnswer(promptMessageId, answerMessageId, CID_BUNDLE);

        const regenerate = () =>
          chain.regenerate(escrow, user, conversationId, promptMessageId, answerMessageId);
        const regenReceipt = await (await regenerate()).wait();
        const regenAnswerId = parseEvent(regenReceipt, escrow, "PaymentEscrowed").args[0];

        return { ...deployed, promptMessageId, regenAnswerId, regenerate };
      }

      it("holds the lock while the regeneration is pending", async function () {
        const { aiAgent, promptMessageId, regenerate } = await loadFixture(
          pendingRegenerationFixture,
        );
        expect(await aiAgent.isRegenerationPending(promptMessageId)).to.equal(true);
        await expect(regenerate()).to.be.revertedWithCustomError(
          aiAgent,
          "RegenerationAlreadyPending",
        );
      });

      it("releases the lock when the regeneration is answered", async function () {
        const { aiAgent, oracle, promptMessageId, regenAnswerId, regenerate } = await loadFixture(
          pendingRegenerationFixture,
        );

        await aiAgent
          .connect(oracle)
          .submitAnswer(promptMessageId, regenAnswerId, REGENERATION_BUNDLE);

        expect(await aiAgent.isRegenerationPending(promptMessageId)).to.equal(false);
        await expect(regenerate()).to.not.be.reverted;
      });

      it("releases the lock when the regeneration is cancelled", async function () {
        const { aiAgent, escrow, user, promptMessageId, regenAnswerId, regenerate } =
          await loadFixture(pendingRegenerationFixture);
        await time.increase(Number(await escrow.CANCELLATION_TIMEOUT()) + 1);

        await escrow.connect(user).cancelPrompt(regenAnswerId);

        expect(await aiAgent.isRegenerationPending(promptMessageId)).to.equal(false);
        await expect(regenerate()).to.not.be.reverted;
      });

      it("releases the lock when the regeneration is refunded on timeout", async function () {
        const { aiAgent, escrow, keeper, promptMessageId, regenAnswerId, regenerate } =
          await loadFixture(pendingRegenerationFixture);
        await time.increase(Number(await escrow.REFUND_TIMEOUT()) + 1);

        await escrow.connect(keeper).processRefund(regenAnswerId);

        expect(await aiAgent.isRegenerationPending(promptMessageId)).to.equal(false);
        await expect(regenerate()).to.not.be.reverted;
      });

      // A second answered prompt in the same conversation, with its own regeneration in flight.
      async function twoPendingRegenerationsFixture() {
        const first = await pendingRegenerationFixture();
        const { aiAgent, escrow, user, oracle } = first;
        const receipt = await (await chain.prompt(escrow, user)).wait();
        const second = parseEvent(receipt, aiAgent, "PromptSubmitted").args;
        await aiAgent
          .connect(oracle)
          .submitAnswer(second.promptMessageId, second.answerMessageId, CID_BUNDLE);
        const regenReceipt = await (
          await chain.regenerate(
            escrow,
            user,
            second.conversationId,
            second.promptMessageId,
            second.answerMessageId,
          )
        ).wait();
        return {
          ...first,
          otherPromptId: second.promptMessageId,
          otherRegenAnswerId: parseEvent(regenReceipt, escrow, "PaymentEscrowed").args[0],
        };
      }

      it("cancelling one regeneration leaves another prompt's regeneration locked", async function () {
        const { aiAgent, escrow, user, promptMessageId, regenAnswerId, otherPromptId } =
          await loadFixture(twoPendingRegenerationsFixture);
        await time.increase(Number(await escrow.CANCELLATION_TIMEOUT()) + 1);

        await escrow.connect(user).cancelPrompt(regenAnswerId);

        expect(await aiAgent.isRegenerationPending(promptMessageId)).to.equal(false);
        expect(await aiAgent.isRegenerationPending(otherPromptId)).to.equal(true);
      });

      it("an answer releases the prompt its regeneration locked, whatever prompt id the oracle names", async function () {
        // The lock belongs to the answer id. An answer filed against the wrong prompt must not
        // unlock that other prompt while its own regeneration is still running.
        const { aiAgent, oracle, promptMessageId, regenAnswerId, otherPromptId } =
          await loadFixture(twoPendingRegenerationsFixture);

        await aiAgent
          .connect(oracle)
          .submitAnswer(otherPromptId, regenAnswerId, REGENERATION_BUNDLE);

        expect(await aiAgent.isRegenerationPending(promptMessageId)).to.equal(false);
        expect(await aiAgent.isRegenerationPending(otherPromptId)).to.equal(true);
      });

      it("cancelling an ordinary prompt leaves another prompt's regeneration lock alone", async function () {
        const { aiAgent, escrow, user, promptMessageId } = await loadFixture(
          pendingRegenerationFixture,
        );
        const receipt = await (await chain.prompt(escrow, user)).wait();
        const otherAnswerId = parseEvent(receipt, escrow, "PaymentEscrowed").args[0];
        await time.increase(Number(await escrow.CANCELLATION_TIMEOUT()) + 1);

        await escrow.connect(user).cancelPrompt(otherAnswerId);

        expect(await aiAgent.isRegenerationPending(promptMessageId)).to.equal(true);
      });
    });
  }
});
