const { expect } = require("chai");
const sinon = require("sinon");
const crypto = require("crypto");
const { ethers } = require("ethers");
const {
  createEncryptedString,
  setupOracleTestEnv,
  cleanupOracleTestEnv,
  makeFakeEvent,
} = require("./helpers");

describe("E2E: Error Recovery", function () {
  let aiAgentOracle;
  let stubs;
  let mockedOracleComponents;
  const SESSION_KEY = crypto.randomBytes(32);

  beforeEach(() => {
    ({ aiAgentOracle, stubs, mockedOracleComponents } = setupOracleTestEnv(SESSION_KEY));
  });

  afterEach(() => {
    cleanupOracleTestEnv();
  });

  describe("Storage Upload Failure → Retry Queue", function () {
    it("queues Autonomys failures with blockNumber, txHash, and retryCount=0", async function () {
      stubs["./storage/storage"].uploadData.rejects(
        new Error("Autonomys network unreachable"),
      );

      const clientPayload = {
        promptText: "Test Autonomys failure",
        isNewConversation: true,
        previousMessageId: null,
        previousMessageCID: null,
      };
      const payloadBytes = ethers.toUtf8Bytes(createEncryptedString(clientPayload, SESSION_KEY));
      const fakeEvent = makeFakeEvent(7000, {
        transactionHash: "0xautonomystx",
        args: ["0xUser", 1, 400, 401, payloadBytes, "0xkey"],
      });

      await aiAgentOracle.handleAndRecord(
        "PromptSubmitted", aiAgentOracle.handlePrompt,
        "0xUser", 1, 400, 401, payloadBytes, "0xkey",
        fakeEvent,
      );

      const failedJobsWrite = stubs["fs/promises"].writeFile
        .getCalls()
        .find((c) => c.args[0].includes("failed-jobs.json"));
      expect(failedJobsWrite, "failed-jobs.json should be written").to.not.be.undefined;

      const jobs = JSON.parse(failedJobsWrite.args[1]);
      expect(jobs).to.have.lengthOf(1);
      expect(jobs[0]).to.deep.include({
        eventName: "PromptSubmitted",
        retryCount: 0,
      });
      expect(jobs[0].event.blockNumber).to.equal(7000);
      expect(jobs[0].event.transactionHash).to.equal("0xautonomystx");
      expect(jobs[0].nextAttemptAt).to.be.a("number");
      expect(jobs[0].nextAttemptAt).to.be.greaterThan(Date.now());
    });

    it("queues Irys 502 errors as retryable", async function () {
      stubs["./storage/storage"].uploadData.rejects(
        new Error("Irys upload failed: 502 Bad Gateway"),
      );

      const payloadBytes = ethers.toUtf8Bytes(
        createEncryptedString(
          { promptText: "Test Irys", isNewConversation: true, previousMessageId: null, previousMessageCID: null },
          SESSION_KEY,
        ),
      );
      const fakeEvent = makeFakeEvent(7001, {
        transactionHash: "0xirystx",
        args: ["0xUser", 1, 402, 403, payloadBytes, "0xkey"],
      });

      await aiAgentOracle.handleAndRecord(
        "PromptSubmitted", aiAgentOracle.handlePrompt,
        "0xUser", 1, 402, 403, payloadBytes, "0xkey",
        fakeEvent,
      );

      const failedJobsWrite = stubs["fs/promises"].writeFile
        .getCalls()
        .find((c) => c.args[0].includes("failed-jobs.json"));
      expect(failedJobsWrite, "Irys failure should be queued").to.not.be.undefined;
    });

    it("queues ETIMEDOUT storage errors as retryable", async function () {
      stubs["./storage/storage"].uploadData.rejects(
        new Error("ETIMEDOUT: connection timed out to storage node"),
      );

      const payloadBytes = ethers.toUtf8Bytes(
        createEncryptedString(
          { promptText: "Test timeout", isNewConversation: true, previousMessageId: null, previousMessageCID: null },
          SESSION_KEY,
        ),
      );
      const fakeEvent = makeFakeEvent(7002, {
        transactionHash: "0xtimeouttx",
        args: ["0xUser", 1, 404, 405, payloadBytes, "0xkey"],
      });

      await aiAgentOracle.handleAndRecord(
        "PromptSubmitted", aiAgentOracle.handlePrompt,
        "0xUser", 1, 404, 405, payloadBytes, "0xkey",
        fakeEvent,
      );

      const failedJobsWrite = stubs["fs/promises"].writeFile
        .getCalls()
        .find((c) => c.args[0].includes("failed-jobs.json"));
      expect(failedJobsWrite, "ETIMEDOUT should be queued").to.not.be.undefined;

      const jobs = JSON.parse(failedJobsWrite.args[1]);
      expect(jobs[0].eventName).to.equal("PromptSubmitted");
    });
  });

  describe("Retry Mechanism", function () {
    it("removes a job from the queue after successful retry", async function () {
      // Idempotency: on retry, the handler finds the job already finalized and returns early
      mockedOracleComponents.contract.isJobFinalized.resolves(true);

      const payloadBytes = ethers.toUtf8Bytes(
        createEncryptedString(
          { promptText: "Retryable", isNewConversation: true, previousMessageId: null, previousMessageCID: null },
          SESSION_KEY,
        ),
      );

      const fakeReceipt = {
        blockNumber: 7000,
        logs: [{
          address: "0xMockedContractAddress",
          transactionHash: "0xretrytx",
          topics: ["0xfaketopic"],
          data: "0x",
        }],
      };
      mockedOracleComponents.provider.getTransactionReceipt.resolves(fakeReceipt);

      const fakeArgs = ["0xUser", 1, 500, 501, payloadBytes, "0xkey"];
      mockedOracleComponents.contract.interface.parseLog.returns({
        name: "PromptSubmitted",
        args: fakeArgs,
      });

      const failedJobs = [{
        eventName: "PromptSubmitted",
        event: {
          args: fakeArgs.map((a) => (typeof a === "object" ? "0x" : a)),
          blockNumber: 7000,
          transactionHash: "0xretrytx",
        },
        retryCount: 0,
        nextAttemptAt: 0,
      }];

      stubs["fs/promises"].readFile
        .withArgs(sinon.match(/failed-jobs\.json$/), "utf-8")
        .resolves(JSON.stringify(failedJobs));

      await aiAgentOracle.retryFailedJobs();

      const writeCall = stubs["fs/promises"].writeFile
        .getCalls()
        .find((c) => c.args[0].includes("failed-jobs.json"));
      expect(writeCall, "failed-jobs.json should be rewritten").to.not.be.undefined;

      const remaining = JSON.parse(writeCall.args[1]);
      expect(remaining).to.be.an("array").with.lengthOf(0);
    });

    it("increments retryCount and applies exponential backoff on failure", async function () {
      const clock = sinon.useFakeTimers(Date.now());

      mockedOracleComponents.provider.getTransactionReceipt.rejects(
        new Error("RPC temporarily unavailable"),
      );

      const failedJobs = [{
        eventName: "PromptSubmitted",
        event: {
          args: ["0xUser", 1, 600, 601, "0x", "0xkey"],
          blockNumber: 8000,
          transactionHash: "0xbackofftx",
        },
        retryCount: 2,
        nextAttemptAt: 0,
      }];

      stubs["fs/promises"].readFile
        .withArgs(sinon.match(/failed-jobs\.json$/), "utf-8")
        .resolves(JSON.stringify(failedJobs));

      await aiAgentOracle.retryFailedJobs();

      const writeCall = stubs["fs/promises"].writeFile
        .getCalls()
        .find((c) => c.args[0].includes("failed-jobs.json"));
      const remaining = JSON.parse(writeCall.args[1]);
      expect(remaining).to.have.lengthOf(1);
      expect(remaining[0].retryCount).to.equal(3);

      // base 30s * 2^3 = 240s = 240000ms — deterministic with frozen clock
      const expectedDelay = 30000 * Math.pow(2, 3);
      expect(remaining[0].nextAttemptAt).to.equal(clock.now + expectedDelay);

      clock.restore();
    });

    it("drops job and sends CRITICAL alert after 10 retries exhausted", async function () {
      mockedOracleComponents.provider.getTransactionReceipt.rejects(
        new Error("Permanently broken RPC"),
      );

      const failedJobs = [{
        eventName: "PromptSubmitted",
        event: {
          args: ["0xUser", 1, 700, 701, "0x", "0xkey"],
          blockNumber: 9000,
          transactionHash: "0xmaxtx",
        },
        retryCount: 9,
        nextAttemptAt: 0,
      }];

      stubs["fs/promises"].readFile
        .withArgs(sinon.match(/failed-jobs\.json$/), "utf-8")
        .resolves(JSON.stringify(failedJobs));

      await aiAgentOracle.retryFailedJobs();

      const writeCall = stubs["fs/promises"].writeFile
        .getCalls()
        .find((c) => c.args[0].includes("failed-jobs.json"));
      const remaining = JSON.parse(writeCall.args[1]);
      expect(remaining).to.have.lengthOf(0);

      expect(stubs["./alerting"].sendAlert.calledOnce).to.be.true;
      expect(stubs["./alerting"].sendAlert.firstCall.args[0]).to.include("CRITICAL");
      expect(stubs["@sentry/node"].captureException.calledOnce).to.be.true;
    });

    it("leaves jobs in queue that are not yet due for retry", async function () {
      const failedJobs = [{
        eventName: "PromptSubmitted",
        event: {
          args: ["0xUser", 1, 800, 801, "0x", "0xkey"],
          blockNumber: 9500,
          transactionHash: "0xnotyettx",
        },
        retryCount: 1,
        nextAttemptAt: Date.now() + 60000,
      }];

      stubs["fs/promises"].readFile
        .withArgs(sinon.match(/failed-jobs\.json$/), "utf-8")
        .resolves(JSON.stringify(failedJobs));

      await aiAgentOracle.retryFailedJobs();

      // No writes — nothing was processed
      const writeCall = stubs["fs/promises"].writeFile
        .getCalls()
        .find((c) => c.args[0].includes("failed-jobs.json"));
      expect(writeCall).to.be.undefined;
    });
  });

  describe("Contract Revert Handling", function () {
    it("classifies contract reverts as non-retryable and alerts", async function () {
      mockedOracleComponents.contract.submitAnswer.rejects(
        new Error("execution reverted: AnswerAlreadySubmitted"),
      );

      const payloadBytes = ethers.toUtf8Bytes(
        createEncryptedString(
          { promptText: "Test revert", isNewConversation: true, previousMessageId: null, previousMessageCID: null },
          SESSION_KEY,
        ),
      );
      const fakeEvent = makeFakeEvent(9800, {
        transactionHash: "0xreverttx",
        args: ["0xUser", 1, 900, 901, payloadBytes, "0xkey"],
      });

      await aiAgentOracle.handleAndRecord(
        "PromptSubmitted", aiAgentOracle.handlePrompt,
        "0xUser", 1, 900, 901, payloadBytes, "0xkey",
        fakeEvent,
      );

      expect(stubs["./alerting"].sendAlert.calledOnce).to.be.true;

      // Not queued to retry
      const failedJobsWrite = stubs["fs/promises"].writeFile
        .getCalls()
        .find((c) => c.args[0].includes("failed-jobs.json"));
      expect(failedJobsWrite).to.be.undefined;
    });
  });

  describe("Failed Jobs File Resilience", function () {
    it("treats empty object {} in failed-jobs.json as no jobs", async function () {
      stubs["fs/promises"].readFile
        .withArgs(sinon.match(/failed-jobs\.json$/), "utf-8")
        .resolves("{}");

      await aiAgentOracle.retryFailedJobs();

      const writeCall = stubs["fs/promises"].writeFile
        .getCalls()
        .find((c) => c.args[0].includes("failed-jobs.json"));
      expect(writeCall).to.be.undefined;
    });

    it("handles missing failed-jobs.json without throwing", async function () {
      stubs["fs/promises"].readFile
        .withArgs(sinon.match(/failed-jobs\.json$/), "utf-8")
        .rejects(new Error("ENOENT: no such file or directory"));

      await aiAgentOracle.retryFailedJobs();
      // No assertion needed — test passes if no exception thrown
    });

    it("handles corrupt JSON in failed-jobs.json without throwing", async function () {
      stubs["fs/promises"].readFile
        .withArgs(sinon.match(/failed-jobs\.json$/), "utf-8")
        .resolves("{not valid json!!!");

      await aiAgentOracle.retryFailedJobs();
    });
  });
});
