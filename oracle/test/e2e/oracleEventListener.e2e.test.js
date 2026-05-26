const chai = require("chai");
const sinon = require("sinon");
const { expect } = chai;
const proxyquire = require("proxyquire").noCallThru();
const crypto = require("crypto");
const { ethers } = require("ethers");

/**
 * E2E: Oracle Event Listener — event detection, processing, and on-chain response
 *
 * Tests the oracle's full event processing pipeline with mocked external services
 * but realistic event structures and encrypted payloads:
 *   - PromptSubmitted event → decrypt → AI query → encrypt response → submit answer
 *   - Regeneration and Branch event handling
 *   - Metadata update flow
 */
describe("E2E: Oracle Event Listener", function () {
  let aiAgentOracle;
  let stubs;
  const FAKE_SESSION_KEY = crypto.randomBytes(32);
  const FAKE_ENCRYPTED_KEY = Buffer.from("fake-ecies-cipher-blob");

  const createEncryptedString = (dataObject, key) => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.from(JSON.stringify(dataObject));
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    const tag = cipher.getAuthTag();
    const combined = Buffer.concat([encrypted, tag]);
    return `${iv.toString("base64")}.${combined.toString("base64")}`;
  };

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

  let mockedOracleComponents;

  beforeEach(() => {
    const randomWallet = ethers.Wallet.createRandom();
    process.env.PRIVATE_KEY = randomWallet.privateKey;
    process.env.OLLAMA_URL = "http://fake-ollama";

    mockedOracleComponents = {
      provider: {
        getNetwork: sinon.stub().resolves({ chainId: 1 }),
        getTransactionReceipt: sinon.stub(),
        getBlock: sinon.stub(),
        getBlockNumber: sinon.stub().resolves(10000),
      },
      signer: { address: "0xOracleAddress" },
      contract: {
        target: "0xMockedContractAddress",
        submitAnswer: sinon
          .stub()
          .resolves({ wait: () => Promise.resolve({ hash: "0xTxHash" }) }),
        submitBranch: sinon
          .stub()
          .resolves({ wait: () => Promise.resolve({ hash: "0xTxHash" }) }),
        submitConversationMetadata: sinon
          .stub()
          .resolves({ wait: () => Promise.resolve({ hash: "0xTxHash" }) }),
        isJobFinalized: sinon.stub().resolves(false),
        oracle: sinon.stub(),
        setOracle: sinon.stub().resolves({ wait: () => Promise.resolve() }),
        queryFilter: sinon.stub(),
        on: sinon.stub(),
        filters: {
          PromptSubmitted: sinon.stub(),
          RegenerationRequested: sinon.stub(),
          BranchRequested: sinon.stub(),
          MetadataUpdateRequested: sinon.stub(),
        },
        interface: {
          parseLog: sinon.stub(),
        },
      },
      isSapphire: false,
    };

    sinon.stub(global, "setInterval");

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
      "./ecies": {
        eciesDecrypt: sinon.stub().resolves(FAKE_SESSION_KEY),
        eciesEncrypt: sinon.stub().resolves(FAKE_ENCRYPTED_KEY),
        publicKeyFromPrivateKey: sinon.stub().returns("04" + "0f".repeat(64)),
      },
      "@elizaos/core": {
        ElizaOS: class {
          async addAgents() {
            return ["fake-agent-id"];
          }
          async startAgents() {}
          getAgent() {
            return null;
          }
        },
        elizaLogger: {
          info: () => {},
          log: () => {},
          error: () => {},
          warn: () => {},
          debug: () => {},
        },
        stringToUuid: (s) => s,
        createUniqueUuid: (_ns, s) => s,
        ChannelType: { DM: "DM", WORLD: "WORLD" },
      },
      "./elizaos/plugins/plugin-senseai/dist/index.js": { default: {} },
      "./elizaos/character.js": {},
      "@sentry/node": {
        init: sinon.stub(),
        captureException: sinon.stub(),
        captureMessage: sinon.stub(),
        withScope: sinon.stub(),
        configureScope: sinon.stub(),
        setTag: sinon.stub(),
        setUser: sinon.stub(),
        startSpan: sinon.stub().callsFake((_opts, fn) => fn && fn({})),
        getCurrentScope: sinon
          .stub()
          .returns({ setTag: sinon.stub(), setUser: sinon.stub() }),
      },
      "./formatters": {
        createConversationFile: sinon.stub().callsFake((data) => data),
        createConversationMetadataFile: sinon.stub().callsFake((data) => data),
        createMessageFile: sinon.stub().callsFake((data) => data),
        createSearchIndexDeltaFile: sinon.stub().callsFake((data) => data),
        generateKeywords: sinon.stub().returns([]),
      },
    };

    aiAgentOracle = proxyquire("../../src/aiAgentOracle", stubs);
    aiAgentOracle.initForTest(mockedOracleComponents);
    sinon.stub(global, "fetch").callsFake((...args) => stubs["node-fetch"](...args));
    delete process.env.CHAIN_GPT_API_KEY;
  });

  afterEach(() => {
    sinon.restore();
    delete process.env.AI_PROVIDER;
    delete process.env.PRIVATE_KEY;
    delete process.env.OLLAMA_URL;
    delete process.env.CHAIN_GPT_API_KEY;
  });

  describe("Full Prompt → Answer Pipeline", function () {
    it("processes a new conversation prompt end-to-end: decrypt → AI → encrypt → submit", async function () {
      const user = "0xUser1";
      const conversationId = 1;
      const promptMessageId = 100;
      const answerMessageId = 101;
      const roflEncryptedKey = "0xencryptedkey";

      const clientPayload = {
        promptText: "What is the price of ETH?",
        isNewConversation: true,
        previousMessageId: null,
        previousMessageCID: null,
      };

      const encryptedPayloadString = createEncryptedString(clientPayload, FAKE_SESSION_KEY);
      const payloadBytes = ethers.toUtf8Bytes(encryptedPayloadString);

      const fakeEvent = {
        blockNumber: 5000,
        getBlock: () => Promise.resolve({ timestamp: Math.floor(Date.now() / 1000) }),
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

      // Verify: storage uploads happened (6 files for new conversation)
      expect(stubs["./storage/storage"].uploadData.callCount).to.equal(6);

      // Verify: on-chain answer submission
      const contract = mockedOracleComponents.contract;
      expect(contract.submitAnswer.calledOnce).to.be.true;

      const [submittedPromptId, submittedAnswerId, cidBundle] =
        contract.submitAnswer.firstCall.args;
      expect(submittedPromptId).to.equal(promptMessageId);
      expect(submittedAnswerId).to.equal(answerMessageId);
      expect(cidBundle.conversationCID).to.include("fake_cid_");
      expect(cidBundle.answerMessageCID).to.include("fake_cid_");
    });

    it("processes an existing conversation prompt (3 uploads, no conversation/metadata files)", async function () {
      const user = "0xUser1";
      const conversationId = 1;
      const promptMessageId = 102;
      const answerMessageId = 103;
      const roflEncryptedKey = "0xencryptedkey";

      const clientPayload = {
        promptText: "Follow up question about ETH gas fees",
        isNewConversation: false,
        previousMessageId: "msg_101",
        previousMessageCID: "fake_cid_prev_answer",
      };

      const encryptedPayloadString = createEncryptedString(clientPayload, FAKE_SESSION_KEY);
      const payloadBytes = ethers.toUtf8Bytes(encryptedPayloadString);

      const fakeEvent = {
        blockNumber: 5001,
        getBlock: () => Promise.resolve({ timestamp: Math.floor(Date.now() / 1000) }),
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

      // Existing conversation: 3 uploads (Prompt, Search, Answer) — no Conversation, Metadata, or Key files
      expect(stubs["./storage/storage"].uploadData.callCount).to.equal(3);

      expect(mockedOracleComponents.contract.submitAnswer.calledOnce).to.be.true;
    });

    it("skips already-finalized prompts (idempotency)", async function () {
      mockedOracleComponents.contract.isJobFinalized.resolves(true);

      const clientPayload = {
        promptText: "Should be skipped",
        isNewConversation: true,
        previousMessageId: null,
        previousMessageCID: null,
      };

      const encryptedPayloadString = createEncryptedString(clientPayload, FAKE_SESSION_KEY);
      const payloadBytes = ethers.toUtf8Bytes(encryptedPayloadString);

      const fakeEvent = {
        blockNumber: 5002,
        getBlock: () => Promise.resolve({ timestamp: Math.floor(Date.now() / 1000) }),
      };

      await aiAgentOracle.handlePrompt(
        "0xUser1",
        1,
        200,
        201,
        payloadBytes,
        "0xkey",
        fakeEvent,
      );

      // No storage uploads, no answer submission
      expect(stubs["./storage/storage"].uploadData.callCount).to.equal(0);
      expect(mockedOracleComponents.contract.submitAnswer.called).to.be.false;
    });
  });

  describe("handleAndRecord Error Classification", function () {
    it("drops malformed payloads silently without retrying", async function () {
      const malformedPayload = ethers.toUtf8Bytes("not-encrypted-at-all");
      const fakeEvent = {
        blockNumber: 6000,
        args: ["0xUser", 1, 300, 301, malformedPayload, "0xkey"],
        getBlock: () => Promise.resolve({ timestamp: Math.floor(Date.now() / 1000) }),
      };

      await aiAgentOracle.handleAndRecord(
        "PromptSubmitted",
        aiAgentOracle.handlePrompt,
        "0xUser",
        1,
        300,
        301,
        malformedPayload,
        "0xkey",
        fakeEvent,
      );

      // State file is updated (block progress saved)
      expect(stubs["fs/promises"].writeFile.called).to.be.true;
      const writeCall = stubs["fs/promises"].writeFile.getCalls().find((c) =>
        c.args[0].includes("oracle-state.json"),
      );
      expect(writeCall).to.not.be.undefined;

      // Failed jobs file is NOT written (malicious payload dropped)
      const failedJobsWrite = stubs["fs/promises"].writeFile.getCalls().find((c) =>
        c.args[0].includes("failed-jobs.json"),
      );
      expect(failedJobsWrite).to.be.undefined;
    });

    it("queues retryable storage errors to failed-jobs.json", async function () {
      stubs["./storage/storage"].uploadData.rejects(new Error("Autonomys upload timeout"));

      // Need a valid encrypted payload so decryption succeeds
      const clientPayload = {
        promptText: "Test storage failure",
        isNewConversation: true,
        previousMessageId: null,
        previousMessageCID: null,
      };
      const encryptedPayloadString = createEncryptedString(clientPayload, FAKE_SESSION_KEY);
      const payloadBytes = ethers.toUtf8Bytes(encryptedPayloadString);

      const fakeEvent = {
        blockNumber: 6001,
        transactionHash: "0xfaketxhash",
        args: ["0xUser", 1, 302, 303, payloadBytes, "0xkey"],
        getBlock: () => Promise.resolve({ timestamp: Math.floor(Date.now() / 1000) }),
      };

      await aiAgentOracle.handleAndRecord(
        "PromptSubmitted",
        aiAgentOracle.handlePrompt,
        "0xUser",
        1,
        302,
        303,
        payloadBytes,
        "0xkey",
        fakeEvent,
      );

      // Failed jobs file IS written
      const failedJobsWrite = stubs["fs/promises"].writeFile.getCalls().find((c) =>
        c.args[0].includes("failed-jobs.json"),
      );
      expect(failedJobsWrite).to.not.be.undefined;

      const failedJobs = JSON.parse(failedJobsWrite.args[1]);
      expect(failedJobs).to.be.an("array").with.lengthOf(1);
      expect(failedJobs[0].eventName).to.equal("PromptSubmitted");
      expect(failedJobs[0].retryCount).to.equal(0);
    });

    it("sends alert for non-retryable fatal errors", async function () {
      stubs["./storage/storage"].uploadData.rejects(
        new Error("Completely unexpected failure"),
      );

      const clientPayload = {
        promptText: "Test fatal failure",
        isNewConversation: true,
        previousMessageId: null,
        previousMessageCID: null,
      };
      const encryptedPayloadString = createEncryptedString(clientPayload, FAKE_SESSION_KEY);
      const payloadBytes = ethers.toUtf8Bytes(encryptedPayloadString);

      const fakeEvent = {
        blockNumber: 6002,
        args: ["0xUser", 1, 304, 305, payloadBytes, "0xkey"],
        getBlock: () => Promise.resolve({ timestamp: Math.floor(Date.now() / 1000) }),
      };

      await aiAgentOracle.handleAndRecord(
        "PromptSubmitted",
        aiAgentOracle.handlePrompt,
        "0xUser",
        1,
        304,
        305,
        payloadBytes,
        "0xkey",
        fakeEvent,
      );

      // Alert sent for fatal error
      expect(stubs["./alerting"].sendAlert.calledOnce).to.be.true;
      expect(stubs["./alerting"].sendAlert.firstCall.args[0]).to.include("CRITICAL");

      // Sentry captures the exception (once in handlePrompt, once in handleAndRecord)
      expect(stubs["@sentry/node"].captureException.called).to.be.true;
    });
  });

  describe("Oracle Start & Event Processing", function () {
    beforeEach(() => {
      process.env.EVENT_BATCH_SIZE = "10000";
      mockedOracleComponents.contract.oracle.resolves("0xOracleAddress");
      mockedOracleComponents.contract.queryFilter.resolves([]);
    });

    afterEach(() => {
      delete process.env.EVENT_BATCH_SIZE;
    });

    it("initializes storage, sets oracle address, and starts polling", async function () {
      stubs["fs/promises"].readFile
        .withArgs(sinon.match(/oracle-state\.json$/))
        .rejects(new Error("File not found"));
      mockedOracleComponents.provider.getBlockNumber.resolves(10000);

      await aiAgentOracle.start();

      // Storage initialized
      expect(stubs["./storage/storage"].initializeStorage.calledOnce).to.be.true;

      // Oracle address check
      expect(mockedOracleComponents.contract.oracle.calledOnce).to.be.true;

      // State file written
      const stateWrites = stubs["fs/promises"].writeFile.getCalls().filter((c) =>
        c.args[0].includes("oracle-state.json"),
      );
      expect(stateWrites.length).to.be.greaterThan(0);
    });

    it("processes past events on startup before entering poll loop", async function () {
      stubs["fs/promises"].readFile
        .withArgs(sinon.match(/oracle-state\.json$/))
        .resolves(JSON.stringify({ lastProcessedBlock: 9000 }));
      mockedOracleComponents.provider.getBlockNumber.resolves(10000);

      await aiAgentOracle.start();

      // queryFilter called to catch up from block 9001 to 10000
      const queryFilterCall = mockedOracleComponents.contract.queryFilter.firstCall;
      expect(queryFilterCall.args[1]).to.equal(9001);
      expect(queryFilterCall.args[2]).to.equal(10000);
    });
  });
});
