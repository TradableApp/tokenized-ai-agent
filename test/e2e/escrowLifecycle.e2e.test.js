const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("E2E: Escrow Lifecycle", function () {
  const DOMAIN = "tradable.app";
  const INITIAL_MINT = ethers.parseEther("1000");
  const SPENDING_LIMIT = ethers.parseEther("500");
  const PROMPT_FEE = ethers.parseEther("10");
  const CANCELLATION_FEE = ethers.parseEther("1");
  const METADATA_FEE = ethers.parseEther("0.5");
  const BRANCH_FEE = ethers.parseEther("2");
  const MOCK_CID = "QmE2ETestCID000000000000000000000000000000000000";

  async function deployFullStackFixture() {
    const [deployer, user, oracle, treasury, keeper] = await ethers.getSigners();

    const MockTokenFactory = await ethers.getContractFactory("MockAbleToken");
    const token = await MockTokenFactory.deploy();
    await token.waitForDeployment();
    await token.mint(user.address, INITIAL_MINT);

    const EVMAIAgent = await ethers.getContractFactory("EVMAIAgent");
    const aiAgent = await upgrades.deployProxy(
      EVMAIAgent,
      [DOMAIN, oracle.address, deployer.address],
      { initializer: "initialize", kind: "uups" },
    );
    await aiAgent.waitForDeployment();

    const EVMAIAgentEscrow = await ethers.getContractFactory("EVMAIAgentEscrow");
    const escrow = await upgrades.deployProxy(
      EVMAIAgentEscrow,
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
    await token.connect(user).approve(await escrow.getAddress(), INITIAL_MINT);

    return { aiAgent, escrow, token, deployer, user, oracle, treasury, keeper };
  }

  function extractEventArgs(receipt, contractIface, eventName) {
    const topicHash = contractIface.getEvent(eventName).topicHash;
    const log = receipt.logs.find((l) => l.topics[0] === topicHash);
    if (!log) throw new Error(`${eventName} event not found in receipt`);
    return contractIface.parseLog(log).args;
  }

  const cidBundle = {
    conversationCID: MOCK_CID,
    metadataCID: MOCK_CID,
    promptMessageCID: MOCK_CID,
    answerMessageCID: MOCK_CID,
    searchDeltaCID: MOCK_CID,
  };

  describe("Happy Path: Prompt → Answer → Payment Released", function () {
    it("transfers tokens from user to escrow on prompt, then to treasury on answer", async function () {
      const { aiAgent, escrow, token, user, oracle, treasury } =
        await loadFixture(deployFullStackFixture);

      const expiresAt = (await time.latest()) + 7200;
      await escrow.connect(user).setSpendingLimit(SPENDING_LIMIT, expiresAt);

      const userBalBefore = await token.balanceOf(user.address);
      const treasuryBalBefore = await token.balanceOf(treasury.address);
      const escrowAddr = await escrow.getAddress();
      const escrowBalBefore = await token.balanceOf(escrowAddr);

      const tx = await escrow.connect(user).initiatePrompt(0, "0x1234", "0x5678");
      const receipt = await tx.wait();

      // Phase 1: tokens moved from user to escrow contract
      expect(await token.balanceOf(user.address)).to.equal(userBalBefore - PROMPT_FEE);
      expect(await token.balanceOf(escrowAddr)).to.equal(escrowBalBefore + PROMPT_FEE);
      expect(await escrow.pendingEscrowCount(user.address)).to.equal(1);

      const answerMessageId = extractEventArgs(receipt, escrow.interface, "PaymentEscrowed")[0];
      const promptMessageId = extractEventArgs(receipt, aiAgent.interface, "PromptSubmitted")[2];

      await aiAgent.connect(oracle).submitAnswer(promptMessageId, answerMessageId, cidBundle);

      // Phase 2: tokens moved from escrow to treasury, escrow contract balance restored
      expect(await token.balanceOf(treasury.address)).to.equal(treasuryBalBefore + PROMPT_FEE);
      expect(await token.balanceOf(escrowAddr)).to.equal(escrowBalBefore);
      expect(await escrow.pendingEscrowCount(user.address)).to.equal(0);
    });
  });

  describe("Cancellation Flow", function () {
    it("reverts when cancelled before CANCELLATION_TIMEOUT (3 seconds)", async function () {
      const { escrow, user } = await loadFixture(deployFullStackFixture);

      const expiresAt = (await time.latest()) + 7200;
      await escrow.connect(user).setSpendingLimit(SPENDING_LIMIT, expiresAt);

      const tx = await escrow.connect(user).initiatePrompt(0, "0x1234", "0x5678");
      const receipt = await tx.wait();
      const answerMessageId = extractEventArgs(receipt, escrow.interface, "PaymentEscrowed")[0];

      await expect(
        escrow.connect(user).cancelPrompt(answerMessageId),
      ).to.be.revertedWithCustomError(escrow, "PromptNotCancellableYet");
    });

    it("refunds prompt fee minus cancellation fee to user after timeout", async function () {
      const { aiAgent, escrow, token, user, treasury } =
        await loadFixture(deployFullStackFixture);

      const expiresAt = (await time.latest()) + 7200;
      await escrow.connect(user).setSpendingLimit(SPENDING_LIMIT, expiresAt);

      const userBalBefore = await token.balanceOf(user.address);
      const treasuryBalBefore = await token.balanceOf(treasury.address);

      const tx = await escrow.connect(user).initiatePrompt(0, "0x1234", "0x5678");
      const receipt = await tx.wait();
      const answerMessageId = extractEventArgs(receipt, escrow.interface, "PaymentEscrowed")[0];

      await time.increase(5);

      await expect(escrow.connect(user).cancelPrompt(answerMessageId))
        .to.emit(escrow, "PromptCancelled")
        .withArgs(user.address, answerMessageId);

      // User's net cost is exactly the cancellation fee
      expect(await token.balanceOf(user.address)).to.equal(userBalBefore - CANCELLATION_FEE);
      // Treasury received the cancellation fee
      expect(await token.balanceOf(treasury.address)).to.equal(
        treasuryBalBefore + CANCELLATION_FEE,
      );
      // Job is marked finalized on-chain
      expect(await aiAgent.isJobFinalized(answerMessageId)).to.be.true;
      expect(await escrow.pendingEscrowCount(user.address)).to.equal(0);
    });

    it("prevents oracle from answering a cancelled prompt", async function () {
      const { aiAgent, escrow, user, oracle } = await loadFixture(deployFullStackFixture);

      const expiresAt = (await time.latest()) + 7200;
      await escrow.connect(user).setSpendingLimit(SPENDING_LIMIT, expiresAt);

      const tx = await escrow.connect(user).initiatePrompt(0, "0x1234", "0x5678");
      const receipt = await tx.wait();
      const answerMessageId = extractEventArgs(receipt, escrow.interface, "PaymentEscrowed")[0];
      const promptMessageId = extractEventArgs(receipt, aiAgent.interface, "PromptSubmitted")[2];

      await time.increase(5);
      await escrow.connect(user).cancelPrompt(answerMessageId);

      await expect(
        aiAgent.connect(oracle).submitAnswer(promptMessageId, answerMessageId, cidBundle),
      ).to.be.revertedWithCustomError(aiAgent, "JobAlreadyFinalized");
    });

    it("prevents non-owner from cancelling another user's prompt", async function () {
      const { escrow, user, keeper } = await loadFixture(deployFullStackFixture);

      const expiresAt = (await time.latest()) + 7200;
      await escrow.connect(user).setSpendingLimit(SPENDING_LIMIT, expiresAt);

      const tx = await escrow.connect(user).initiatePrompt(0, "0x1234", "0x5678");
      const receipt = await tx.wait();
      const answerMessageId = extractEventArgs(receipt, escrow.interface, "PaymentEscrowed")[0];

      await time.increase(5);

      await expect(
        escrow.connect(keeper).cancelPrompt(answerMessageId),
      ).to.be.revertedWithCustomError(escrow, "NotPromptOwner");
    });
  });

  describe("Refund Flow (Keeper)", function () {
    it("reverts refund before REFUND_TIMEOUT (1 hour)", async function () {
      const { escrow, user, keeper } = await loadFixture(deployFullStackFixture);

      const expiresAt = (await time.latest()) + 7200;
      await escrow.connect(user).setSpendingLimit(SPENDING_LIMIT, expiresAt);

      const tx = await escrow.connect(user).initiatePrompt(0, "0x1234", "0x5678");
      const receipt = await tx.wait();
      const answerMessageId = extractEventArgs(receipt, escrow.interface, "PaymentEscrowed")[0];

      await time.increase(1800);

      await expect(
        escrow.connect(keeper).processRefund(answerMessageId),
      ).to.be.revertedWithCustomError(escrow, "PromptNotRefundableYet");
    });

    it("refunds full prompt fee to user after 1-hour timeout", async function () {
      const { escrow, token, user, keeper } = await loadFixture(deployFullStackFixture);

      const expiresAt = (await time.latest()) + 7200;
      await escrow.connect(user).setSpendingLimit(SPENDING_LIMIT, expiresAt);

      const userBalBefore = await token.balanceOf(user.address);

      const tx = await escrow.connect(user).initiatePrompt(0, "0x1234", "0x5678");
      const receipt = await tx.wait();
      const answerMessageId = extractEventArgs(receipt, escrow.interface, "PaymentEscrowed")[0];

      await time.increase(3601);

      await expect(escrow.connect(keeper).processRefund(answerMessageId))
        .to.emit(escrow, "PaymentRefunded")
        .withArgs(answerMessageId);

      // Full refund — no fee deducted
      expect(await token.balanceOf(user.address)).to.equal(userBalBefore);
      expect(await escrow.pendingEscrowCount(user.address)).to.equal(0);

      // Spending limit spentAmount is restored
      const limit = await escrow.spendingLimits(user.address);
      expect(limit.spentAmount).to.equal(0);
    });

    it("reverts on double refund", async function () {
      const { escrow, user, keeper } = await loadFixture(deployFullStackFixture);

      const expiresAt = (await time.latest()) + 7200;
      await escrow.connect(user).setSpendingLimit(SPENDING_LIMIT, expiresAt);

      const tx = await escrow.connect(user).initiatePrompt(0, "0x1234", "0x5678");
      const receipt = await tx.wait();
      const answerMessageId = extractEventArgs(receipt, escrow.interface, "PaymentEscrowed")[0];

      await time.increase(3601);
      await escrow.connect(keeper).processRefund(answerMessageId);

      await expect(
        escrow.connect(keeper).processRefund(answerMessageId),
      ).to.be.revertedWithCustomError(escrow, "EscrowNotPending");
    });
  });

  describe("Race Conditions", function () {
    it("oracle answer after refund timeout — answer wins if it lands first", async function () {
      const { aiAgent, escrow, token, user, oracle, treasury } =
        await loadFixture(deployFullStackFixture);

      const expiresAt = (await time.latest()) + 7200;
      await escrow.connect(user).setSpendingLimit(SPENDING_LIMIT, expiresAt);

      const tx = await escrow.connect(user).initiatePrompt(0, "0x1234", "0x5678");
      const receipt = await tx.wait();
      const answerMessageId = extractEventArgs(receipt, escrow.interface, "PaymentEscrowed")[0];
      const promptMessageId = extractEventArgs(receipt, aiAgent.interface, "PromptSubmitted")[2];

      await time.increase(3601);

      const treasuryBalBefore = await token.balanceOf(treasury.address);
      await aiAgent.connect(oracle).submitAnswer(promptMessageId, answerMessageId, cidBundle);

      expect(await token.balanceOf(treasury.address)).to.equal(treasuryBalBefore + PROMPT_FEE);

      // Refund now fails because escrow is already finalized
      await expect(
        escrow.processRefund(answerMessageId),
      ).to.be.revertedWithCustomError(escrow, "EscrowNotPending");
    });
  });

  describe("Branch Flow", function () {
    it("reserves a new conversation ID distinct from the original", async function () {
      const { aiAgent, escrow, user } = await loadFixture(deployFullStackFixture);

      const expiresAt = (await time.latest()) + 7200;
      await escrow.connect(user).setSpendingLimit(SPENDING_LIMIT, expiresAt);

      const tx1 = await escrow.connect(user).initiatePrompt(0, "0x1234", "0x5678");
      const receipt1 = await tx1.wait();
      const agentArgs = extractEventArgs(receipt1, aiAgent.interface, "PromptSubmitted");
      const conversationId = agentArgs[1];
      const promptMessageId = agentArgs[2];

      const branchTx = await escrow
        .connect(user)
        .initiateBranch(conversationId, promptMessageId, "0x1234", "0x5678");
      const branchReceipt = await branchTx.wait();

      const branchTopic = aiAgent.interface.getEvent("BranchRequested").topicHash;
      const branchLog = branchReceipt.logs.find((l) => l.topics[0] === branchTopic);
      expect(branchLog, "BranchRequested not emitted").to.not.be.undefined;

      const branchArgs = aiAgent.interface.parseLog(branchLog).args;
      expect(branchArgs.newConversationId).to.not.equal(conversationId);
    });
  });
});
