const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

/**
 * E2E: Escrow Lifecycle — Payment, Cancellation, and Refund flows
 *
 * Tests the complete escrow payment lifecycle:
 *   - Happy path: prompt → answer → payment released to treasury
 *   - Cancellation: prompt → wait past timeout → cancel → refund minus fee
 *   - Refund: prompt → no answer → wait past refund timeout → full refund
 */
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

  describe("Happy Path: Prompt → Answer → Payment Released", function () {
    it("escrows tokens on prompt and releases to treasury on answer", async function () {
      const { aiAgent, escrow, token, user, oracle, treasury } =
        await loadFixture(deployFullStackFixture);

      const expiresAt = (await time.latest()) + 7200;
      await escrow.connect(user).setSpendingLimit(SPENDING_LIMIT, expiresAt);

      const userBalBefore = await token.balanceOf(user.address);
      const treasuryBalBefore = await token.balanceOf(treasury.address);
      const escrowBalBefore = await token.balanceOf(await escrow.getAddress());

      // Submit prompt
      const tx = await escrow.connect(user).initiatePrompt(0, "0x1234", "0x5678");
      const receipt = await tx.wait();

      // Tokens moved from user to escrow contract
      expect(await token.balanceOf(user.address)).to.equal(userBalBefore - PROMPT_FEE);
      expect(await token.balanceOf(await escrow.getAddress())).to.equal(
        escrowBalBefore + PROMPT_FEE,
      );

      // Extract IDs
      const escrowArgs = extractEventArgs(receipt, escrow.interface, "PaymentEscrowed");
      const answerMessageId = escrowArgs[0];

      const agentArgs = extractEventArgs(receipt, aiAgent.interface, "PromptSubmitted");
      const promptMessageId = agentArgs[2];

      // Oracle answers
      const cidBundle = {
        conversationCID: MOCK_CID,
        metadataCID: MOCK_CID,
        promptMessageCID: MOCK_CID,
        answerMessageCID: MOCK_CID,
        searchDeltaCID: MOCK_CID,
      };
      await aiAgent.connect(oracle).submitAnswer(promptMessageId, answerMessageId, cidBundle);

      // Tokens moved from escrow to treasury
      expect(await token.balanceOf(treasury.address)).to.equal(treasuryBalBefore + PROMPT_FEE);
      expect(await token.balanceOf(await escrow.getAddress())).to.equal(escrowBalBefore);
    });
  });

  describe("Cancellation Flow", function () {
    it("reverts cancellation before timeout", async function () {
      const { escrow, user } = await loadFixture(deployFullStackFixture);

      const expiresAt = (await time.latest()) + 7200;
      await escrow.connect(user).setSpendingLimit(SPENDING_LIMIT, expiresAt);

      const tx = await escrow.connect(user).initiatePrompt(0, "0x1234", "0x5678");
      const receipt = await tx.wait();
      const escrowArgs = extractEventArgs(receipt, escrow.interface, "PaymentEscrowed");
      const answerMessageId = escrowArgs[0];

      // Immediate cancel should fail (within 3-second CANCELLATION_TIMEOUT)
      await expect(
        escrow.connect(user).cancelPrompt(answerMessageId),
      ).to.be.revertedWithCustomError(escrow, "PromptNotCancellableYet");
    });

    it("cancels prompt after timeout and deducts cancellation fee", async function () {
      const { aiAgent, escrow, token, user, treasury } =
        await loadFixture(deployFullStackFixture);

      const expiresAt = (await time.latest()) + 7200;
      await escrow.connect(user).setSpendingLimit(SPENDING_LIMIT, expiresAt);

      const userBalBefore = await token.balanceOf(user.address);

      const tx = await escrow.connect(user).initiatePrompt(0, "0x1234", "0x5678");
      const receipt = await tx.wait();
      const escrowArgs = extractEventArgs(receipt, escrow.interface, "PaymentEscrowed");
      const answerMessageId = escrowArgs[0];

      // Wait past cancellation timeout (3 seconds)
      await time.increase(5);

      await expect(escrow.connect(user).cancelPrompt(answerMessageId))
        .to.emit(escrow, "PromptCancelled")
        .withArgs(user.address, answerMessageId);

      // User gets back (promptFee - cancellationFee)
      const expectedRefund = PROMPT_FEE - CANCELLATION_FEE;
      expect(await token.balanceOf(user.address)).to.equal(userBalBefore - CANCELLATION_FEE);

      // Cancellation fee goes to treasury
      expect(await token.balanceOf(treasury.address)).to.equal(CANCELLATION_FEE);

      // Job is finalized (can't be answered or cancelled again)
      expect(await aiAgent.isJobFinalized(answerMessageId)).to.be.true;
    });

    it("prevents oracle from answering a cancelled prompt", async function () {
      const { aiAgent, escrow, user, oracle } = await loadFixture(deployFullStackFixture);

      const expiresAt = (await time.latest()) + 7200;
      await escrow.connect(user).setSpendingLimit(SPENDING_LIMIT, expiresAt);

      const tx = await escrow.connect(user).initiatePrompt(0, "0x1234", "0x5678");
      const receipt = await tx.wait();
      const escrowArgs = extractEventArgs(receipt, escrow.interface, "PaymentEscrowed");
      const answerMessageId = escrowArgs[0];
      const agentArgs = extractEventArgs(receipt, aiAgent.interface, "PromptSubmitted");
      const promptMessageId = agentArgs[2];

      await time.increase(5);
      await escrow.connect(user).cancelPrompt(answerMessageId);

      const cidBundle = {
        conversationCID: MOCK_CID,
        metadataCID: MOCK_CID,
        promptMessageCID: MOCK_CID,
        answerMessageCID: MOCK_CID,
        searchDeltaCID: MOCK_CID,
      };

      await expect(
        aiAgent.connect(oracle).submitAnswer(promptMessageId, answerMessageId, cidBundle),
      ).to.be.revertedWithCustomError(aiAgent, "JobAlreadyFinalized");
    });
  });

  describe("Refund Flow (Keeper)", function () {
    it("reverts refund before refund timeout (1 hour)", async function () {
      const { escrow, user, keeper } = await loadFixture(deployFullStackFixture);

      const expiresAt = (await time.latest()) + 7200;
      await escrow.connect(user).setSpendingLimit(SPENDING_LIMIT, expiresAt);

      const tx = await escrow.connect(user).initiatePrompt(0, "0x1234", "0x5678");
      const receipt = await tx.wait();
      const escrowArgs = extractEventArgs(receipt, escrow.interface, "PaymentEscrowed");
      const answerMessageId = escrowArgs[0];

      // 30 minutes — not yet refundable
      await time.increase(1800);

      await expect(
        escrow.connect(keeper).processRefund(answerMessageId),
      ).to.be.revertedWithCustomError(escrow, "PromptNotRefundableYet");
    });

    it("refunds full amount after 1-hour timeout", async function () {
      const { escrow, token, user, keeper } = await loadFixture(deployFullStackFixture);

      const expiresAt = (await time.latest()) + 7200;
      await escrow.connect(user).setSpendingLimit(SPENDING_LIMIT, expiresAt);

      const userBalBefore = await token.balanceOf(user.address);

      const tx = await escrow.connect(user).initiatePrompt(0, "0x1234", "0x5678");
      const receipt = await tx.wait();
      const escrowArgs = extractEventArgs(receipt, escrow.interface, "PaymentEscrowed");
      const answerMessageId = escrowArgs[0];

      // Wait past refund timeout (1 hour)
      await time.increase(3601);

      await expect(escrow.connect(keeper).processRefund(answerMessageId))
        .to.emit(escrow, "PaymentRefunded")
        .withArgs(answerMessageId);

      // User gets full refund
      expect(await token.balanceOf(user.address)).to.equal(userBalBefore);
    });

    it("prevents double refund", async function () {
      const { escrow, user, keeper } = await loadFixture(deployFullStackFixture);

      const expiresAt = (await time.latest()) + 7200;
      await escrow.connect(user).setSpendingLimit(SPENDING_LIMIT, expiresAt);

      const tx = await escrow.connect(user).initiatePrompt(0, "0x1234", "0x5678");
      const receipt = await tx.wait();
      const escrowArgs = extractEventArgs(receipt, escrow.interface, "PaymentEscrowed");
      const answerMessageId = escrowArgs[0];

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
      const escrowArgs = extractEventArgs(receipt, escrow.interface, "PaymentEscrowed");
      const answerMessageId = escrowArgs[0];
      const agentArgs = extractEventArgs(receipt, aiAgent.interface, "PromptSubmitted");
      const promptMessageId = agentArgs[2];

      // Past refund timeout, but oracle answers first
      await time.increase(3601);

      const cidBundle = {
        conversationCID: MOCK_CID,
        metadataCID: MOCK_CID,
        promptMessageCID: MOCK_CID,
        answerMessageCID: MOCK_CID,
        searchDeltaCID: MOCK_CID,
      };

      const treasuryBalBefore = await token.balanceOf(treasury.address);
      await aiAgent.connect(oracle).submitAnswer(promptMessageId, answerMessageId, cidBundle);

      // Payment goes to treasury (answer wins)
      expect(await token.balanceOf(treasury.address)).to.equal(treasuryBalBefore + PROMPT_FEE);

      // Refund now fails (already finalized)
      await expect(
        escrow.processRefund(answerMessageId),
      ).to.be.revertedWithCustomError(escrow, "EscrowNotPending");
    });
  });

  describe("Branch Flow", function () {
    it("branches a conversation and creates new conversation ID", async function () {
      const { aiAgent, escrow, user } = await loadFixture(deployFullStackFixture);

      const expiresAt = (await time.latest()) + 7200;
      await escrow.connect(user).setSpendingLimit(SPENDING_LIMIT, expiresAt);

      // First: create a conversation with a prompt
      const tx1 = await escrow.connect(user).initiatePrompt(0, "0x1234", "0x5678");
      const receipt1 = await tx1.wait();
      const agentArgs = extractEventArgs(receipt1, aiAgent.interface, "PromptSubmitted");
      const conversationId = agentArgs[1];
      const promptMessageId = agentArgs[2];

      // Branch from this conversation
      const branchTx = await escrow
        .connect(user)
        .initiateBranch(conversationId, promptMessageId, "0x1234", "0x5678");
      const branchReceipt = await branchTx.wait();

      const branchTopic = aiAgent.interface.getEvent("BranchRequested").topicHash;
      const branchLog = branchReceipt.logs.find((l) => l.topics[0] === branchTopic);
      expect(branchLog, "BranchRequested not emitted").to.not.be.undefined;

      const branchArgs = aiAgent.interface.parseLog(branchLog).args;
      const newConversationId = branchArgs.newConversationId;

      // New conversation ID should be different from the original
      expect(newConversationId).to.not.equal(conversationId);
    });
  });
});
