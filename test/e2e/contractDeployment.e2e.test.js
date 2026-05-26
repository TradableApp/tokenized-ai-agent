const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

/**
 * E2E: Contract Deployment & Cross-Contract Interaction
 *
 * Deploys all EVM contracts to local Hardhat, wires them together,
 * and verifies the full interaction chain:
 *   token approval → spending limit → escrow deposit → prompt submission → answer delivery
 */
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

  describe("Deployment Verification", function () {
    it("deploys all contracts with correct wiring", async function () {
      const { aiAgent, escrow, token, oracle, treasury } =
        await loadFixture(deployFullStackFixture);

      expect(await aiAgent.oracle()).to.equal(oracle.address);
      expect(await escrow.ableToken()).to.equal(await token.getAddress());
      expect(await escrow.evmAIAgent()).to.equal(await aiAgent.getAddress());
      expect(await escrow.treasury()).to.equal(treasury.address);
      expect(await aiAgent.aiAgentEscrow()).to.equal(await escrow.getAddress());
    });

    it("sets correct fee configuration", async function () {
      const { escrow } = await loadFixture(deployFullStackFixture);

      expect(await escrow.promptFee()).to.equal(PROMPT_FEE);
      expect(await escrow.cancellationFee()).to.equal(CANCELLATION_FEE);
      expect(await escrow.metadataUpdateFee()).to.equal(METADATA_FEE);
      expect(await escrow.branchFee()).to.equal(BRANCH_FEE);
    });

    it("user has correct token balance and allowance", async function () {
      const { escrow, token, user } = await loadFixture(deployFullStackFixture);

      expect(await token.balanceOf(user.address)).to.equal(INITIAL_MINT);
      expect(await token.allowance(user.address, await escrow.getAddress())).to.equal(INITIAL_MINT);
    });
  });

  describe("Full Prompt → Answer Lifecycle", function () {
    it("completes token approval → spending limit → prompt → answer → payment finalized", async function () {
      const { aiAgent, escrow, token, user, oracle, treasury } =
        await loadFixture(deployFullStackFixture);

      // 1. Set spending limit
      const expiresAt = (await time.latest()) + 7200;
      await escrow.connect(user).setSpendingLimit(SPENDING_LIMIT, expiresAt);

      const limit = await escrow.spendingLimits(user.address);
      expect(limit.allowance).to.equal(SPENDING_LIMIT);

      // 2. Submit prompt via escrow → emits PaymentEscrowed + PromptSubmitted
      const treasuryBalBefore = await token.balanceOf(treasury.address);
      const initTx = await escrow.connect(user).initiatePrompt(0, "0x1234", "0x5678");
      const receipt = await initTx.wait();

      // Extract answerMessageId from PaymentEscrowed
      const escrowIface = escrow.interface;
      const paymentEscrowedTopic = escrowIface.getEvent("PaymentEscrowed").topicHash;
      const escrowLog = receipt.logs.find((l) => l.topics[0] === paymentEscrowedTopic);
      expect(escrowLog, "PaymentEscrowed event not emitted").to.not.be.undefined;
      const escrowParsed = escrowIface.parseLog(escrowLog);
      const answerMessageId = escrowParsed.args[0];

      // Extract promptMessageId from PromptSubmitted
      const agentIface = aiAgent.interface;
      const promptSubmittedTopic = agentIface.getEvent("PromptSubmitted").topicHash;
      const agentLog = receipt.logs.find((l) => l.topics[0] === promptSubmittedTopic);
      expect(agentLog, "PromptSubmitted event not emitted").to.not.be.undefined;
      const agentParsed = agentIface.parseLog(agentLog);
      const promptMessageId = agentParsed.args[2];
      const emittedAnswerMessageId = agentParsed.args[3];

      expect(answerMessageId).to.equal(emittedAnswerMessageId);

      // 3. Oracle submits answer with CID bundle
      const cidBundle = {
        conversationCID: MOCK_CID,
        metadataCID: MOCK_CID,
        promptMessageCID: MOCK_CID,
        answerMessageCID: MOCK_CID,
        searchDeltaCID: MOCK_CID,
      };

      await expect(
        aiAgent.connect(oracle).submitAnswer(promptMessageId, answerMessageId, cidBundle),
      )
        .to.emit(escrow, "PaymentFinalized")
        .withArgs(answerMessageId)
        .and.to.emit(aiAgent, "AnswerMessageAdded");

      // 4. Verify finalization
      expect(await aiAgent.isJobFinalized(answerMessageId)).to.be.true;

      // 5. Verify treasury received payment
      const treasuryBalAfter = await token.balanceOf(treasury.address);
      expect(treasuryBalAfter - treasuryBalBefore).to.equal(PROMPT_FEE);
    });

    it("handles multiple sequential prompts with unique answerMessageIds", async function () {
      const { aiAgent, escrow, user, oracle } = await loadFixture(deployFullStackFixture);

      const expiresAt = (await time.latest()) + 7200;
      await escrow.connect(user).setSpendingLimit(SPENDING_LIMIT, expiresAt);

      const answerIds = [];
      const promptIds = [];

      for (let i = 0; i < 3; i++) {
        const tx = await escrow.connect(user).initiatePrompt(0, "0x1234", "0x5678");
        const receipt = await tx.wait();

        const escrowIface = escrow.interface;
        const paymentEscrowedTopic = escrowIface.getEvent("PaymentEscrowed").topicHash;
        const escrowLog = receipt.logs.find((l) => l.topics[0] === paymentEscrowedTopic);
        const escrowParsed = escrowIface.parseLog(escrowLog);
        answerIds.push(escrowParsed.args[0]);

        const agentIface = aiAgent.interface;
        const promptSubmittedTopic = agentIface.getEvent("PromptSubmitted").topicHash;
        const agentLog = receipt.logs.find((l) => l.topics[0] === promptSubmittedTopic);
        const agentParsed = agentIface.parseLog(agentLog);
        promptIds.push(agentParsed.args[2]);
      }

      // All IDs must be unique
      const uniqueAnswerIds = new Set(answerIds.map((id) => id.toString()));
      const uniquePromptIds = new Set(promptIds.map((id) => id.toString()));
      expect(uniqueAnswerIds.size).to.equal(3);
      expect(uniquePromptIds.size).to.equal(3);

      // Answer each in order
      const cidBundle = {
        conversationCID: MOCK_CID,
        metadataCID: MOCK_CID,
        promptMessageCID: MOCK_CID,
        answerMessageCID: MOCK_CID,
        searchDeltaCID: MOCK_CID,
      };

      for (let i = 0; i < 3; i++) {
        await aiAgent.connect(oracle).submitAnswer(promptIds[i], answerIds[i], cidBundle);
        expect(await aiAgent.isJobFinalized(answerIds[i])).to.be.true;
      }
    });
  });

  describe("Spending Limit Enforcement", function () {
    it("prevents prompt submission exceeding spending limit", async function () {
      const { escrow, user } = await loadFixture(deployFullStackFixture);

      const smallLimit = PROMPT_FEE - 1n;
      const expiresAt = (await time.latest()) + 7200;
      await escrow.connect(user).setSpendingLimit(smallLimit, expiresAt);

      await expect(
        escrow.connect(user).initiatePrompt(0, "0x1234", "0x5678"),
      ).to.be.revertedWithCustomError(escrow, "InsufficientSpendingLimitAllowance");
    });

    it("tracks spent amount across multiple prompts", async function () {
      const { escrow, user } = await loadFixture(deployFullStackFixture);

      const limitForTwo = PROMPT_FEE * 2n;
      const expiresAt = (await time.latest()) + 7200;
      await escrow.connect(user).setSpendingLimit(limitForTwo, expiresAt);

      await escrow.connect(user).initiatePrompt(0, "0x1234", "0x5678");
      await escrow.connect(user).initiatePrompt(0, "0x1234", "0x5678");

      await expect(
        escrow.connect(user).initiatePrompt(0, "0x1234", "0x5678"),
      ).to.be.revertedWithCustomError(escrow, "InsufficientSpendingLimitAllowance");
    });
  });
});
