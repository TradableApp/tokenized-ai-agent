const chai = require("chai");
const sinon = require("sinon");
const { expect } = chai;
const proxyquire = require("proxyquire");
const crypto = require("crypto");
const { ethers } = require("ethers");

describe("aiAgentOracle", function () {
  let aiAgentOracle;
  let stubs;
  const FAKE_SESSION_KEY = crypto.randomBytes(32);

  // Helper function to create the encrypted string format our app uses
  const createEncryptedString = (dataObject, key) => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.from(JSON.stringify(dataObject));
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    const tag = cipher.getAuthTag();
    const combined = Buffer.concat([encrypted, tag]);
    return `${iv.toString("base64")}.${combined.toString("base64")}`;
  };

  beforeEach(() => {
    // Define your mocked oracle components once. This makes them easy to reference.
    const mockedOracleComponents = {
      provider: {
        getNetwork: sinon.stub().resolves({ chainId: 1 }),
      },
      signer: { address: "0xOracleAddress" },
      contract: {
        target: "0xMockedContractAddress",
        submitAnswer: sinon.stub().resolves({ wait: () => Promise.resolve({ hash: "0xTxHash" }) }),
        submitBranch: sinon.stub().resolves({ wait: () => Promise.resolve({ hash: "0xTxHash" }) }),
        submitConversationMetadata: sinon
          .stub()
          .resolves({ wait: () => Promise.resolve({ hash: "0xTxHash" }) }),
      },
      isSapphire: false,
    };

    // Mock all external dependencies
    stubs = {
      "./storage/storage": {
        initializeStorage: sinon.stub().resolves(),
        uploadData: sinon.stub().callsFake((buffer, tags) => {
          const hash = crypto.createHash("sha256").update(buffer).digest("hex");
          return Promise.resolve(`fake_cid_${hash.substring(0, 10)}`);
        }),
        fetchData: sinon.stub().resolves(createEncryptedString({}, FAKE_SESSION_KEY)),
        queryTransactionByTags: sinon.stub().resolves(null),
      },
      "./contractUtility": {
        initializeOracle: sinon.stub().returns(mockedOracleComponents),
      },
      "./roflUtility": {
        submitTx: sinon.stub().resolves("0xRoflTxHash"),
      },
      "./alerting": {
        sendAlert: sinon.stub().resolves(),
      },
      "node-fetch": sinon.stub().resolves({
        ok: true,
        json: () => Promise.resolve({ message: { content: "Mocked AI Response" } }),
      }),
      "fs/promises": {
        writeFile: sinon.stub().resolves(),
        readFile: sinon.stub().rejects(new Error("File not found")),
      },
      "eth-crypto": {
        decryptWithPrivateKey: sinon.stub().resolves(FAKE_SESSION_KEY.toString("hex")),
        cipher: {
          parse: (str) => str,
        },
      },
    };

    // Use proxyquire to load the module with our mocks
    aiAgentOracle = proxyquire("../src/aiAgentOracle", stubs);

    // Initialize the module's internal state with our mocks before running any tests.
    aiAgentOracle.initForTest(mockedOracleComponents);
  });

  afterEach(() => {
    sinon.restore();
  });

  describe("getSessionKey", () => {
    it("should retrieve key from payload for EVM", async () => {
      // Arrange
      const roflEncryptedKey = "0xencryptedKey";
      // Act
      const key = await aiAgentOracle.getSessionKey(null, roflEncryptedKey, null);
      // Assert
      expect(
        stubs["eth-crypto"].decryptWithPrivateKey.calledOnceWith(sinon.match.any, "encryptedKey"),
      ).to.be.true;
      expect(key).to.deep.equal(FAKE_SESSION_KEY);
    });

    it("should retrieve key from payload for Sapphire", async () => {
      // For Sapphire, we need to re-stub the utility to say we are on Sapphire
      aiAgentOracle.initForTest({ isSapphire: true });

      const payload = JSON.stringify({ sessionKey: "0x" + FAKE_SESSION_KEY.toString("hex") });
      const key = await aiAgentOracle.getSessionKey(payload, null, null);
      expect(key).to.deep.equal(FAKE_SESSION_KEY);
    });

    it("should fall back to storage query if key is not in payload", async () => {
      const convId = "123";
      stubs["./storage/storage"].queryTransactionByTags.resolves("fake_key_cid");
      stubs["./storage/storage"].fetchData.resolves("0xRoflEncryptedKeyFromStorage");

      const key = await aiAgentOracle.getSessionKey(null, null, convId);

      // Assert that the fallback was used
      expect(stubs["./storage/storage"].queryTransactionByTags.calledOnce).to.be.true;
      const queryArgs = stubs["./storage/storage"].queryTransactionByTags.firstCall.args[0];
      expect(queryArgs).to.deep.include({
        name: "SenseAI-Key-For-Conversation",
        value: `1-${convId}`,
      });

      expect(stubs["./storage/storage"].fetchData.calledOnceWith("fake_key_cid")).to.be.true;
      expect(stubs["eth-crypto"].decryptWithPrivateKey.calledOnce).to.be.true;
      expect(key).to.deep.equal(FAKE_SESSION_KEY);
    });
  });

  describe("handlePrompt (EVM)", () => {
    it("should handle a new conversation correctly", async () => {
      const user = "0xUserAddress";
      const conversationId = 123;
      const promptMessageId = 456;
      const answerMessageId = 457;
      const roflEncryptedKey = "0xencryptedkey";

      const clientPayload = {
        promptText: "Hello world",
        isNewConversation: true,
        previousMessageId: null,
        previousMessageCID: null,
      };

      // Encrypt the payload as the frontend would
      const encryptedPayloadString = createEncryptedString(clientPayload, FAKE_SESSION_KEY);
      const payloadBytes = ethers.toUtf8Bytes(encryptedPayloadString);

      const fakeEvent = {
        blockNumber: 1,
        getBlock: () => Promise.resolve({ timestamp: Date.now() }),
      };

      // Call the handler
      await aiAgentOracle.handlePrompt(
        user,
        conversationId,
        promptMessageId,
        answerMessageId,
        payloadBytes,
        roflEncryptedKey,
        fakeEvent,
      );

      // --- Assertions ---
      // 1. Should upload 6 files for a new conversation (Key, Conv, Meta, Prompt, Search, Answer)
      expect(stubs["./storage/storage"].uploadData.callCount).to.equal(6);

      // 2. The key file should be uploaded with correct tags
      const keyUploadArgs = stubs["./storage/storage"].uploadData.getCall(0).args;
      expect(keyUploadArgs[1]).to.deep.include({
        name: "Content-Type",
        value: "application/rofl-key",
      });
      expect(keyUploadArgs[1]).to.deep.include({
        name: "SenseAI-Key-For-Conversation",
        value: `1-${conversationId}`,
      });

      const mockedContract = stubs["./contractUtility"].initializeOracle().contract;
      expect(mockedContract.submitAnswer.calledOnce).to.be.true;

      const cidBundle = mockedContract.submitAnswer.firstCall.args[2];
      expect(cidBundle.conversationCID).to.include("fake_cid_");
      expect(cidBundle.metadataCID).to.include("fake_cid_");
      expect(cidBundle.promptMessageCID).to.include("fake_cid_");
      expect(cidBundle.answerMessageCID).to.include("fake_cid_");
      expect(cidBundle.searchDeltaCID).to.include("fake_cid_");
    });

    it("should handle an existing conversation correctly (sequential uploads)", async () => {
      const user = "0xUserAddress";
      const conversationId = 123;
      const promptMessageId = 458;
      const answerMessageId = 459;
      const roflEncryptedKey = "0xencryptedkey";

      const clientPayload = {
        promptText: "Follow up question",
        isNewConversation: false,
        previousMessageId: "msg_457",
        previousMessageCID: "fake_cid_prev_answer",
      };

      const encryptedPayloadString = createEncryptedString(clientPayload, FAKE_SESSION_KEY);
      const payloadBytes = ethers.toUtf8Bytes(encryptedPayloadString);

      const fakeEvent = {
        blockNumber: 2,
        getBlock: () => Promise.resolve({ timestamp: Date.now() }),
      };

      await aiAgentOracle.handlePrompt(
        user,
        conversationId,
        promptMessageId,
        answerMessageId,
        payloadBytes,
        roflEncryptedKey,
        fakeEvent,
      );

      // 1. Should upload 3 files for an existing conversation (prompt, answer, searchDelta)
      expect(stubs["./storage/storage"].uploadData.callCount).to.equal(3);

      // 2. Should submit the final answer to the contract
      const mockedContract = stubs["./contractUtility"].initializeOracle().contract;
      expect(mockedContract.submitAnswer.calledOnce).to.be.true;

      const cidBundle = mockedContract.submitAnswer.firstCall.args[2];
      expect(cidBundle.conversationCID).to.equal("");
      expect(cidBundle.metadataCID).to.equal("");
      expect(cidBundle.promptMessageCID).to.include("fake_cid_");
      expect(cidBundle.answerMessageCID).to.include("fake_cid_");
      expect(cidBundle.searchDeltaCID).to.include("fake_cid_");
    });
  });

  describe("handlePrompt (Sapphire)", () => {
    let sapphireComponents;

    beforeEach(() => {
      sapphireComponents = {
        provider: { getNetwork: sinon.stub().resolves({ chainId: 1 }) },
        signer: { address: "0xOracleAddress" },
        contract: {
          target: "0xMockedContractAddress",
          submitAnswer: sinon
            .stub()
            .resolves({ wait: () => Promise.resolve({ hash: "0xTxHash" }) }),
        },
        isSapphire: true,
      };
      aiAgentOracle.initForTest(sapphireComponents);
    });

    it("should handle a new conversation on Sapphire correctly", async () => {
      const user = "0xUserAddress";
      const conversationId = 123;
      const promptMessageId = 456;
      const answerMessageId = 457;
      const clientPayload = {
        promptText: "Hello Sapphire",
        isNewConversation: true,
        previousMessageId: null,
        previousMessageCID: null,
        sessionKey: "0x" + FAKE_SESSION_KEY.toString("hex"),
        roflEncryptedKey: "0xEncryptedKeyForStorageOnSapphire",
      };
      const payloadString = JSON.stringify(clientPayload);
      const fakeEvent = {
        blockNumber: 1,
        getBlock: () => Promise.resolve({ timestamp: Date.now() }),
      };

      await aiAgentOracle.handlePrompt(
        user,
        conversationId,
        promptMessageId,
        answerMessageId,
        payloadString,
        null, // roflEncryptedKey is null for Sapphire, it's in the payload
        fakeEvent,
      );

      expect(stubs["./storage/storage"].uploadData.callCount).to.equal(6);

      const keyUploadArgs = stubs["./storage/storage"].uploadData.getCall(0).args;
      expect(keyUploadArgs[0].toString()).to.equal(clientPayload.roflEncryptedKey);

      // We can access the specific contract stub from our components object
      expect(sapphireComponents.contract.submitAnswer.calledOnce).to.be.true;

      // PARITY: Detailed check of the CID bundle
      const cidBundle = sapphireComponents.contract.submitAnswer.firstCall.args[2];
      expect(cidBundle.conversationCID).to.include("fake_cid_");
      expect(cidBundle.metadataCID).to.include("fake_cid_");
      expect(cidBundle.promptMessageCID).to.include("fake_cid_");
      expect(cidBundle.answerMessageCID).to.include("fake_cid_");
      expect(cidBundle.searchDeltaCID).to.include("fake_cid_");
    });

    it("should handle an existing conversation on Sapphire correctly", async () => {
      const user = "0xUserAddress";
      const conversationId = 123;
      const promptMessageId = 458;
      const answerMessageId = 459;
      const clientPayload = {
        promptText: "Follow up question",
        isNewConversation: false,
        previousMessageId: "msg_457",
        previousMessageCID: "fake_cid_prev_answer",
        sessionKey: "0x" + FAKE_SESSION_KEY.toString("hex"),
      };
      const payloadString = JSON.stringify(clientPayload);
      const fakeEvent = {
        blockNumber: 2,
        getBlock: () => Promise.resolve({ timestamp: Date.now() }),
      };

      await aiAgentOracle.handlePrompt(
        user,
        conversationId,
        promptMessageId,
        answerMessageId,
        payloadString,
        null,
        fakeEvent,
      );

      expect(stubs["./storage/storage"].uploadData.callCount).to.equal(3);
      expect(sapphireComponents.contract.submitAnswer.calledOnce).to.be.true;

      // PARITY: Detailed check of the sparse CID bundle
      const cidBundle = sapphireComponents.contract.submitAnswer.firstCall.args[2];
      expect(cidBundle.conversationCID).to.equal("");
      expect(cidBundle.metadataCID).to.equal("");
      expect(cidBundle.promptMessageCID).to.include("fake_cid_");
      expect(cidBundle.answerMessageCID).to.include("fake_cid_");
      expect(cidBundle.searchDeltaCID).to.include("fake_cid_");
    });
  });

  describe("Other Handlers", () => {
    it("should handle a regeneration request", async () => {
      const user = "0xUser";
      const conversationId = 123;
      const promptMessageId = 456;
      const originalAnswerMessageId = 457;
      const newAnswerMessageId = 458;
      const roflEncryptedKey = "0xkey";
      const clientPayload = {
        instructions: "Make it shorter",
        promptMessageCID: "fake_cid_prompt",
        originalAnswerMessageCID: "fake_cid_prev_answer",
      };
      const payloadBytes = ethers.toUtf8Bytes(
        createEncryptedString(clientPayload, FAKE_SESSION_KEY),
      );
      const fakeEvent = {
        blockNumber: 3,
        getBlock: () => Promise.resolve({ timestamp: Date.now() }),
      };

      await aiAgentOracle.handleRegeneration(
        user,
        conversationId,
        promptMessageId,
        originalAnswerMessageId,
        newAnswerMessageId,
        payloadBytes,
        roflEncryptedKey,
        fakeEvent,
      );

      expect(stubs["./storage/storage"].fetchData.calledOnceWith("fake_cid_prev_answer")).to.be
        .true;
      expect(stubs["./storage/storage"].uploadData.callCount).to.equal(1);

      const submitAnswerStub = stubs["./contractUtility"].initializeOracle().contract.submitAnswer;
      expect(submitAnswerStub.calledOnce).to.be.true;
      // UPGRADE: Deconstruct args for specific checks.
      const [submittedPromptId, submittedAnswerId, cidBundle] = submitAnswerStub.firstCall.args;
      expect(submittedPromptId).to.equal(promptMessageId);
      expect(submittedAnswerId).to.equal(newAnswerMessageId);
      expect(cidBundle.answerMessageCID).to.include("fake_cid_");
      expect(cidBundle.promptMessageCID).to.equal("");
      expect(cidBundle.conversationCID).to.equal("");
    });

    it("should handle a branch request", async () => {
      const user = "0xUser";
      const originalConversationId = 123;
      const branchPointMessageId = 457;
      const newConversationId = 124;
      const roflEncryptedKey = "0xkey";
      const clientPayload = { originalTitle: "My Conversation" };
      const payloadBytes = ethers.toUtf8Bytes(
        createEncryptedString(clientPayload, FAKE_SESSION_KEY),
      );
      const fakeEvent = {
        blockNumber: 4,
        getBlock: () => Promise.resolve({ timestamp: Date.now() }),
      };

      await aiAgentOracle.handleBranch(
        user,
        originalConversationId,
        branchPointMessageId,
        newConversationId,
        payloadBytes,
        roflEncryptedKey,
        fakeEvent,
      );

      expect(stubs["./storage/storage"].uploadData.callCount).to.equal(3);
      const submitBranchStub = stubs["./contractUtility"].initializeOracle().contract.submitBranch;
      expect(submitBranchStub.calledOnce).to.be.true;
      const [subUser, subOrigId, subMsgId, subNewId, convCID, metaCID] =
        submitBranchStub.firstCall.args;
      expect(subUser).to.equal(user);
      expect(subNewId).to.equal(newConversationId);
      expect(convCID).to.include("fake_cid_");
      expect(metaCID).to.include("fake_cid_");
    });
  });

  describe("Error Handling", () => {
    it("should add a job to the retry queue if a retryable error occurs", async () => {
      // Arrange
      stubs["./storage/storage"].uploadData.rejects(new Error("Irys is down"));
      const writeFileStub = stubs["fs/promises"].writeFile;
      const clientPayload = { promptText: "This will fail", isNewConversation: true };
      const payloadBytes = ethers.toUtf8Bytes(
        createEncryptedString(clientPayload, FAKE_SESSION_KEY),
      );
      const fakeEvent = {
        blockNumber: 100,
        transactionHash: "0xhash",
        args: ["0xUser", 123, 456, 457, payloadBytes, "0xkey"],
        getBlock: () => Promise.resolve({ timestamp: Date.now() }),
      };

      // Act
      await aiAgentOracle.handleAndRecord(
        "PromptSubmitted",
        aiAgentOracle.handlePrompt,
        ...fakeEvent.args,
        fakeEvent,
      );

      // Assert
      expect(stubs["./contractUtility"].initializeOracle().contract.submitAnswer.called).to.be
        .false;
      // UPGRADE: A retryable error should NOT trigger a critical alert.
      expect(stubs["./alerting"].sendAlert.called).to.be.false;

      const failedJobsCall = writeFileStub
        .getCalls()
        .find((call) => call.args[0].includes("failed-jobs.json"));
      expect(failedJobsCall).to.not.be.undefined;
      const jobQueue = JSON.parse(failedJobsCall.args[1]);
      expect(jobQueue).to.have.lengthOf(1);
      expect(jobQueue[0].eventName).to.equal("PromptSubmitted");

      const stateFileCall = writeFileStub
        .getCalls()
        .find((call) => call.args[0].includes("oracle-state.json"));
      expect(stateFileCall).to.not.be.undefined;
    });
  });

  describe("reconstructHistory", () => {
    it("should walk the parentCID chain correctly", async () => {
      // --- Setup the mock chain of messages ---
      const msg3 = {
        id: "msg_3",
        role: "assistant",
        content: "Response 2",
        parentId: "msg_2",
        parentCID: "cid_2",
      };
      const msg2 = {
        id: "msg_2",
        role: "user",
        content: "Prompt 2",
        parentId: "msg_1",
        parentCID: "cid_1",
      };
      const msg1 = {
        id: "msg_1",
        role: "assistant",
        content: "Response 1",
        parentId: null,
        parentCID: null,
      };

      // Fake the encrypted versions
      const encryptedMsg3 = createEncryptedString(msg3, FAKE_SESSION_KEY);
      const encryptedMsg2 = createEncryptedString(msg2, FAKE_SESSION_KEY);
      const encryptedMsg1 = createEncryptedString(msg1, FAKE_SESSION_KEY);

      // Configure the fetchData stub to return the correct message for each CID
      stubs["./storage/storage"].fetchData
        .withArgs("cid_3")
        .resolves(encryptedMsg3)
        .withArgs("cid_2")
        .resolves(encryptedMsg2)
        .withArgs("cid_1")
        .resolves(encryptedMsg1);

      const history = await aiAgentOracle.reconstructHistory("cid_3", FAKE_SESSION_KEY);

      // --- Assertions ---
      // 1. History should have 3 items
      expect(history).to.have.lengthOf(3);

      // 2. History should be in the correct chronological order
      expect(history[0]).to.deep.equal({ role: msg1.role, content: msg1.content });
      expect(history[1]).to.deep.equal({ role: msg2.role, content: msg2.content });
      expect(history[2]).to.deep.equal({ role: msg3.role, content: msg3.content });
    });
  });
});
