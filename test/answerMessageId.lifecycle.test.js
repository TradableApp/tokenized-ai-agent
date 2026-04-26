const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("Suite 2 — answerMessageId as Universal Linking Key", function () {
  const domain = "example.com";
  const INITIAL_ALLOWANCE = ethers.parseEther("100");
  const PROMPT_FEE = ethers.parseEther("10");
  const CANCELLATION_FEE = ethers.parseEther("1");
  const METADATA_FEE = ethers.parseEther("0.5");
  const BRANCH_FEE = ethers.parseEther("2");
  const MOCK_CID = "QmXg9j4f8zYf8t7f8zYf8t7f8zYf8t7f8zYf8t7f8zYf8t7";

  // Deploy both real contracts wired together (no mocks).
  async function deployFullFixture() {
    const [deployer, user, oracle, treasury] = await ethers.getSigners();

    const MockTokenFactory = await ethers.getContractFactory("MockAbleToken");
    const token = await MockTokenFactory.deploy();
    await token.waitForDeployment();
    await token.mint(user.address, INITIAL_ALLOWANCE);

    const EVMAIAgent = await ethers.getContractFactory("EVMAIAgent");
    const aiAgent = await upgrades.deployProxy(
      EVMAIAgent,
      [domain, oracle.address, deployer.address],
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
    await token.connect(user).approve(await escrow.getAddress(), INITIAL_ALLOWANCE);

    return { aiAgent, escrow, token, deployer, user, oracle, treasury };
  }

  describe("answerMessageId links PaymentEscrowed → PromptSubmitted", function () {
    it("answerMessageId from PaymentEscrowed equals param[3] of PromptSubmitted", async function () {
      const { aiAgent, escrow, user } = await loadFixture(deployFullFixture);
      const expiresAt = (await time.latest()) + 3600;
      await escrow.connect(user).setSpendingLimit(INITIAL_ALLOWANCE, expiresAt);

      const tx = await escrow.connect(user).initiatePrompt(0, "0x", "0x");
      const receipt = await tx.wait();

      // Extract answerMessageId from PaymentEscrowed (escrow contract)
      const escrowIface = escrow.interface;
      const paymentEscrowedTopic = escrowIface.getEvent("PaymentEscrowed").topicHash;
      const escrowLog = receipt.logs.find((l) => l.topics[0] === paymentEscrowedTopic);
      expect(escrowLog, "PaymentEscrowed not found").to.not.be.undefined;
      const escrowParsed = escrowIface.parseLog(escrowLog);
      const escrowedAnswerMessageId = escrowParsed.args[0]; // escrowId == answerMessageId

      // Extract answerMessageId from PromptSubmitted (agent contract)
      const agentIface = aiAgent.interface;
      const promptSubmittedTopic = agentIface.getEvent("PromptSubmitted").topicHash;
      const agentLog = receipt.logs.find((l) => l.topics[0] === promptSubmittedTopic);
      expect(agentLog, "PromptSubmitted not found").to.not.be.undefined;
      const agentParsed = agentIface.parseLog(agentLog);
      const submittedAnswerMessageId = agentParsed.args[3]; // non-indexed param[3]

      expect(escrowedAnswerMessageId).to.equal(
        submittedAnswerMessageId,
        "answerMessageId must be the same in PaymentEscrowed (escrowId) and PromptSubmitted (param[3])",
      );
    });
  });

  describe("Full prompt lifecycle using answerMessageId as the key", function () {
    it("answerMessageId flows through initiatePrompt → submitAnswer → PaymentFinalized", async function () {
      const { aiAgent, escrow, user, oracle } = await loadFixture(deployFullFixture);
      const expiresAt = (await time.latest()) + 3600;
      await escrow.connect(user).setSpendingLimit(INITIAL_ALLOWANCE, expiresAt);

      // Step 1: initiate prompt — captures answerMessageId
      const initTx = await escrow.connect(user).initiatePrompt(0, "0x", "0x");
      const initReceipt = await initTx.wait();

      const escrowIface = escrow.interface;
      const paymentEscrowedTopic = escrowIface.getEvent("PaymentEscrowed").topicHash;
      const escrowLog = initReceipt.logs.find((l) => l.topics[0] === paymentEscrowedTopic);
      const escrowParsed = escrowIface.parseLog(escrowLog);
      const answerMessageId = escrowParsed.args[0];

      // Retrieve promptMessageId from PromptSubmitted
      const agentIface = aiAgent.interface;
      const promptSubmittedTopic = agentIface.getEvent("PromptSubmitted").topicHash;
      const agentLog = initReceipt.logs.find((l) => l.topics[0] === promptSubmittedTopic);
      const agentParsed = agentIface.parseLog(agentLog);
      const promptMessageId = agentParsed.args[2]; // indexed param[2]

      // Step 2: oracle submits answer using the same answerMessageId
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

      // Step 3: verify escrow job is finalized using that answerMessageId
      expect(await aiAgent.isJobFinalized(answerMessageId)).to.be.true;
    });

    it("answerMessageId flows through initiatePrompt → cancelPrompt → PromptCancelled on both contracts", async function () {
      const { aiAgent, escrow, user } = await loadFixture(deployFullFixture);
      const expiresAt = (await time.latest()) + 7200;
      await escrow.connect(user).setSpendingLimit(INITIAL_ALLOWANCE, expiresAt);

      const initTx = await escrow.connect(user).initiatePrompt(0, "0x", "0x");
      const initReceipt = await initTx.wait();

      const escrowIface = escrow.interface;
      const paymentEscrowedTopic = escrowIface.getEvent("PaymentEscrowed").topicHash;
      const escrowLog = initReceipt.logs.find((l) => l.topics[0] === paymentEscrowedTopic);
      const escrowParsed = escrowIface.parseLog(escrowLog);
      const answerMessageId = escrowParsed.args[0];

      // Wait past cancellation timeout
      await time.increase(5);

      const agentIface = aiAgent.interface;

      await expect(escrow.connect(user).cancelPrompt(answerMessageId))
        .to.emit(escrow, "PromptCancelled")
        .withArgs(user.address, answerMessageId)
        .and.to.emit(aiAgent, "PromptCancelled")
        .withArgs(user.address, answerMessageId);

      // answerMessageId is now finalized in the agent (cancelled = finalized)
      expect(await aiAgent.isJobFinalized(answerMessageId)).to.be.true;
    });
  });

  describe("Multiple prompts — answerMessageId uniqueness", function () {
    it("each prompt gets a distinct answerMessageId that tracks independently", async function () {
      const { aiAgent, escrow, user, oracle } = await loadFixture(deployFullFixture);
      const expiresAt = (await time.latest()) + 7200;
      await escrow.connect(user).setSpendingLimit(INITIAL_ALLOWANCE, expiresAt);

      // First prompt
      const tx1 = await escrow.connect(user).initiatePrompt(0, "0x", "0x");
      const receipt1 = await tx1.wait();
      const escrowIface = escrow.interface;
      const agentIface = aiAgent.interface;
      const paymentEscrowedTopic = escrowIface.getEvent("PaymentEscrowed").topicHash;
      const promptSubmittedTopic = agentIface.getEvent("PromptSubmitted").topicHash;

      const escrowLog1 = receipt1.logs.find((l) => l.topics[0] === paymentEscrowedTopic);
      const answerMessageId1 = escrowIface.parseLog(escrowLog1).args[0];
      const agentLog1 = receipt1.logs.find((l) => l.topics[0] === promptSubmittedTopic);
      const promptMessageId1 = agentIface.parseLog(agentLog1).args[2];

      // Submit first answer to free up the spending limit for a second prompt
      const cidBundle = {
        conversationCID: MOCK_CID,
        metadataCID: MOCK_CID,
        promptMessageCID: MOCK_CID,
        answerMessageCID: MOCK_CID,
        searchDeltaCID: MOCK_CID,
      };
      await aiAgent.connect(oracle).submitAnswer(promptMessageId1, answerMessageId1, cidBundle);

      // Second prompt — use existing conversationId (already owned by user)
      const conversationId1 = agentIface.parseLog(agentLog1).args[1];
      const tx2 = await escrow.connect(user).initiatePrompt(conversationId1, "0x", "0x");
      const receipt2 = await tx2.wait();

      const escrowLog2 = receipt2.logs.find((l) => l.topics[0] === paymentEscrowedTopic);
      const answerMessageId2 = escrowIface.parseLog(escrowLog2).args[0];
      const agentLog2 = receipt2.logs.find((l) => l.topics[0] === promptSubmittedTopic);
      const promptMessageId2 = agentIface.parseLog(agentLog2).args[2];

      expect(answerMessageId1).to.not.equal(answerMessageId2, "answerMessageIds must be unique");
      expect(promptMessageId1).to.not.equal(promptMessageId2, "promptMessageIds must be unique");

      // First is finalized; second is not
      expect(await aiAgent.isJobFinalized(answerMessageId1)).to.be.true;
      expect(await aiAgent.isJobFinalized(answerMessageId2)).to.be.false;

      // Finalize second
      const subsequentBundle = {
        conversationCID: "",
        metadataCID: "",
        promptMessageCID: MOCK_CID,
        answerMessageCID: MOCK_CID,
        searchDeltaCID: MOCK_CID,
      };
      await aiAgent
        .connect(oracle)
        .submitAnswer(promptMessageId2, answerMessageId2, subsequentBundle);
      expect(await aiAgent.isJobFinalized(answerMessageId2)).to.be.true;
    });
  });

  describe("UUPS upgradeability preserved in full deployment", function () {
    it("agent retains state after upgrade with no answerMessageId corruption", async function () {
      const { aiAgent, escrow, user, oracle, deployer } = await loadFixture(deployFullFixture);
      const expiresAt = (await time.latest()) + 3600;
      await escrow.connect(user).setSpendingLimit(INITIAL_ALLOWANCE, expiresAt);

      const initTx = await escrow.connect(user).initiatePrompt(0, "0x", "0x");
      const initReceipt = await initTx.wait();

      const escrowIface = escrow.interface;
      const paymentEscrowedTopic = escrowIface.getEvent("PaymentEscrowed").topicHash;
      const escrowLog = initReceipt.logs.find((l) => l.topics[0] === paymentEscrowedTopic);
      const answerMessageId = escrowIface.parseLog(escrowLog).args[0];

      // Upgrade agent
      const V2Factory = await ethers.getContractFactory("EVMAIAgentV2");
      const upgradedAgent = await upgrades.upgradeProxy(await aiAgent.getAddress(), V2Factory, {
        signer: deployer,
      });
      expect(await upgradedAgent.version()).to.equal("2.0");

      // answerMessageId is still not finalized after upgrade
      expect(await upgradedAgent.isJobFinalized(answerMessageId)).to.be.false;
    });

    it("escrow retains state after upgrade with no escrowId corruption", async function () {
      const { escrow, user, deployer } = await loadFixture(deployFullFixture);
      const expiresAt = (await time.latest()) + 3600;
      await escrow.connect(user).setSpendingLimit(INITIAL_ALLOWANCE, expiresAt);
      await escrow.connect(user).initiatePrompt(0, "0x", "0x");

      const V2Factory = await ethers.getContractFactory("EVMAIAgentEscrowV2");
      const upgradedEscrow = await upgrades.upgradeProxy(await escrow.getAddress(), V2Factory, {
        signer: deployer,
      });
      expect(await upgradedEscrow.version()).to.equal("2.0");

      // Spending limit state survives upgrade
      const limit = await upgradedEscrow.spendingLimits(user.address);
      expect(limit.allowance).to.equal(INITIAL_ALLOWANCE);
      expect(limit.spentAmount).to.equal(PROMPT_FEE);
    });
  });
});
