const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("E2E: Contract Deployment & Cross-Contract Interaction", function () {
  const DOMAIN = "tradable.app";
  const INITIAL_MINT = ethers.parseEther("1000");
  const SPENDING_LIMIT = ethers.parseEther("500");
  const PROMPT_FEE = ethers.parseEther("10");
  const CANCELLATION_FEE = ethers.parseEther("1");
  const METADATA_FEE = ethers.parseEther("0.5");
  const BRANCH_FEE = ethers.parseEther("2");
  const MOCK_CID = "QmE2ETestCID000000000000000000000000000000000000";

  async function deployFullStackFixture() {
    const [deployer, user, oracle, treasury, keeper, unauthorizedUser] =
      await ethers.getSigners();

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

    return { aiAgent, escrow, token, deployer, user, oracle, treasury, keeper, unauthorizedUser };
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

  describe("Deployment Verification", function () {
    it("deploys all contracts with correct cross-contract wiring", async function () {
      const { aiAgent, escrow, token, oracle, treasury } =
        await loadFixture(deployFullStackFixture);

      expect(await aiAgent.oracle()).to.equal(oracle.address);
      expect(await escrow.ableToken()).to.equal(await token.getAddress());
      expect(await escrow.evmAIAgent()).to.equal(await aiAgent.getAddress());
      expect(await escrow.treasury()).to.equal(treasury.address);
      expect(await aiAgent.aiAgentEscrow()).to.equal(await escrow.getAddress());
    });

    it("sets all fee tiers correctly", async function () {
      const { escrow } = await loadFixture(deployFullStackFixture);

      expect(await escrow.promptFee()).to.equal(PROMPT_FEE);
      expect(await escrow.cancellationFee()).to.equal(CANCELLATION_FEE);
      expect(await escrow.metadataUpdateFee()).to.equal(METADATA_FEE);
      expect(await escrow.branchFee()).to.equal(BRANCH_FEE);
    });

    it("user has correct token balance and escrow allowance after setup", async function () {
      const { escrow, token, user } = await loadFixture(deployFullStackFixture);

      expect(await token.balanceOf(user.address)).to.equal(INITIAL_MINT);
      expect(await token.allowance(user.address, await escrow.getAddress())).to.equal(INITIAL_MINT);
    });
  });

  describe("Full Prompt → Answer Lifecycle", function () {
    it("completes token approval → spending limit → prompt → answer → payment finalized", async function () {
      const { aiAgent, escrow, token, user, oracle, treasury } =
        await loadFixture(deployFullStackFixture);

      const expiresAt = (await time.latest()) + 7200;
      await escrow.connect(user).setSpendingLimit(SPENDING_LIMIT, expiresAt);

      const limit = await escrow.spendingLimits(user.address);
      expect(limit.allowance).to.equal(SPENDING_LIMIT);
      expect(limit.spentAmount).to.equal(0);

      const treasuryBalBefore = await token.balanceOf(treasury.address);
      const initTx = await escrow.connect(user).initiatePrompt(0, "0x1234", "0x5678");
      const receipt = await initTx.wait();

      const escrowArgs = extractEventArgs(receipt, escrow.interface, "PaymentEscrowed");
      const answerMessageId = escrowArgs[0];
      expect(escrowArgs[2]).to.equal(PROMPT_FEE, "PaymentEscrowed amount must match promptFee");

      const agentArgs = extractEventArgs(receipt, aiAgent.interface, "PromptSubmitted");
      const promptMessageId = agentArgs[2];
      const emittedAnswerMessageId = agentArgs[3];
      expect(answerMessageId).to.equal(emittedAnswerMessageId);

      // On-chain state: spending limit spentAmount updated, pending count incremented
      const limitAfterPrompt = await escrow.spendingLimits(user.address);
      expect(limitAfterPrompt.spentAmount).to.equal(PROMPT_FEE);
      expect(await escrow.pendingEscrowCount(user.address)).to.equal(1);

      await expect(
        aiAgent.connect(oracle).submitAnswer(promptMessageId, answerMessageId, cidBundle),
      )
        .to.emit(escrow, "PaymentFinalized")
        .withArgs(answerMessageId)
        .and.to.emit(aiAgent, "AnswerMessageAdded");

      expect(await aiAgent.isJobFinalized(answerMessageId)).to.be.true;
      expect(await escrow.pendingEscrowCount(user.address)).to.equal(0);
      expect(await token.balanceOf(treasury.address)).to.equal(treasuryBalBefore + PROMPT_FEE);
    });

    it("handles multiple sequential prompts with unique IDs and independent finalization", async function () {
      const { aiAgent, escrow, user, oracle } = await loadFixture(deployFullStackFixture);

      const expiresAt = (await time.latest()) + 7200;
      await escrow.connect(user).setSpendingLimit(SPENDING_LIMIT, expiresAt);

      const answerIds = [];
      const promptIds = [];

      for (let i = 0; i < 3; i++) {
        const tx = await escrow.connect(user).initiatePrompt(0, "0x1234", "0x5678");
        const receipt = await tx.wait();

        const escrowParsed = extractEventArgs(receipt, escrow.interface, "PaymentEscrowed");
        answerIds.push(escrowParsed[0]);

        const agentParsed = extractEventArgs(receipt, aiAgent.interface, "PromptSubmitted");
        promptIds.push(agentParsed[2]);
      }

      const uniqueAnswerIds = new Set(answerIds.map((id) => id.toString()));
      const uniquePromptIds = new Set(promptIds.map((id) => id.toString()));
      expect(uniqueAnswerIds.size).to.equal(3);
      expect(uniquePromptIds.size).to.equal(3);

      expect(await escrow.pendingEscrowCount(user.address)).to.equal(3);

      // Answer out of order to verify independent finalization
      await aiAgent.connect(oracle).submitAnswer(promptIds[2], answerIds[2], cidBundle);
      expect(await aiAgent.isJobFinalized(answerIds[2])).to.be.true;
      expect(await aiAgent.isJobFinalized(answerIds[0])).to.be.false;

      await aiAgent.connect(oracle).submitAnswer(promptIds[0], answerIds[0], cidBundle);
      await aiAgent.connect(oracle).submitAnswer(promptIds[1], answerIds[1], cidBundle);

      for (const id of answerIds) {
        expect(await aiAgent.isJobFinalized(id)).to.be.true;
      }
      expect(await escrow.pendingEscrowCount(user.address)).to.equal(0);
    });
  });

  describe("Double-Spend Prevention", function () {
    it("reverts when oracle tries to answer an already-answered prompt", async function () {
      const { aiAgent, escrow, user, oracle } = await loadFixture(deployFullStackFixture);

      const expiresAt = (await time.latest()) + 7200;
      await escrow.connect(user).setSpendingLimit(SPENDING_LIMIT, expiresAt);

      const tx = await escrow.connect(user).initiatePrompt(0, "0x1234", "0x5678");
      const receipt = await tx.wait();
      const answerMessageId = extractEventArgs(receipt, escrow.interface, "PaymentEscrowed")[0];
      const promptMessageId = extractEventArgs(receipt, aiAgent.interface, "PromptSubmitted")[2];

      await aiAgent.connect(oracle).submitAnswer(promptMessageId, answerMessageId, cidBundle);

      await expect(
        aiAgent.connect(oracle).submitAnswer(promptMessageId, answerMessageId, cidBundle),
      ).to.be.revertedWithCustomError(aiAgent, "JobAlreadyFinalized");
    });
  });

  describe("Spending Limit Enforcement", function () {
    it("rejects prompt when limit is below fee", async function () {
      const { escrow, user } = await loadFixture(deployFullStackFixture);

      const smallLimit = PROMPT_FEE - 1n;
      const expiresAt = (await time.latest()) + 7200;
      await escrow.connect(user).setSpendingLimit(smallLimit, expiresAt);

      await expect(
        escrow.connect(user).initiatePrompt(0, "0x1234", "0x5678"),
      ).to.be.revertedWithCustomError(escrow, "InsufficientSpendingLimitAllowance");
    });

    it("accepts prompt when limit exactly equals fee", async function () {
      const { escrow, user } = await loadFixture(deployFullStackFixture);

      const exactLimit = PROMPT_FEE;
      const expiresAt = (await time.latest()) + 7200;
      await escrow.connect(user).setSpendingLimit(exactLimit, expiresAt);

      await expect(escrow.connect(user).initiatePrompt(0, "0x1234", "0x5678")).to.not.be.reverted;
    });

    it("tracks cumulative spent amount and rejects at exhaustion", async function () {
      const { escrow, user } = await loadFixture(deployFullStackFixture);

      const limitForTwo = PROMPT_FEE * 2n;
      const expiresAt = (await time.latest()) + 7200;
      await escrow.connect(user).setSpendingLimit(limitForTwo, expiresAt);

      await escrow.connect(user).initiatePrompt(0, "0x1234", "0x5678");
      const limitMid = await escrow.spendingLimits(user.address);
      expect(limitMid.spentAmount).to.equal(PROMPT_FEE);

      await escrow.connect(user).initiatePrompt(0, "0x1234", "0x5678");
      const limitFull = await escrow.spendingLimits(user.address);
      expect(limitFull.spentAmount).to.equal(PROMPT_FEE * 2n);

      await expect(
        escrow.connect(user).initiatePrompt(0, "0x1234", "0x5678"),
      ).to.be.revertedWithCustomError(escrow, "InsufficientSpendingLimitAllowance");
    });

    it("rejects prompt without any spending limit set", async function () {
      const { escrow, user } = await loadFixture(deployFullStackFixture);

      await expect(
        escrow.connect(user).initiatePrompt(0, "0x1234", "0x5678"),
      ).to.be.revertedWithCustomError(escrow, "NoActiveSpendingLimit");
    });
  });

  describe("Access Control", function () {
    it("only oracle can submit answers", async function () {
      const { aiAgent, escrow, user, unauthorizedUser } =
        await loadFixture(deployFullStackFixture);

      const expiresAt = (await time.latest()) + 7200;
      await escrow.connect(user).setSpendingLimit(SPENDING_LIMIT, expiresAt);

      const tx = await escrow.connect(user).initiatePrompt(0, "0x1234", "0x5678");
      const receipt = await tx.wait();
      const answerMessageId = extractEventArgs(receipt, escrow.interface, "PaymentEscrowed")[0];
      const promptMessageId = extractEventArgs(receipt, aiAgent.interface, "PromptSubmitted")[2];

      await expect(
        aiAgent.connect(unauthorizedUser).submitAnswer(promptMessageId, answerMessageId, cidBundle),
      ).to.be.revertedWithCustomError(aiAgent, "UnauthorizedOracle");
    });
  });
});
