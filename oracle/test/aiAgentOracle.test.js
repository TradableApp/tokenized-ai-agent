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

  // Helper function to create the encrypted string format our app uses.
  const createEncryptedString = (dataObject, key) => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.from(JSON.stringify(dataObject));
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    const tag = cipher.getAuthTag();
    const combined = Buffer.concat([encrypted, tag]);
    return `${iv.toString("base64")}.${combined.toString("base64")}`;
  };

  // Helper to decrypt test data for assertions.
  const decryptSymmetrically = (encryptedString, key) => {
    const parts = encryptedString.split(".");
    const iv = Buffer.from(parts[0], "base64");
    const combinedBuffer = Buffer.from(parts[1], "base64");
    const authTag = combinedBuffer.slice(-16);
    const encryptedData = combinedBuffer.slice(0, -16);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
    return JSON.parse(decrypted.toString("utf-8"));
  };

  beforeEach(() => {
    // Define mocked oracle components once for easy reference across tests.
    const mockedOracleComponents = {
      provider: {
        getNetwork: sinon.stub().resolves({ chainId: 1 }),
        getTransactionReceipt: sinon.stub(),
        getBlock: sinon.stub(),
        getBlockNumber: sinon.stub().resolves(10000), // Default latest block
      },
      signer: { address: "0xOracleAddress" },
      contract: {
        target: "0xMockedContractAddress",
        submitAnswer: sinon.stub().resolves({ wait: () => Promise.resolve({ hash: "0xTxHash" }) }),
        submitBranch: sinon.stub().resolves({ wait: () => Promise.resolve({ hash: "0xTxHash" }) }),
        submitConversationMetadata: sinon
          .stub()
          .resolves({ wait: () => Promise.resolve({ hash: "0xTxHash" }) }),
        oracle: sinon.stub(),
        setOracle: sinon.stub().resolves({ wait: () => Promise.resolve() }),
        queryFilter: sinon.stub(),
        // Add stub for event listener attachment, required by start().
        on: sinon.stub(),
        // Mocked filters are needed for processPastEvents to query specific event types.
        filters: {
          PromptSubmitted: sinon.stub(),
          RegenerationRequested: sinon.stub(),
          BranchRequested: sinon.stub(),
          MetadataUpdateRequested: sinon.stub(),
        },
        // The interface is needed for retryFailedJobs to parse logs from receipts.
        interface: {
          parseLog: sinon.stub(),
        },
      },
      isSapphire: false,
    };

    // Prevent the terminal from hanging after tests by stubbing the global setInterval.
    sinon.stub(global, "setInterval");

    // Mock all external dependencies using a stubs object.
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
        text: () => Promise.resolve("Mocked AI Response"),
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

    // Use proxyquire to load the module with our mocks.
    aiAgentOracle = proxyquire("../src/aiAgentOracle", stubs);

    // Initialize the module's internal state with our mocks before running any tests.
    aiAgentOracle.initForTest(mockedOracleComponents);
  });

  afterEach(() => {
    sinon.restore();
    delete process.env.AI_PROVIDER;
  });

  describe("start", () => {
    beforeEach(() => {
      // The start function calls setOracleAddress and processPastEvents, which need these stubs.
      stubs["./contractUtility"].initializeOracle().contract.oracle.resolves("0xOracleAddress");
      stubs["./contractUtility"].initializeOracle().contract.queryFilter.resolves([]);
    });

    it("should start from a recent block if no state file exists", async () => {
      // Setup: No state file, latest block is 10000.
      stubs["fs/promises"].readFile
        .withArgs(sinon.match(/oracle-state\.json$/))
        .rejects(new Error("File not found"));
      const mockedProvider = stubs["./contractUtility"].initializeOracle().provider;
      mockedProvider.getBlockNumber.resolves(10000);
      const queryFilterStub = stubs["./contractUtility"].initializeOracle().contract.queryFilter;

      await aiAgentOracle.start();

      // Assert: processPastEvents was called with the correct lookback window (4000 to 10000).
      // We verify this by checking the arguments of its dependency, queryFilter.
      expect(queryFilterStub.firstCall.args[1]).to.equal(4000);
      expect(queryFilterStub.firstCall.args[2]).to.equal(10000);
    });

    it("should start from the last processed block if a state file exists", async () => {
      // Setup: State file exists, latest block is 10000.
      stubs["fs/promises"].readFile
        .withArgs(sinon.match(/oracle-state\.json$/))
        .resolves(JSON.stringify({ lastProcessedBlock: 8500 }));
      const mockedProvider = stubs["./contractUtility"].initializeOracle().provider;
      mockedProvider.getBlockNumber.resolves(10000);
      const queryFilterStub = stubs["./contractUtility"].initializeOracle().contract.queryFilter;

      await aiAgentOracle.start();

      // Assert: It should start from the block *after* the one in the state file (8501 to 10000).
      expect(queryFilterStub.firstCall.args[1]).to.equal(8501);
      expect(queryFilterStub.firstCall.args[2]).to.equal(10000);
    });
  });

  describe("queryAIModel Dispatcher", () => {
    // Define clear, named constants for test arguments
    const FAKE_USER_ADDRESS = "0xUser";
    const FAKE_CONVERSATION_ID = 1;
    const FAKE_PROMPT_MESSAGE_ID = 2;
    const FAKE_ANSWER_MESSAGE_ID = 3;
    const FAKE_ROFL_KEY = "0xkey";

    it("should default to DeepSeek if AI_PROVIDER is not set", async () => {
      const clientPayload = { promptText: "test" };
      const payloadBytes = ethers.toUtf8Bytes(
        createEncryptedString(clientPayload, FAKE_SESSION_KEY),
      );
      const fakeEvent = { getBlock: () => Promise.resolve({ timestamp: 1 }), blockNumber: 1 };

      await aiAgentOracle.handlePrompt(
        FAKE_USER_ADDRESS,
        FAKE_CONVERSATION_ID,
        FAKE_PROMPT_MESSAGE_ID,
        FAKE_ANSWER_MESSAGE_ID,
        payloadBytes,
        FAKE_ROFL_KEY,
        fakeEvent,
      );

      const fetchCall = stubs["node-fetch"].firstCall.args;
      expect(fetchCall[0]).to.include("/api/chat"); // Ollama endpoint
      const body = JSON.parse(fetchCall[1].body);
      expect(body.model).to.equal("deepseek-r1:1.5b");
    });

    it("should call queryChainGPT if AI_PROVIDER is 'ChainGPT'", async () => {
      process.env.AI_PROVIDER = "ChainGPT";
      process.env.CHAIN_GPT_API_KEY = "fake-key";

      const clientPayload = { promptText: "test" };
      const payloadBytes = ethers.toUtf8Bytes(
        createEncryptedString(clientPayload, FAKE_SESSION_KEY),
      );
      const fakeEvent = { getBlock: () => Promise.resolve({ timestamp: 1 }), blockNumber: 1 };

      await aiAgentOracle.handlePrompt(
        FAKE_USER_ADDRESS,
        FAKE_CONVERSATION_ID,
        FAKE_PROMPT_MESSAGE_ID,
        FAKE_ANSWER_MESSAGE_ID,
        payloadBytes,
        FAKE_ROFL_KEY,
        fakeEvent,
      );

      const fetchCall = stubs["node-fetch"].firstCall.args;
      expect(fetchCall[0]).to.equal("https://api.chaingpt.org/chat/stream");
      const body = JSON.parse(fetchCall[1].body);
      expect(body.model).to.equal("general_assistant");
    });

    it("should return a specific error message if the chosen provider fails", async () => {
      process.env.AI_PROVIDER = "ChainGPT";
      process.env.CHAIN_GPT_API_KEY = "fake-key";
      stubs["node-fetch"].rejects(new Error("API is down"));

      const clientPayload = { promptText: "test" };
      const payloadBytes = ethers.toUtf8Bytes(
        createEncryptedString(clientPayload, FAKE_SESSION_KEY),
      );
      const fakeEvent = { getBlock: () => Promise.resolve({ timestamp: 1 }), blockNumber: 1 };

      await aiAgentOracle.handlePrompt(
        FAKE_USER_ADDRESS,
        FAKE_CONVERSATION_ID,
        FAKE_PROMPT_MESSAGE_ID,
        FAKE_ANSWER_MESSAGE_ID,
        payloadBytes,
        FAKE_ROFL_KEY,
        fakeEvent,
      );

      const uploadCalls = stubs["./storage/storage"].uploadData.getCalls();
      let uploadedAnswer;
      for (const call of uploadCalls) {
        try {
          const decrypted = decryptSymmetrically(call.args[0].toString(), FAKE_SESSION_KEY);
          if (decrypted.role === "assistant") {
            uploadedAnswer = decrypted;
            break;
          }
        } catch (e) {
          /* ignore */
        }
      }

      expect(uploadedAnswer.content).to.equal(
        "Error: Could not generate a response from the ChainGPT service.",
      );
    });
  });

  describe("Oracle Reliability and Startup", () => {
    it("setOracleAddress should do nothing if addresses match", async () => {
      const mockedContract = stubs["./contractUtility"].initializeOracle().contract;
      mockedContract.oracle.resolves("0xOracleAddress"); // Matches signer

      await aiAgentOracle.setOracleAddress();

      expect(mockedContract.setOracle.called).to.be.false;
    });

    it("setOracleAddress should send alert and throw on EVM if addresses mismatch", async () => {
      const mockedContract = stubs["./contractUtility"].initializeOracle().contract;
      mockedContract.oracle.resolves("0xDifferentAddress");

      try {
        await aiAgentOracle.setOracleAddress();
        expect.fail("Should have thrown an error");
      } catch (error) {
        expect(error.message).to.include("Oracle address mismatch on EVM chain");
        // Use sinon.assert to ensure this specific alert was sent, avoiding ambiguity.
        sinon.assert.calledWithMatch(
          stubs["./alerting"].sendAlert,
          "CRITICAL: Oracle Address Mismatch",
        );
      }
    });

    it("processPastEvents should correctly route all event types", async () => {
      const mockedContract = stubs["./contractUtility"].initializeOracle().contract;
      const getBlock = () => Promise.resolve({ timestamp: Date.now() });

      // Define clear, named constants for all event arguments
      const USER_ADDRESS = "0xUser";
      const ROFL_ENCRYPTED_KEY = "0xKey";
      const CONVERSATION_ID = 1;

      // Constants for PromptSubmitted
      const PROMPT_MESSAGE_ID = 2;
      const PROMPT_ANSWER_ID = 3;

      // Constants for RegenerationRequested
      const REGEN_ORIGINAL_ANSWER_ID = 4;
      const REGEN_NEW_ANSWER_ID = 5;

      // Constants for BranchRequested
      const BRANCH_POINT_MESSAGE_ID = 6;
      const NEW_CONVERSATION_ID = 7;

      // Create specific payloads that match what each handler expects after decryption.
      const promptPayload = ethers.toUtf8Bytes(
        createEncryptedString(
          {
            promptText: "Hello world",
            isNewConversation: true,
            previousMessageId: null,
            previousMessageCID: null,
          },
          FAKE_SESSION_KEY,
        ),
      );
      const regenPayload = ethers.toUtf8Bytes(
        createEncryptedString(
          {
            instructions: "Make it shorter",
            promptMessageCID: "fake_cid_prompt",
            originalAnswerMessageCID: "fake_cid_prev_answer",
          },
          FAKE_SESSION_KEY,
        ),
      );
      const branchPayload = ethers.toUtf8Bytes(
        createEncryptedString({ originalTitle: "My Conversation" }, FAKE_SESSION_KEY),
      );
      const metadataPayload = ethers.toUtf8Bytes(
        createEncryptedString({ title: "A New Title", isDeleted: true }, FAKE_SESSION_KEY),
      );

      // Create fake events for each type with valid arguments and methods.
      const fakePromptEvent = {
        eventName: "PromptSubmitted",
        args: [
          USER_ADDRESS,
          CONVERSATION_ID,
          PROMPT_MESSAGE_ID,
          PROMPT_ANSWER_ID,
          promptPayload,
          ROFL_ENCRYPTED_KEY,
        ],
        blockNumber: 1,
        transactionIndex: 1,
        getBlock,
      };
      const fakeRegenEvent = {
        eventName: "RegenerationRequested",
        args: [
          USER_ADDRESS,
          CONVERSATION_ID,
          PROMPT_MESSAGE_ID,
          REGEN_ORIGINAL_ANSWER_ID,
          REGEN_NEW_ANSWER_ID,
          regenPayload,
          ROFL_ENCRYPTED_KEY,
        ],
        blockNumber: 1,
        transactionIndex: 2,
        getBlock,
      };
      const fakeBranchEvent = {
        eventName: "BranchRequested",
        args: [
          USER_ADDRESS,
          CONVERSATION_ID,
          BRANCH_POINT_MESSAGE_ID,
          NEW_CONVERSATION_ID,
          branchPayload,
          ROFL_ENCRYPTED_KEY,
        ],
        blockNumber: 2,
        transactionIndex: 1,
        getBlock,
      };
      const fakeMetadataEvent = {
        eventName: "MetadataUpdateRequested",
        args: [USER_ADDRESS, CONVERSATION_ID, metadataPayload, ROFL_ENCRYPTED_KEY],
        blockNumber: 3,
        transactionIndex: 1,
        getBlock,
      };

      // Make the queryFilter stub intelligent, returning the correct events for each filter.
      mockedContract.filters.PromptSubmitted.returns("PROMPT_FILTER");
      mockedContract.filters.RegenerationRequested.returns("REGEN_FILTER");
      mockedContract.filters.BranchRequested.returns("BRANCH_FILTER");
      mockedContract.filters.MetadataUpdateRequested.returns("META_FILTER");
      mockedContract.queryFilter.callsFake(async (filter) => {
        if (filter === "PROMPT_FILTER") return [fakePromptEvent];
        if (filter === "REGEN_FILTER") return [fakeRegenEvent];
        if (filter === "BRANCH_FILTER") return [fakeBranchEvent];
        if (filter === "META_FILTER") return [fakeMetadataEvent];
        return [];
      });

      // This makes the test a true integration test of the routing logic.
      await aiAgentOracle.processPastEvents(1, 10);

      // Assert that the final contract submission method for each handler was called.
      expect(mockedContract.submitAnswer.callCount).to.equal(2); // Prompt and Regen
      expect(mockedContract.submitBranch.calledOnce).to.be.true;
      expect(mockedContract.submitConversationMetadata.calledOnce).to.be.true;
    });

    it("retryFailedJobs should re-run a job from the queue", async () => {
      // Define clear, named constants for the event arguments
      const user = "0xUser";
      const conversationId = 1;
      const promptMessageId = 2;
      const answerMessageId = 3;
      const roflEncryptedKey = "key";

      const fakePayload = { promptText: "hello from retry", isNewConversation: true };
      const fakePayloadBytes = ethers.toUtf8Bytes(
        createEncryptedString(fakePayload, FAKE_SESSION_KEY),
      );
      const fakeJob = {
        eventName: "PromptSubmitted",
        event: {
          args: [
            user,
            conversationId,
            promptMessageId,
            answerMessageId,
            fakePayloadBytes,
            roflEncryptedKey,
          ],
          blockNumber: 101,
          transactionHash: "0xhash123",
        },
        retryCount: 0,
        nextAttemptAt: Date.now() - 1000,
      };
      stubs["fs/promises"].readFile
        .withArgs(sinon.match(/failed-jobs\.json$/))
        .resolves(JSON.stringify([fakeJob]));
      const mockedProvider = stubs["./contractUtility"].initializeOracle().provider;
      mockedProvider.getTransactionReceipt.resolves({
        logs: [
          {
            address: "0xMockedContractAddress",
            transactionHash: "0xhash123",
          },
        ],
        blockNumber: 101,
        transactionHash: "0xhash123",
      });
      const mockedContract = stubs["./contractUtility"].initializeOracle().contract;
      mockedContract.interface.parseLog.returns({
        name: "PromptSubmitted",
        transactionHash: "0xhash123",
        args: fakeJob.event.args,
      });
      mockedProvider.getBlock.resolves({ timestamp: Date.now() });

      // Invoke the retry logic and assert that the intended side-effect occurs.
      await aiAgentOracle.retryFailedJobs();

      // Assert that the ultimate side-effect (submitting an answer) happened.
      expect(mockedContract.submitAnswer.calledOnce).to.be.true;

      const writeFileCall = stubs["fs/promises"].writeFile.firstCall.args;
      expect(writeFileCall[0]).to.include("failed-jobs.json");
      expect(JSON.parse(writeFileCall[1])).to.deep.equal([]);
    });

    it("should drop a job after max retries are exceeded", async () => {
      const fakeJob = {
        eventName: "PromptSubmitted",
        event: { transactionHash: "0xhash123", blockNumber: 101, args: [] },
        retryCount: 9, // This is the last attempt
        nextAttemptAt: Date.now() - 1000,
      };
      stubs["fs/promises"].readFile
        .withArgs(sinon.match(/failed-jobs\.json$/))
        .resolves(JSON.stringify([fakeJob]));

      const mockedProvider = stubs["./contractUtility"].initializeOracle().provider;
      // Simulate the job failing again (e.g., RPC is down)
      mockedProvider.getTransactionReceipt.rejects(new Error("RPC Down"));

      await aiAgentOracle.retryFailedJobs();

      // Assert a critical alert was sent for the dropped job.
      sinon.assert.calledWithMatch(
        stubs["./alerting"].sendAlert,
        "CRITICAL: Job Failed Permanently",
      );

      // Assert the job queue was emptied.
      const writeFileCall = stubs["fs/promises"].writeFile.firstCall.args;
      expect(writeFileCall[0]).to.include("failed-jobs.json");
      expect(JSON.parse(writeFileCall[1])).to.deep.equal([]);
    });

    it("should re-queue a job if the event log cannot be parsed from the receipt", async () => {
      const fakeJob = {
        eventName: "PromptSubmitted",
        event: { transactionHash: "0xhash123", blockNumber: 101, args: [] },
        retryCount: 0,
        nextAttemptAt: Date.now() - 1000,
      };
      stubs["fs/promises"].readFile
        .withArgs(sinon.match(/failed-jobs\.json$/))
        .resolves(JSON.stringify([fakeJob]));
      const mockedProvider = stubs["./contractUtility"].initializeOracle().provider;
      mockedProvider.getTransactionReceipt.resolves({ logs: [{ address: "0xsomeOtherAddress" }] });

      // Explicitly stub parseLog to return null for the un-matching log address.
      const mockedContract = stubs["./contractUtility"].initializeOracle().contract;
      mockedContract.interface.parseLog.returns(null);

      await aiAgentOracle.retryFailedJobs();

      // The job should fail and be re-queued, not dropped.
      expect(stubs["./alerting"].sendAlert.called).to.be.false;
      const writeFileCall = stubs["fs/promises"].writeFile.firstCall.args;
      const remainingJobs = JSON.parse(writeFileCall[1]);
      expect(remainingJobs).to.have.lengthOf(1);
      expect(remainingJobs[0].retryCount).to.equal(1);
    });

    it("should correctly calculate exponential backoff for a failed retry", async () => {
      const clock = sinon.useFakeTimers();
      const now = Date.now();

      const fakeJob = {
        eventName: "PromptSubmitted",
        event: { transactionHash: "0xhash123", blockNumber: 101, args: [] },
        retryCount: 1, // Second retry attempt (first was #0)
        nextAttemptAt: now - 1000,
      };
      stubs["fs/promises"].readFile
        .withArgs(sinon.match(/failed-jobs\.json$/))
        .resolves(JSON.stringify([fakeJob]));
      stubs["./contractUtility"]
        .initializeOracle()
        .provider.getTransactionReceipt.rejects(new Error("RPC still down"));

      await aiAgentOracle.retryFailedJobs();

      const writeFileCall = stubs["fs/promises"].writeFile.firstCall.args;
      const remainingJobs = JSON.parse(writeFileCall[1]);
      expect(remainingJobs[0].retryCount).to.equal(2);

      const BASE_RETRY_DELAY_MS = 30 * 1000;
      const expectedDelay = BASE_RETRY_DELAY_MS * Math.pow(2, 2);
      expect(remainingJobs[0].nextAttemptAt).to.be.closeTo(now + expectedDelay, 10);

      clock.restore();
    });
  });

  describe("getSessionKey", () => {
    it("should retrieve key from payload for EVM", async () => {
      const roflEncryptedKey = "0xencryptedKey";
      const key = await aiAgentOracle.getSessionKey(null, roflEncryptedKey, null);
      expect(
        stubs["eth-crypto"].decryptWithPrivateKey.calledOnceWith(sinon.match.any, "encryptedKey"),
      ).to.be.true;
      expect(key).to.deep.equal(FAKE_SESSION_KEY);
    });

    it("should retrieve key from payload for Sapphire", async () => {
      // For Sapphire, we re-initialize with a Sapphire-configured mock.
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

      // Assert that the fallback to storage was used.
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

    it("should throw if key cannot be found in payload or storage", async () => {
      stubs["./storage/storage"].queryTransactionByTags.resolves(null); // Key not in storage
      try {
        await aiAgentOracle.getSessionKey(null, null, "123");
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error.message).to.include("Could not find Key File");
      }
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

      // Encrypt the payload as the frontend client would.
      const encryptedPayloadString = createEncryptedString(clientPayload, FAKE_SESSION_KEY);
      const payloadBytes = ethers.toUtf8Bytes(encryptedPayloadString);

      const fakeEvent = {
        blockNumber: 1,
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

      // A new conversation should upload 6 files: Key, Conversation, Metadata, Prompt, Search, and Answer.
      expect(stubs["./storage/storage"].uploadData.callCount).to.equal(6);

      // The key file should be uploaded with specific identifying tags.
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

      // An existing conversation should only upload 3 files: Prompt, Answer, and SearchDelta.
      expect(stubs["./storage/storage"].uploadData.callCount).to.equal(3);

      // The final answer should be submitted to the contract.
      const mockedContract = stubs["./contractUtility"].initializeOracle().contract;
      expect(mockedContract.submitAnswer.calledOnce).to.be.true;

      const cidBundle = mockedContract.submitAnswer.firstCall.args[2];
      expect(cidBundle.conversationCID).to.equal("");
      expect(cidBundle.metadataCID).to.equal("");
      expect(cidBundle.promptMessageCID).to.include("fake_cid_");
      expect(cidBundle.answerMessageCID).to.include("fake_cid_");
      expect(cidBundle.searchDeltaCID).to.include("fake_cid_");
    });

    it("should produce an error message if the AI model fails", async () => {
      // Simulate the AI model's API being down.
      stubs["node-fetch"].resolves({
        ok: false,
        status: 503,
      });

      const user = "0xUser";
      const conversationId = 1;
      const promptMessageId = 2;
      const answerMessageId = 3;
      const roflEncryptedKey = "0xkey";

      const clientPayload = {
        promptText: "Hello world",
        isNewConversation: true,
        previousMessageId: null,
        previousMessageCID: null,
      };
      const payloadBytes = ethers.toUtf8Bytes(
        createEncryptedString(clientPayload, FAKE_SESSION_KEY),
      );
      const fakeEvent = { getBlock: () => Promise.resolve({ timestamp: 1 }), blockNumber: 1 };

      await aiAgentOracle.handlePrompt(
        user,
        conversationId,
        promptMessageId,
        answerMessageId,
        payloadBytes,
        roflEncryptedKey,
        fakeEvent,
      );

      // Find the uploaded answer file by decrypting all uploads and checking the role.
      const uploadCalls = stubs["./storage/storage"].uploadData.getCalls();
      let uploadedAnswer;
      for (const call of uploadCalls) {
        try {
          const decrypted = decryptSymmetrically(call.args[0].toString(), FAKE_SESSION_KEY);
          if (decrypted.role === "assistant") {
            uploadedAnswer = decrypted;
            break;
          }
        } catch (e) {
          // Ignore uploads that are not symmetrically encrypted message files (like the key file).
        }
      }

      expect(uploadedAnswer).to.not.be.undefined;
      expect(uploadedAnswer.content).to.include("Error: Could not generate a response");
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
        null, // roflEncryptedKey is null for Sapphire; it's inside the payload.
        fakeEvent,
      );

      expect(stubs["./storage/storage"].uploadData.callCount).to.equal(6);

      const keyUploadArgs = stubs["./storage/storage"].uploadData.getCall(0).args;
      expect(keyUploadArgs[0].toString()).to.equal(clientPayload.roflEncryptedKey);

      expect(sapphireComponents.contract.submitAnswer.calledOnce).to.be.true;

      // PARITY: Check that the CID bundle matches the EVM new conversation structure.
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

      // PARITY: Check that the sparse CID bundle matches the EVM existing conversation structure.
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
      // Deconstruct the arguments for more specific and readable assertions.
      const [submittedPromptId, submittedAnswerId, cidBundle] = submitAnswerStub.firstCall.args;
      expect(submittedPromptId).to.equal(promptMessageId);
      expect(submittedAnswerId).to.equal(newAnswerMessageId);
      expect(cidBundle.answerMessageCID).to.include("fake_cid_");
      expect(cidBundle.promptMessageCID).to.equal("");
      expect(cidBundle.conversationCID).to.equal("");

      // Verify the content of the uploaded answer file.
      const uploadArgs = stubs["./storage/storage"].uploadData.firstCall.args;
      const uploadedContent = decryptSymmetrically(uploadArgs[0].toString(), FAKE_SESSION_KEY);
      expect(uploadedContent.content).to.equal("Mocked AI Response");
      expect(uploadedContent.parentId).to.equal(promptMessageId.toString());
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

    it("should handle a metadata update request", async () => {
      const user = "0xUser";
      const conversationId = 123;
      const roflEncryptedKey = "0xkey";
      const clientPayload = { title: "A New Title", isDeleted: true };
      const payloadBytes = ethers.toUtf8Bytes(
        createEncryptedString(clientPayload, FAKE_SESSION_KEY),
      );
      const fakeEvent = {
        blockNumber: 5,
        getBlock: () => Promise.resolve({ timestamp: Date.now() }),
      };

      await aiAgentOracle.handleMetadataUpdate(
        user,
        conversationId,
        payloadBytes,
        roflEncryptedKey,
        fakeEvent,
      );

      expect(stubs["./storage/storage"].uploadData.callCount).to.equal(1);
      const submitMetaStub =
        stubs["./contractUtility"].initializeOracle().contract.submitConversationMetadata;
      expect(submitMetaStub.calledOnce).to.be.true;

      const [subConvId, subMetaCID] = submitMetaStub.firstCall.args;
      expect(subConvId).to.equal(conversationId);
      expect(subMetaCID).to.include("fake_cid_");

      // Verify the content of the uploaded metadata file.
      const uploadArgs = stubs["./storage/storage"].uploadData.firstCall.args;
      const uploadedContent = decryptSymmetrically(uploadArgs[0].toString(), FAKE_SESSION_KEY);
      expect(uploadedContent.title).to.equal(clientPayload.title);
      expect(uploadedContent.isDeleted).to.be.true;
    });
  });

  describe("Error Handling", () => {
    it("should add a job to the retry queue if a retryable error occurs", async () => {
      stubs["./storage/storage"].uploadData.rejects(new Error("Irys is down"));
      const writeFileStub = stubs["fs/promises"].writeFile;
      const user = "0xUser";
      const conversationId = 123;
      const promptMessageId = 456;
      const answerMessageId = 457;
      const roflEncryptedKey = "0xkey";

      const clientPayload = { promptText: "This will fail", isNewConversation: true };
      const payloadBytes = ethers.toUtf8Bytes(
        createEncryptedString(clientPayload, FAKE_SESSION_KEY),
      );

      const fakeEvent = {
        blockNumber: 100,
        transactionHash: "0xhash",
        args: [
          user,
          conversationId,
          promptMessageId,
          answerMessageId,
          payloadBytes,
          roflEncryptedKey,
        ],
        getBlock: () => Promise.resolve({ timestamp: Date.now() }),
      };

      await aiAgentOracle.handleAndRecord(
        "PromptSubmitted",
        aiAgentOracle.handlePrompt,
        ...fakeEvent.args,
        fakeEvent,
      );

      expect(stubs["./contractUtility"].initializeOracle().contract.submitAnswer.called).to.be
        .false;
      // A retryable error should queue a job but not trigger a critical alert.
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

    it("should send a critical alert for a non-retryable error", async () => {
      // Simulate a fatal error like a decryption failure.
      stubs["eth-crypto"].decryptWithPrivateKey.rejects(new Error("Decryption failed"));
      const writeFileStub = stubs["fs/promises"].writeFile;

      const user = "0xUser";
      const conversationId = 1;
      const promptMessageId = 2;
      const answerMessageId = 3;
      const payload = "0xpayload";
      const roflEncryptedKey = "0xkey";

      const fakeEvent = {
        blockNumber: 101,
        args: [user, conversationId, promptMessageId, answerMessageId, payload, roflEncryptedKey],
        getBlock: () => Promise.resolve({ timestamp: Date.now() }),
      };

      await aiAgentOracle.handleAndRecord(
        "PromptSubmitted",
        aiAgentOracle.handlePrompt,
        ...fakeEvent.args,
        fakeEvent,
      );

      // Assert that a critical alert was sent.
      sinon.assert.calledWithMatch(stubs["./alerting"].sendAlert, "CRITICAL: Oracle Fatal Error");

      // Assert that the job was NOT added to the retry queue.
      const failedJobsCall = writeFileStub
        .getCalls()
        .find((call) => call.args[0].includes("failed-jobs.json"));
      expect(failedJobsCall).to.be.undefined;
    });

    it("should trigger a high lag alert if event is too old", async () => {
      const now = Math.floor(Date.now() / 1000);
      const oldTimestamp = now - 500; // 500 seconds old

      const fakeEvent = {
        blockNumber: 1,
        getBlock: () => Promise.resolve({ timestamp: oldTimestamp }),
        args: [],
      };

      const handlerStub = sinon.stub().resolves();

      await aiAgentOracle.handleAndRecord("TestEvent", handlerStub, fakeEvent);

      sinon.assert.calledWithMatch(
        stubs["./alerting"].sendAlert,
        "High Oracle Processing Lag Detected",
      );
    });
  });

  describe("reconstructHistory", () => {
    it("should walk the parentCID chain correctly", async () => {
      // Set up the mock chain of messages.
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

      // Create the encrypted versions of the messages.
      const encryptedMsg3 = createEncryptedString(msg3, FAKE_SESSION_KEY);
      const encryptedMsg2 = createEncryptedString(msg2, FAKE_SESSION_KEY);
      const encryptedMsg1 = createEncryptedString(msg1, FAKE_SESSION_KEY);

      // Configure the fetchData stub to return the correct message for each CID.
      stubs["./storage/storage"].fetchData
        .withArgs("cid_3")
        .resolves(encryptedMsg3)
        .withArgs("cid_2")
        .resolves(encryptedMsg2)
        .withArgs("cid_1")
        .resolves(encryptedMsg1);

      const history = await aiAgentOracle.reconstructHistory("cid_3", FAKE_SESSION_KEY);

      // The reconstructed history should contain all 3 messages.
      expect(history).to.have.lengthOf(3);

      // The history should be in the correct chronological order (oldest first).
      expect(history[0]).to.deep.equal({ role: msg1.role, content: msg1.content });
      expect(history[1]).to.deep.equal({ role: msg2.role, content: msg2.content });
      expect(history[2]).to.deep.equal({ role: msg3.role, content: msg3.content });
    });

    it("should stop gracefully if a parent message cannot be fetched", async () => {
      const msg3 = {
        id: "msg_3",
        role: "assistant",
        content: "Response",
        parentCID: "cid_2_broken",
      };
      const encryptedMsg3 = createEncryptedString(msg3, FAKE_SESSION_KEY);

      stubs["./storage/storage"].fetchData
        .withArgs("cid_3")
        .resolves(encryptedMsg3)
        .withArgs("cid_2_broken")
        .rejects(new Error("CID not found")); // Simulate storage failure

      const history = await aiAgentOracle.reconstructHistory("cid_3", FAKE_SESSION_KEY);

      // The history should contain only the one message that was successfully fetched.
      expect(history).to.have.lengthOf(1);
      expect(history[0].content).to.equal("Response");
    });

    it("should respect the AI_CONTEXT_MESSAGES_LIMIT", async () => {
      // Simulate a long chain where each message points to the previous one
      const limit = 20; // Default limit
      for (let i = 1; i <= limit + 5; i++) {
        const msg = {
          role: "user",
          content: `Message ${i}`,
          parentCID: i > 1 ? `cid_${i - 1}` : null,
        };
        stubs["./storage/storage"].fetchData
          .withArgs(`cid_${i}`)
          .resolves(createEncryptedString(msg, FAKE_SESSION_KEY));
      }

      const history = await aiAgentOracle.reconstructHistory(`cid_${limit + 5}`, FAKE_SESSION_KEY);

      // The history should be capped at the limit
      expect(history).to.have.lengthOf(limit);
      // The oldest message should be the 6th one in the chain (25 - 20 + 1)
      expect(history[0].content).to.equal("Message 6");
    });
  });
});
