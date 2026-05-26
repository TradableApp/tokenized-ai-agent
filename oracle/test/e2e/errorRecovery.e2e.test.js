const chai = require("chai");
const sinon = require("sinon");
const { expect } = chai;
const proxyquire = require("proxyquire").noCallThru();
const crypto = require("crypto");
const { ethers } = require("ethers");

/**
 * E2E: Error Recovery — Retry logic, failed-jobs.json, exponential backoff
 *
 * Tests the oracle's resilience:
 *   - Storage upload failure → queued to failed-jobs.json → retry succeeds
 *   - AI provider timeout → fallback chain → eventual success
 *   - Contract revert on answer → error classification
 *   - Exponential backoff timing
 *   - Max retry exhaustion → permanent failure alert
 */
describe("E2E: Error Recovery", function () {
  let aiAgentOracle;
  let stubs;
  let mockedOracleComponents;
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

  beforeEach(() => {
    const randomWallet = ethers.Wallet.createRandom();
    process.env.PRIVATE_KEY = randomWallet.privateKey;
    process.env.OLLAMA_URL = "http://fake-ollama";

    mockedOracleComponents = {
      provider: {
        getNetwork: sinon.stub().resolves({ chainId: 1 }),
        getTransactionReceipt: sinon.stub(),
        getBlock: sinon.stub().resolves({ timestamp: Math.floor(Date.now() / 1000) }),
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
        uploadData: sinon.stub().callsFake((buffer) => {
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

  describe("Storage Upload Failure → Retry Queue", function () {
    it("queues Autonomys failures with correct retry metadata", async function () {
      stubs["./storage/storage"].uploadData.rejects(
        new Error("Autonomys network unreachable"),
      );

      const clientPayload = {
        promptText: "Test Autonomys failure",
        isNewConversation: true,
        previousMessageId: null,
        previousMessageCID: null,
      };
      const encryptedPayloadString = createEncryptedString(clientPayload, FAKE_SESSION_KEY);
      const payloadBytes = ethers.toUtf8Bytes(encryptedPayloadString);

      const fakeEvent = {
        blockNumber: 7000,
        transactionHash: "0xautonomystx",
        args: ["0xUser", 1, 400, 401, payloadBytes, "0xkey"],
        getBlock: () => Promise.resolve({ timestamp: Math.floor(Date.now() / 1000) }),
      };

      await aiAgentOracle.handleAndRecord(
        "PromptSubmitted",
        aiAgentOracle.handlePrompt,
        "0xUser",
        1,
        400,
        401,
        payloadBytes,
        "0xkey",
        fakeEvent,
      );

      const failedJobsWrite = stubs["fs/promises"].writeFile
        .getCalls()
        .find((c) => c.args[0].includes("failed-jobs.json"));
      expect(failedJobsWrite).to.not.be.undefined;

      const jobs = JSON.parse(failedJobsWrite.args[1]);
      expect(jobs).to.have.lengthOf(1);
      expect(jobs[0].eventName).to.equal("PromptSubmitted");
      expect(jobs[0].retryCount).to.equal(0);
      expect(jobs[0].event.blockNumber).to.equal(7000);
      expect(jobs[0].event.transactionHash).to.equal("0xautonomystx");
      expect(jobs[0].nextAttemptAt).to.be.a("number");
    });

    it("queues Irys failures as retryable", async function () {
      stubs["./storage/storage"].uploadData.rejects(
        new Error("Irys upload failed: 502 Bad Gateway"),
      );

      const clientPayload = {
        promptText: "Test Irys failure",
        isNewConversation: true,
        previousMessageId: null,
        previousMessageCID: null,
      };
      const encryptedPayloadString = createEncryptedString(clientPayload, FAKE_SESSION_KEY);
      const payloadBytes = ethers.toUtf8Bytes(encryptedPayloadString);

      const fakeEvent = {
        blockNumber: 7001,
        transactionHash: "0xirystx",
        args: ["0xUser", 1, 402, 403, payloadBytes, "0xkey"],
        getBlock: () => Promise.resolve({ timestamp: Math.floor(Date.now() / 1000) }),
      };

      await aiAgentOracle.handleAndRecord(
        "PromptSubmitted",
        aiAgentOracle.handlePrompt,
        "0xUser",
        1,
        402,
        403,
        payloadBytes,
        "0xkey",
        fakeEvent,
      );

      const failedJobsWrite = stubs["fs/promises"].writeFile
        .getCalls()
        .find((c) => c.args[0].includes("failed-jobs.json"));
      expect(failedJobsWrite).to.not.be.undefined;
    });
  });

  describe("Retry Mechanism", function () {
    it("retries a failed job successfully on second attempt", async function () {
      // Make the handler succeed on retry by returning early (idempotency: job already finalized)
      mockedOracleComponents.contract.isJobFinalized.resolves(true);

      const clientPayload = {
        promptText: "Retryable prompt",
        isNewConversation: true,
        previousMessageId: null,
        previousMessageCID: null,
      };
      const encryptedPayloadString = createEncryptedString(clientPayload, FAKE_SESSION_KEY);
      const payloadBytes = ethers.toUtf8Bytes(encryptedPayloadString);

      const fakeReceipt = {
        blockNumber: 7000,
        logs: [
          {
            address: "0xMockedContractAddress",
            transactionHash: "0xretrytx",
            topics: ["0xfaketopic"],
            data: "0x",
          },
        ],
      };
      mockedOracleComponents.provider.getTransactionReceipt.resolves(fakeReceipt);
      mockedOracleComponents.provider.getBlock.resolves({
        timestamp: Math.floor(Date.now() / 1000),
      });

      const fakeArgs = [
        "0xUser",
        1,
        500,
        501,
        payloadBytes,
        "0xkey",
      ];
      mockedOracleComponents.contract.interface.parseLog.returns({
        name: "PromptSubmitted",
        args: fakeArgs,
      });

      const failedJobs = [
        {
          eventName: "PromptSubmitted",
          event: {
            args: fakeArgs.map((a) => (typeof a === "object" ? "0x" : a)),
            blockNumber: 7000,
            transactionHash: "0xretrytx",
          },
          retryCount: 0,
          nextAttemptAt: 0,
        },
      ];

      stubs["fs/promises"].readFile
        .withArgs(sinon.match(/failed-jobs\.json$/), "utf-8")
        .resolves(JSON.stringify(failedJobs));

      await aiAgentOracle.retryFailedJobs();

      // The failed-jobs.json should be rewritten (job removed after success)
      const writeCall = stubs["fs/promises"].writeFile
        .getCalls()
        .find((c) => c.args[0].includes("failed-jobs.json"));
      expect(writeCall).to.not.be.undefined;

      const remaining = JSON.parse(writeCall.args[1]);
      expect(remaining).to.be.an("array").with.lengthOf(0);
    });

    it("applies exponential backoff on repeated failures", async function () {
      mockedOracleComponents.provider.getTransactionReceipt.rejects(
        new Error("RPC temporarily unavailable"),
      );

      const failedJobs = [
        {
          eventName: "PromptSubmitted",
          event: {
            args: ["0xUser", 1, 600, 601, "0x", "0xkey"],
            blockNumber: 8000,
            transactionHash: "0xbackofftx",
          },
          retryCount: 2,
          nextAttemptAt: 0,
        },
      ];

      stubs["fs/promises"].readFile
        .withArgs(sinon.match(/failed-jobs\.json$/), "utf-8")
        .resolves(JSON.stringify(failedJobs));

      await aiAgentOracle.retryFailedJobs();

      const writeCall = stubs["fs/promises"].writeFile
        .getCalls()
        .find((c) => c.args[0].includes("failed-jobs.json"));
      expect(writeCall).to.not.be.undefined;

      const remaining = JSON.parse(writeCall.args[1]);
      expect(remaining).to.have.lengthOf(1);
      expect(remaining[0].retryCount).to.equal(3);

      // Exponential backoff: base 30s * 2^3 = 240s
      const expectedDelay = 30000 * Math.pow(2, 3);
      const actualDelay = remaining[0].nextAttemptAt - Date.now();
      // Allow 5s tolerance for test execution time
      expect(actualDelay).to.be.closeTo(expectedDelay, 5000);
    });

    it("drops job and alerts after max retries exhausted", async function () {
      mockedOracleComponents.provider.getTransactionReceipt.rejects(
        new Error("Permanently broken RPC"),
      );

      const failedJobs = [
        {
          eventName: "PromptSubmitted",
          event: {
            args: ["0xUser", 1, 700, 701, "0x", "0xkey"],
            blockNumber: 9000,
            transactionHash: "0xmaxtx",
          },
          retryCount: 9, // Will become 10, hitting MAX_RETRIES
          nextAttemptAt: 0,
        },
      ];

      stubs["fs/promises"].readFile
        .withArgs(sinon.match(/failed-jobs\.json$/), "utf-8")
        .resolves(JSON.stringify(failedJobs));

      await aiAgentOracle.retryFailedJobs();

      // Job removed from queue (not added back)
      const writeCall = stubs["fs/promises"].writeFile
        .getCalls()
        .find((c) => c.args[0].includes("failed-jobs.json"));
      const remaining = JSON.parse(writeCall.args[1]);
      expect(remaining).to.have.lengthOf(0);

      // Alert sent for permanent failure
      expect(stubs["./alerting"].sendAlert.calledOnce).to.be.true;
      expect(stubs["./alerting"].sendAlert.firstCall.args[0]).to.include("CRITICAL");

      // Sentry captures the exception
      expect(stubs["@sentry/node"].captureException.calledOnce).to.be.true;
    });

    it("skips jobs that are not yet due for retry", async function () {
      const failedJobs = [
        {
          eventName: "PromptSubmitted",
          event: {
            args: ["0xUser", 1, 800, 801, "0x", "0xkey"],
            blockNumber: 9500,
            transactionHash: "0xnotyettx",
          },
          retryCount: 1,
          nextAttemptAt: Date.now() + 60000, // 1 minute in the future
        },
      ];

      stubs["fs/promises"].readFile
        .withArgs(sinon.match(/failed-jobs\.json$/), "utf-8")
        .resolves(JSON.stringify(failedJobs));

      await aiAgentOracle.retryFailedJobs();

      // No writes to failed-jobs.json (nothing processed)
      const writeCall = stubs["fs/promises"].writeFile
        .getCalls()
        .find((c) => c.args[0].includes("failed-jobs.json"));
      expect(writeCall).to.be.undefined;
    });
  });

  describe("Contract Revert Handling", function () {
    it("handles contract revert on submitAnswer gracefully", async function () {
      mockedOracleComponents.contract.submitAnswer.rejects(
        new Error("execution reverted: AnswerAlreadySubmitted"),
      );

      const clientPayload = {
        promptText: "Test contract revert",
        isNewConversation: true,
        previousMessageId: null,
        previousMessageCID: null,
      };
      const encryptedPayloadString = createEncryptedString(clientPayload, FAKE_SESSION_KEY);
      const payloadBytes = ethers.toUtf8Bytes(encryptedPayloadString);

      const fakeEvent = {
        blockNumber: 9800,
        transactionHash: "0xreverttx",
        args: ["0xUser", 1, 900, 901, payloadBytes, "0xkey"],
        getBlock: () => Promise.resolve({ timestamp: Math.floor(Date.now() / 1000) }),
      };

      // Should not throw — handleAndRecord catches it
      await aiAgentOracle.handleAndRecord(
        "PromptSubmitted",
        aiAgentOracle.handlePrompt,
        "0xUser",
        1,
        900,
        901,
        payloadBytes,
        "0xkey",
        fakeEvent,
      );

      // Contract revert is classified as non-retryable → alert sent
      expect(stubs["./alerting"].sendAlert.calledOnce).to.be.true;
    });
  });

  describe("Network Timeout During Storage", function () {
    it("queues ETIMEDOUT storage errors as retryable", async function () {
      stubs["./storage/storage"].uploadData.rejects(
        new Error("ETIMEDOUT: connection timed out to storage node"),
      );

      const clientPayload = {
        promptText: "Test network timeout",
        isNewConversation: true,
        previousMessageId: null,
        previousMessageCID: null,
      };
      const encryptedPayloadString = createEncryptedString(clientPayload, FAKE_SESSION_KEY);
      const payloadBytes = ethers.toUtf8Bytes(encryptedPayloadString);

      const fakeEvent = {
        blockNumber: 9900,
        transactionHash: "0xtimeouttx",
        args: ["0xUser", 1, 950, 951, payloadBytes, "0xkey"],
        getBlock: () => Promise.resolve({ timestamp: Math.floor(Date.now() / 1000) }),
      };

      await aiAgentOracle.handleAndRecord(
        "PromptSubmitted",
        aiAgentOracle.handlePrompt,
        "0xUser",
        1,
        950,
        951,
        payloadBytes,
        "0xkey",
        fakeEvent,
      );

      // ETIMEDOUT is retryable → queued to failed-jobs
      const failedJobsWrite = stubs["fs/promises"].writeFile
        .getCalls()
        .find((c) => c.args[0].includes("failed-jobs.json"));
      expect(failedJobsWrite).to.not.be.undefined;

      const jobs = JSON.parse(failedJobsWrite.args[1]);
      expect(jobs).to.have.lengthOf(1);
      expect(jobs[0].eventName).to.equal("PromptSubmitted");
    });
  });

  describe("Empty/Corrupt Failed Jobs File", function () {
    it("handles empty object in failed-jobs.json gracefully", async function () {
      stubs["fs/promises"].readFile
        .withArgs(sinon.match(/failed-jobs\.json$/), "utf-8")
        .resolves("{}");

      // Should not throw
      await aiAgentOracle.retryFailedJobs();

      // No writes needed (nothing to process)
      const writeCall = stubs["fs/promises"].writeFile
        .getCalls()
        .find((c) => c.args[0].includes("failed-jobs.json"));
      expect(writeCall).to.be.undefined;
    });

    it("handles missing failed-jobs.json gracefully", async function () {
      stubs["fs/promises"].readFile
        .withArgs(sinon.match(/failed-jobs\.json$/), "utf-8")
        .rejects(new Error("ENOENT: no such file or directory"));

      // Should not throw
      await aiAgentOracle.retryFailedJobs();
    });
  });
});
