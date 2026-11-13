const { expect } = require("chai");
const sinon = require("sinon");
const crypto = require("crypto");
const { ethers } = require("ethers");
const {
  createEncryptedString,
  setupOracleTestEnv,
  cleanupOracleTestEnv,
  makeFakeEvent,
  txHash,
} = require("./helpers");
const { failJobAttempts } = require("../helpers/tempStateStore");

describe("E2E: Error Recovery", function () {
  let aiAgentOracle;
  let stubs;
  let mockedOracleComponents;
  let stateStore;
  let stateFiles;
  // The state store's clock. Frozen per test so "not due yet" and backoff delays are exact.
  let clock;
  const SESSION_KEY = crypto.randomBytes(32);
  const BASE_RETRY_DELAY_MS = 30 * 1000;
  const CONTRACT_TARGET = "0xMockedContractAddress";

  beforeEach(() => {
    clock = { ms: Date.parse("2026-11-12T00:00:00Z") };
    ({ aiAgentOracle, stubs, mockedOracleComponents, stateStore, stateFiles } = setupOracleTestEnv(
      SESSION_KEY,
      { now: () => new Date(clock.ms) },
    ));
  });

  afterEach(() => {
    cleanupOracleTestEnv();
  });

  /** Every due job, without holding it (a zero lease leaves it due for the next claim). */
  const dueJobs = () => stateStore.claimDueJobs({ limit: 100, leaseMs: 0 });

  /** Queue a failed PromptSubmitted the way handleAndRecord does, due now. */
  const seedJob = (tx, blockNumber, overrides = {}) =>
    stateStore.enqueueFailedJob({
      transactionHash: tx,
      logIndex: 0,
      eventName: "PromptSubmitted",
      blockNumber,
      delayMs: 0,
      ...overrides,
    });

  describe("Storage Upload Failure → Retry Queue", function () {
    it("queues Autonomys failures with blockNumber, txHash, log index and attempts=0", async function () {
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
      const tx = txHash("autonomys");
      const fakeEvent = makeFakeEvent(7000, {
        transactionHash: tx,
        index: 4,
        args: ["0xUser", 1, 400, 401, payloadBytes, "0xkey"],
      });

      await aiAgentOracle.handleAndRecord(
        "PromptSubmitted", aiAgentOracle.handlePrompt,
        "0xUser", 1, 400, 401, payloadBytes, "0xkey",
        fakeEvent,
      );

      expect(await stateStore.countFailedJobs()).to.deep.equal({ pending: 1, exhausted: 0 });

      // Queued for LATER, not for the very next tick: nothing is due until the base delay passes.
      expect(await dueJobs(), "the first retry waits the base delay").to.deep.equal([]);
      clock.ms += BASE_RETRY_DELAY_MS;

      const jobs = await dueJobs();
      expect(jobs).to.have.lengthOf(1);
      expect(jobs[0]).to.deep.include({
        eventName: "PromptSubmitted",
        attempts: 0,
        blockNumber: 7000,
        transactionHash: tx,
        logIndex: 4,
      });
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
        args: ["0xUser", 1, 402, 403, payloadBytes, "0xkey"],
      });

      await aiAgentOracle.handleAndRecord(
        "PromptSubmitted", aiAgentOracle.handlePrompt,
        "0xUser", 1, 402, 403, payloadBytes, "0xkey",
        fakeEvent,
      );

      expect(
        await stateStore.countFailedJobs(),
        "Irys failure should be queued",
      ).to.deep.equal({ pending: 1, exhausted: 0 });
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
        args: ["0xUser", 1, 404, 405, payloadBytes, "0xkey"],
      });

      await aiAgentOracle.handleAndRecord(
        "PromptSubmitted", aiAgentOracle.handlePrompt,
        "0xUser", 1, 404, 405, payloadBytes, "0xkey",
        fakeEvent,
      );

      clock.ms += BASE_RETRY_DELAY_MS;
      const jobs = await dueJobs();
      expect(jobs, "ETIMEDOUT should be queued").to.have.lengthOf(1);
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

      const tx = txHash("retry");
      const fakeReceipt = {
        blockNumber: 7000,
        logs: [{
          address: CONTRACT_TARGET,
          index: 0,
          transactionHash: tx,
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

      await seedJob(tx, 7000);

      await aiAgentOracle.retryFailedJobs();

      expect(mockedOracleComponents.provider.getTransactionReceipt.calledOnceWith(tx)).to.be.true;
      expect(await stateStore.countFailedJobs()).to.deep.equal({ pending: 0, exhausted: 0 });
    });

    describe("finding the event again", function () {
      const promptArgs = () => {
        const payloadBytes = ethers.toUtf8Bytes(
          createEncryptedString(
            { promptText: "Retryable", isNewConversation: true, previousMessageId: null, previousMessageCID: null },
            SESSION_KEY,
          ),
        );
        return ["0xUser", 1, 500, 501, payloadBytes, "0xkey"];
      };
      const log = (tx, index, topic = "0xprompt") => ({
        address: CONTRACT_TARGET,
        index,
        transactionHash: tx,
        topics: [topic],
        data: "0x",
      });

      beforeEach(() => {
        // Idempotency: the handler finds the job already finalized and returns early.
        mockedOracleComponents.contract.isJobFinalized.resolves(true);
      });

      it("still finds the event after a reorg moved the transaction to another log position", async function () {
        // A log's index is its position in the BLOCK. A reorg that re-includes the transaction
        // elsewhere changes it, and a retry that insisted on the old index would fail every
        // attempt and give the prompt up as exhausted.
        const tx = txHash("reorged");
        mockedOracleComponents.provider.getTransactionReceipt.resolves({
          blockNumber: 7003,
          logs: [log(tx, 41, "0xother"), log(tx, 42)],
        });
        mockedOracleComponents.contract.interface.parseLog.callsFake((l) =>
          l.topics[0] === "0xprompt"
            ? { name: "PromptSubmitted", args: promptArgs() }
            : { name: "Transfer", args: [] },
        );
        await seedJob(tx, 7000, { logIndex: 5 });

        await aiAgentOracle.retryFailedJobs();

        expect(await stateStore.countFailedJobs()).to.deep.equal({ pending: 0, exhausted: 0 });
        expect(stubs["./alerting"].sendAlert.called).to.be.false;
      });

      it("refuses to guess between two events of the same name when neither is at the stored position", async function () {
        const tx = txHash("ambiguous");
        mockedOracleComponents.provider.getTransactionReceipt.resolves({
          blockNumber: 7003,
          logs: [log(tx, 41), log(tx, 42)],
        });
        mockedOracleComponents.contract.interface.parseLog.returns({
          name: "PromptSubmitted",
          args: promptArgs(),
        });
        await seedJob(tx, 7000, { logIndex: 5 });

        await aiAgentOracle.retryFailedJobs();

        clock.ms += 24 * 60 * 60 * 1000;
        const [job] = await dueJobs();
        expect(job.attempts).to.equal(1);
        expect(job.lastError).to.match(/more than one/i);
      });

      it("says why a log could not be parsed", async function () {
        const tx = txHash("stale-abi");
        mockedOracleComponents.provider.getTransactionReceipt.resolves({
          blockNumber: 7000,
          logs: [log(tx, 0)],
        });
        mockedOracleComponents.contract.interface.parseLog.throws(new Error("no matching event (stale ABI)"));
        await seedJob(tx, 7000);

        await aiAgentOracle.retryFailedJobs();

        clock.ms += 24 * 60 * 60 * 1000;
        const [job] = await dueJobs();
        expect(job.lastError).to.include("stale ABI");
      });
    });

    describe("outcomes that cannot be recorded", function () {
      const answeredReceipt = (tx) => {
        const payloadBytes = ethers.toUtf8Bytes(
          createEncryptedString(
            { promptText: "Retryable", isNewConversation: true, previousMessageId: null, previousMessageCID: null },
            SESSION_KEY,
          ),
        );
        mockedOracleComponents.contract.isJobFinalized.resolves(true);
        mockedOracleComponents.provider.getTransactionReceipt.resolves({
          blockNumber: 7000,
          logs: [{ address: CONTRACT_TARGET, index: 0, transactionHash: tx, topics: ["0x"], data: "0x" }],
        });
        mockedOracleComponents.contract.interface.parseLog.returns({
          name: "PromptSubmitted",
          args: ["0xUser", 1, 500, 501, payloadBytes, "0xkey"],
        });
      };

      it("does not count a retry that worked as a failed attempt when the job could not be removed", async function () {
        // Counting it would walk a job that keeps being answered towards a false
        // "failed permanently" alert.
        const tx = txHash("answered-not-removed");
        answeredReceipt(tx);
        await seedJob(tx, 7000);
        sinon.stub(stateStore, "completeJob").rejects(new Error("database unavailable"));
        const reschedule = sinon.spy(stateStore, "rescheduleJob");
        const exhaust = sinon.spy(stateStore, "exhaustJob");

        await aiAgentOracle.retryFailedJobs();

        expect(reschedule.called, "must not be rescheduled as a failure").to.be.false;
        expect(exhaust.called).to.be.false;
        expect(stubs["@sentry/node"].captureException.called).to.be.true;
      });

      it("does not start a second pass while one is still running", async function () {
        // The timer fires every minute; a pass can take longer. An overlapping pass would claim
        // the jobs whose lease ran out while they waited their turn, and run them twice.
        const tx = txHash("slow-pass");
        answeredReceipt(tx);
        await seedJob(tx, 7000);
        let releaseReceipt;
        mockedOracleComponents.provider.getTransactionReceipt.callsFake(
          () =>
            new Promise((resolve) => {
              releaseReceipt = () =>
                resolve({
                  blockNumber: 7000,
                  logs: [{ address: CONTRACT_TARGET, index: 0, transactionHash: tx, topics: ["0x"], data: "0x" }],
                });
            }),
        );
        const claim = sinon.spy(stateStore, "claimDueJobs");

        const firstPass = aiAgentOracle.retryFailedJobs();
        // Wait until the first pass is really holding its job (it has asked for the receipt),
        // rather than for some number of ticks: file I/O takes as long as it takes.
        while (!releaseReceipt) await new Promise((resolve) => setImmediate(resolve));
        const claimsBefore = claim.callCount;
        await aiAgentOracle.retryFailedJobs();

        expect(claim.callCount, "the overlapping pass must not touch the queue").to.equal(claimsBefore);

        releaseReceipt();
        await firstPass;
        expect(await stateStore.countFailedJobs()).to.deep.equal({ pending: 0, exhausted: 0 });
      });

      it("claims one job at a time, so each job's lease starts when its own retry does", async function () {
        const first = txHash("first");
        const second = txHash("second");
        answeredReceipt(first);
        await seedJob(first, 7000);
        await seedJob(second, 7001);
        const claim = sinon.spy(stateStore, "claimDueJobs");

        await aiAgentOracle.retryFailedJobs();

        expect(claim.getCalls().every((call) => call.args[0].limit === 1)).to.be.true;
        expect(await stateStore.countFailedJobs()).to.deep.equal({ pending: 0, exhausted: 0 });
      });
    });

    it("increments attempts and applies exponential backoff on failure", async function () {
      mockedOracleComponents.provider.getTransactionReceipt.rejects(
        new Error("RPC temporarily unavailable"),
      );

      await seedJob(txHash("backoff"), 8000);
      await failJobAttempts(stateStore, 2);

      await aiAgentOracle.retryFailedJobs();

      expect(await stateStore.countFailedJobs()).to.deep.equal({ pending: 1, exhausted: 0 });

      // base 30s * 2^3 = 240s — exact, because the store's clock is frozen
      const expectedDelay = BASE_RETRY_DELAY_MS * Math.pow(2, 3);
      clock.ms += expectedDelay - 1;
      expect(await dueJobs(), "not due a millisecond early").to.deep.equal([]);
      clock.ms += 1;
      const [job] = await dueJobs();
      expect(job.attempts).to.equal(3);
      expect(job.lastError).to.include("RPC temporarily unavailable");
    });

    it("keeps the job as exhausted and sends CRITICAL alert after 10 retries", async function () {
      mockedOracleComponents.provider.getTransactionReceipt.rejects(
        new Error("Permanently broken RPC"),
      );

      await seedJob(txHash("max"), 9000);
      await failJobAttempts(stateStore, 9);

      await aiAgentOracle.retryFailedJobs();

      // Kept on record for a person to look at — no longer dropped — but never handed out again.
      expect(await stateStore.countFailedJobs()).to.deep.equal({ pending: 0, exhausted: 1 });
      clock.ms += 365 * 24 * 60 * 60 * 1000;
      expect(await dueJobs(), "an exhausted job is never retried").to.deep.equal([]);

      expect(stubs["./alerting"].sendAlert.calledOnce).to.be.true;
      expect(stubs["./alerting"].sendAlert.firstCall.args[0]).to.include("CRITICAL");
      expect(stubs["@sentry/node"].captureException.calledOnce).to.be.true;
    });

    it("leaves jobs in queue that are not yet due for retry", async function () {
      await seedJob(txHash("notyet"), 9500, { delayMs: 60000 });

      await aiAgentOracle.retryFailedJobs();

      // Nothing was attempted, and the job is untouched
      expect(mockedOracleComponents.provider.getTransactionReceipt.called).to.be.false;
      clock.ms += 60000;
      const jobs = await dueJobs();
      expect(jobs).to.have.lengthOf(1);
      expect(jobs[0].attempts).to.equal(0);
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
        args: ["0xUser", 1, 900, 901, payloadBytes, "0xkey"],
      });

      await aiAgentOracle.handleAndRecord(
        "PromptSubmitted", aiAgentOracle.handlePrompt,
        "0xUser", 1, 900, 901, payloadBytes, "0xkey",
        fakeEvent,
      );

      expect(stubs["./alerting"].sendAlert.calledOnce).to.be.true;

      // Not queued to retry
      expect(await stateStore.countFailedJobs()).to.deep.equal({ pending: 0, exhausted: 0 });
    });
  });

  // The file backend is still what localnet and e2e run on, and it reads a file other processes
  // (or an older oracle version) may have left in any state.
  describe("Failed Jobs File Resilience", function () {
    const fs = require("node:fs");

    async function expectNoRetryAttempted() {
      await aiAgentOracle.retryFailedJobs();
      expect(mockedOracleComponents.provider.getTransactionReceipt.called).to.be.false;
      expect(await stateStore.countFailedJobs()).to.deep.equal({ pending: 0, exhausted: 0 });
    }

    it("treats empty object {} in failed-jobs.json as no jobs", async function () {
      fs.writeFileSync(stateFiles.jobsPath, "{}");
      await expectNoRetryAttempted();
    });

    it("handles missing failed-jobs.json without throwing", async function () {
      expect(fs.existsSync(stateFiles.jobsPath)).to.be.false;
      await expectNoRetryAttempted();
    });

    it("handles corrupt JSON in failed-jobs.json without throwing", async function () {
      fs.writeFileSync(stateFiles.jobsPath, "{not valid json!!!");
      await expectNoRetryAttempted();
    });

    it("ignores entries in the old pre-store format rather than retrying them blind", async function () {
      // The previous oracle wrote `{ eventName, event: {...}, retryCount, nextAttemptAt }` with
      // no log index, which the retry can no longer pin to one log in the receipt.
      fs.writeFileSync(
        stateFiles.jobsPath,
        JSON.stringify([{
          eventName: "PromptSubmitted",
          event: { args: [], blockNumber: 9000, transactionHash: txHash("legacy") },
          retryCount: 0,
          nextAttemptAt: 0,
        }]),
      );
      await expectNoRetryAttempted();
    });

    it("does not throw when the queue cannot be read at all", async function () {
      aiAgentOracle.initForTest({
        ...mockedOracleComponents,
        stateStore: { ...stateStore, claimDueJobs: sinon.stub().rejects(new Error("db down")) },
      });

      await aiAgentOracle.retryFailedJobs();

      expect(mockedOracleComponents.provider.getTransactionReceipt.called).to.be.false;
    });
  });
});
