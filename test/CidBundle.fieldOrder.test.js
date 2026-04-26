const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("Suite 4 — CidBundle Field Order and Event Emission", function () {
  const domain = "example.com";
  const INITIAL_ALLOWANCE = ethers.parseEther("100");
  const PROMPT_FEE = ethers.parseEther("10");
  const CANCELLATION_FEE = ethers.parseEther("1");
  const METADATA_FEE = ethers.parseEther("0.5");
  const BRANCH_FEE = ethers.parseEther("2");

  const CID_A = "QmAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const CID_B = "QmBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  const CID_C = "QmCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
  const CID_D = "QmDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";
  const CID_E = "QmEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE";

  async function deployFixture() {
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

  async function initiateAndCapture(escrow, aiAgent, user) {
    const expiresAt = (await time.latest()) + 7200;
    const limitTx = await escrow.connect(user).setSpendingLimit(INITIAL_ALLOWANCE, expiresAt);
    await limitTx.wait();

    const tx = await escrow.connect(user).initiatePrompt(0, "0x", "0x");
    const receipt = await tx.wait();

    const escrowIface = escrow.interface;
    const agentIface = aiAgent.interface;

    const paymentEscrowedTopic = escrowIface.getEvent("PaymentEscrowed").topicHash;
    const promptSubmittedTopic = agentIface.getEvent("PromptSubmitted").topicHash;

    const escrowLog = receipt.logs.find((l) => l.topics[0] === paymentEscrowedTopic);
    const answerMessageId = escrowIface.parseLog(escrowLog).args[0];

    const agentLog = receipt.logs.find((l) => l.topics[0] === promptSubmittedTopic);
    const promptMessageId = agentIface.parseLog(agentLog).args[2];

    return { answerMessageId, promptMessageId };
  }

  describe("CidBundle struct field order", function () {
    it("CidBundle fields are: conversationCID, metadataCID, promptMessageCID, answerMessageCID, searchDeltaCID", async function () {
      const { aiAgent } = await loadFixture(deployFixture);

      const submitAnswerFragment = aiAgent.interface.getFunction("submitAnswer");
      const cidBundleParam = submitAnswerFragment.inputs[2];

      expect(cidBundleParam.name).to.equal("_cids");
      expect(cidBundleParam.components).to.have.length(5);

      expect(cidBundleParam.components[0].name).to.equal("conversationCID");
      expect(cidBundleParam.components[1].name).to.equal("metadataCID");
      expect(cidBundleParam.components[2].name).to.equal("promptMessageCID");
      expect(cidBundleParam.components[3].name).to.equal("answerMessageCID");
      expect(cidBundleParam.components[4].name).to.equal("searchDeltaCID");
    });
  });

  describe("Event emission per CID field", function () {
    it("all five non-empty CIDs emit their respective events", async function () {
      const { aiAgent, escrow, user, oracle } = await loadFixture(deployFixture);
      const { answerMessageId, promptMessageId } = await initiateAndCapture(escrow, aiAgent, user);

      const cidBundle = {
        conversationCID: CID_A,
        metadataCID: CID_B,
        promptMessageCID: CID_C,
        answerMessageCID: CID_D,
        searchDeltaCID: CID_E,
      };

      await expect(
        aiAgent.connect(oracle).submitAnswer(promptMessageId, answerMessageId, cidBundle),
      )
        .to.emit(aiAgent, "ConversationAdded")
        .and.to.emit(aiAgent, "PromptMessageAdded")
        .and.to.emit(aiAgent, "AnswerMessageAdded")
        .and.to.emit(aiAgent, "SearchIndexDeltaAdded");
    });

    it("empty conversationCID and metadataCID suppress ConversationAdded (subsequent prompt in same conversation)", async function () {
      const { aiAgent, escrow, user, oracle } = await loadFixture(deployFixture);
      const { answerMessageId, promptMessageId } = await initiateAndCapture(escrow, aiAgent, user);

      const cidBundle = {
        conversationCID: "",
        metadataCID: "",
        promptMessageCID: CID_C,
        answerMessageCID: CID_D,
        searchDeltaCID: CID_E,
      };

      const tx = await aiAgent
        .connect(oracle)
        .submitAnswer(promptMessageId, answerMessageId, cidBundle);
      const receipt = await tx.wait();

      const agentIface = aiAgent.interface;
      const conversationAddedTopic = agentIface.getEvent("ConversationAdded").topicHash;
      const conversationLog = receipt.logs.find((l) => l.topics[0] === conversationAddedTopic);
      expect(conversationLog).to.be.undefined;

      const promptMessageAddedTopic = agentIface.getEvent("PromptMessageAdded").topicHash;
      expect(receipt.logs.find((l) => l.topics[0] === promptMessageAddedTopic)).to.not.be.undefined;

      const answerMessageAddedTopic = agentIface.getEvent("AnswerMessageAdded").topicHash;
      expect(receipt.logs.find((l) => l.topics[0] === answerMessageAddedTopic)).to.not.be.undefined;
    });

    it("empty searchDeltaCID emits SearchIndexDeltaAdded with empty string when promptMessageCID is non-empty", async function () {
      const { aiAgent, escrow, user, oracle } = await loadFixture(deployFixture);
      const { answerMessageId, promptMessageId } = await initiateAndCapture(escrow, aiAgent, user);

      const cidBundle = {
        conversationCID: CID_A,
        metadataCID: CID_B,
        promptMessageCID: CID_C,
        answerMessageCID: CID_D,
        searchDeltaCID: "",
      };

      const tx = await aiAgent
        .connect(oracle)
        .submitAnswer(promptMessageId, answerMessageId, cidBundle);
      const receipt = await tx.wait();

      // SearchIndexDeltaAdded is emitted whenever promptMessageCID is non-empty;
      // an empty searchDeltaCID produces the event with an empty string value.
      const agentIface = aiAgent.interface;
      const searchDeltaTopic = agentIface.getEvent("SearchIndexDeltaAdded").topicHash;
      const searchLog = receipt.logs.find((l) => l.topics[0] === searchDeltaTopic);
      expect(searchLog).to.not.be.undefined;
      const parsed = agentIface.parseLog(searchLog);
      expect(parsed.args[1]).to.equal("", "searchDeltaCID arg should be empty string");
    });

    it("empty promptMessageCID suppresses PromptMessageAdded", async function () {
      const { aiAgent, escrow, user, oracle } = await loadFixture(deployFixture);
      const { answerMessageId, promptMessageId } = await initiateAndCapture(escrow, aiAgent, user);

      const cidBundle = {
        conversationCID: CID_A,
        metadataCID: CID_B,
        promptMessageCID: "",
        answerMessageCID: CID_D,
        searchDeltaCID: CID_E,
      };

      const tx = await aiAgent
        .connect(oracle)
        .submitAnswer(promptMessageId, answerMessageId, cidBundle);
      const receipt = await tx.wait();

      const agentIface = aiAgent.interface;
      const promptMessageAddedTopic = agentIface.getEvent("PromptMessageAdded").topicHash;
      expect(receipt.logs.find((l) => l.topics[0] === promptMessageAddedTopic)).to.be.undefined;
    });

    it("empty answerMessageCID reverts with AnswerCIDRequired (answer CID is mandatory)", async function () {
      const { aiAgent, escrow, user, oracle } = await loadFixture(deployFixture);
      const { answerMessageId, promptMessageId } = await initiateAndCapture(escrow, aiAgent, user);

      const cidBundle = {
        conversationCID: CID_A,
        metadataCID: CID_B,
        promptMessageCID: CID_C,
        answerMessageCID: "",
        searchDeltaCID: CID_E,
      };

      await expect(
        aiAgent.connect(oracle).submitAnswer(promptMessageId, answerMessageId, cidBundle),
      ).to.be.revertedWithCustomError(aiAgent, "AnswerCIDRequired");
    });
  });

  describe("ConversationAdded only on first prompt of a conversation", function () {
    it("ConversationAdded fires on first prompt; does not fire on subsequent prompt with empty conversationCID", async function () {
      const { aiAgent, escrow, user, oracle } = await loadFixture(deployFixture);
      const expiresAt = (await time.latest()) + 7200;
      await escrow.connect(user).setSpendingLimit(INITIAL_ALLOWANCE, expiresAt);

      // First prompt: new conversation (conversationId = 0 → auto-assigned)
      const tx1 = await escrow.connect(user).initiatePrompt(0, "0x", "0x");
      const receipt1 = await tx1.wait();

      const escrowIface = escrow.interface;
      const agentIface = aiAgent.interface;

      const escrowLog1 = receipt1.logs.find(
        (l) => l.topics[0] === escrowIface.getEvent("PaymentEscrowed").topicHash,
      );
      const answerMessageId1 = escrowIface.parseLog(escrowLog1).args[0];

      const agentLog1 = receipt1.logs.find(
        (l) => l.topics[0] === agentIface.getEvent("PromptSubmitted").topicHash,
      );
      const promptMessageId1 = agentIface.parseLog(agentLog1).args[2];
      const conversationId1 = agentIface.parseLog(agentLog1).args[1];

      const firstBundle = {
        conversationCID: CID_A,
        metadataCID: CID_B,
        promptMessageCID: CID_C,
        answerMessageCID: CID_D,
        searchDeltaCID: CID_E,
      };

      const submitTx1 = await aiAgent
        .connect(oracle)
        .submitAnswer(promptMessageId1, answerMessageId1, firstBundle);
      const submitReceipt1 = await submitTx1.wait();
      const conversationAddedTopic = agentIface.getEvent("ConversationAdded").topicHash;
      expect(submitReceipt1.logs.find((l) => l.topics[0] === conversationAddedTopic)).to.not.be
        .undefined;

      // Second prompt: same conversation, no conversationCID
      const tx2 = await escrow.connect(user).initiatePrompt(conversationId1, "0x", "0x");
      const receipt2 = await tx2.wait();

      const escrowLog2 = receipt2.logs.find(
        (l) => l.topics[0] === escrowIface.getEvent("PaymentEscrowed").topicHash,
      );
      const answerMessageId2 = escrowIface.parseLog(escrowLog2).args[0];

      const agentLog2 = receipt2.logs.find(
        (l) => l.topics[0] === agentIface.getEvent("PromptSubmitted").topicHash,
      );
      const promptMessageId2 = agentIface.parseLog(agentLog2).args[2];

      const subsequentBundle = {
        conversationCID: "",
        metadataCID: "",
        promptMessageCID: CID_C,
        answerMessageCID: CID_D,
        searchDeltaCID: CID_E,
      };

      const submitTx2 = await aiAgent
        .connect(oracle)
        .submitAnswer(promptMessageId2, answerMessageId2, subsequentBundle);
      const submitReceipt2 = await submitTx2.wait();
      expect(submitReceipt2.logs.find((l) => l.topics[0] === conversationAddedTopic)).to.be
        .undefined;
    });
  });

  describe("Only oracle can call submitAnswer", function () {
    it("reverts when a non-oracle account calls submitAnswer", async function () {
      const { aiAgent, escrow, user, deployer } = await loadFixture(deployFixture);
      const { answerMessageId, promptMessageId } = await initiateAndCapture(escrow, aiAgent, user);

      const cidBundle = {
        conversationCID: CID_A,
        metadataCID: CID_B,
        promptMessageCID: CID_C,
        answerMessageCID: CID_D,
        searchDeltaCID: CID_E,
      };

      await expect(
        aiAgent.connect(user).submitAnswer(promptMessageId, answerMessageId, cidBundle),
      ).to.be.revertedWithCustomError(aiAgent, "UnauthorizedOracle");
    });
  });
});
