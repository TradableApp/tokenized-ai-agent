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

describe("E2E: Oracle Event Listener", function () {
  let aiAgentOracle;
  let stubs;
  let mockedOracleComponents;
  let stateStore;
  // The state store's clock, so a queued job's backoff can be stepped over exactly.
  let clock;
  const SESSION_KEY = crypto.randomBytes(32);

  beforeEach(() => {
    clock = { ms: Date.now() };
    ({ aiAgentOracle, stubs, mockedOracleComponents, stateStore } = setupOracleTestEnv(
      SESSION_KEY,
      { now: () => new Date(clock.ms) },
    ));
  });

  afterEach(() => {
    cleanupOracleTestEnv();
  });

  describe("Full Prompt → Answer Pipeline", function () {
    it("new conversation: decrypts payload, queries AI, uploads 6 files, and submits answer on-chain", async function () {
      const clientPayload = {
        promptText: "What is the price of ETH?",
        isNewConversation: true,
        previousMessageId: null,
        previousMessageCID: null,
      };
      const payloadBytes = ethers.toUtf8Bytes(createEncryptedString(clientPayload, SESSION_KEY));

      await aiAgentOracle.handlePrompt(
        "0xUser1", 1, 100, 101,
        payloadBytes, "0xencryptedkey",
        makeFakeEvent(5000),
      );

      // 6 uploads: Key, Conversation, Metadata, Prompt, Search, Answer
      expect(stubs["./storage/storage"].uploadData.callCount).to.equal(6);

      const contract = mockedOracleComponents.contract;
      expect(contract.submitAnswer.calledOnce).to.be.true;

      const [submittedPromptId, submittedAnswerId, cids] = contract.submitAnswer.firstCall.args;
      expect(submittedPromptId).to.equal(100);
      expect(submittedAnswerId).to.equal(101);
      expect(cids.conversationCID).to.match(/^fake_cid_/);
      expect(cids.metadataCID).to.match(/^fake_cid_/);
      expect(cids.promptMessageCID).to.match(/^fake_cid_/);
      expect(cids.answerMessageCID).to.match(/^fake_cid_/);
      expect(cids.searchDeltaCID).to.match(/^fake_cid_/);
    });

    it("existing conversation: uploads only 3 files (Prompt, Search, Answer)", async function () {
      const clientPayload = {
        promptText: "Follow up about gas fees",
        isNewConversation: false,
        previousMessageId: "msg_101",
        previousMessageCID: "fake_cid_prev",
      };
      const payloadBytes = ethers.toUtf8Bytes(createEncryptedString(clientPayload, SESSION_KEY));

      await aiAgentOracle.handlePrompt(
        "0xUser1", 1, 102, 103,
        payloadBytes, "0xencryptedkey",
        makeFakeEvent(5001),
      );

      expect(stubs["./storage/storage"].uploadData.callCount).to.equal(3);
      expect(mockedOracleComponents.contract.submitAnswer.calledOnce).to.be.true;
    });

    it("skips already-finalized prompts without uploading or submitting", async function () {
      mockedOracleComponents.contract.isJobFinalized.resolves(true);

      const clientPayload = {
        promptText: "Should be skipped",
        isNewConversation: true,
        previousMessageId: null,
        previousMessageCID: null,
      };
      const payloadBytes = ethers.toUtf8Bytes(createEncryptedString(clientPayload, SESSION_KEY));

      await aiAgentOracle.handlePrompt(
        "0xUser1", 1, 200, 201,
        payloadBytes, "0xkey",
        makeFakeEvent(5002),
      );

      expect(stubs["./storage/storage"].uploadData.callCount).to.equal(0);
      expect(mockedOracleComponents.contract.submitAnswer.called).to.be.false;
    });
  });

  describe("handleAndRecord Error Classification", function () {
    it("drops malformed payloads silently, leaving the checkpoint to the batch", async function () {
      const malformedPayload = ethers.toUtf8Bytes("not-encrypted-at-all");
      const fakeEvent = makeFakeEvent(6000, {
        args: ["0xUser", 1, 300, 301, malformedPayload, "0xkey"],
      });

      await aiAgentOracle.handleAndRecord(
        "PromptSubmitted", aiAgentOracle.handlePrompt,
        "0xUser", 1, 300, 301, malformedPayload, "0xkey",
        fakeEvent,
      );

      // One event never moves the checkpoint: only the scan that owns the whole batch does.
      expect(await stateStore.loadCursor()).to.equal(null);
      expect(aiAgentOracle.getLastProcessedBlock()).to.equal(null);

      // No retry queue entry
      expect(await stateStore.countFailedJobs()).to.deep.equal({ pending: 0, exhausted: 0 });

      // No alert sent for malformed payloads
      expect(stubs["./alerting"].sendAlert.called).to.be.false;
    });

    it("queues retryable Autonomys storage errors with correct metadata", async function () {
      stubs["./storage/storage"].uploadData.rejects(new Error("Autonomys upload timeout"));

      const clientPayload = {
        promptText: "Test storage failure",
        isNewConversation: true,
        previousMessageId: null,
        previousMessageCID: null,
      };
      const payloadBytes = ethers.toUtf8Bytes(createEncryptedString(clientPayload, SESSION_KEY));
      const tx = txHash("storage-failure");
      const fakeEvent = makeFakeEvent(6001, {
        transactionHash: tx,
        index: 2,
        args: ["0xUser", 1, 302, 303, payloadBytes, "0xkey"],
      });

      await aiAgentOracle.handleAndRecord(
        "PromptSubmitted", aiAgentOracle.handlePrompt,
        "0xUser", 1, 302, 303, payloadBytes, "0xkey",
        fakeEvent,
      );

      expect(await stateStore.countFailedJobs()).to.deep.equal({ pending: 1, exhausted: 0 });

      // Not due until the base backoff has passed; then it reads back as a pointer to the event
      // (the retry re-reads the receipt), never a copy of its args.
      expect(await stateStore.claimDueJobs({ limit: 10, leaseMs: 0 })).to.deep.equal([]);
      clock.ms += 30 * 1000;
      const jobs = await stateStore.claimDueJobs({ limit: 10, leaseMs: 0 });
      expect(jobs).to.have.lengthOf(1);
      expect(jobs[0]).to.deep.include({
        eventName: "PromptSubmitted",
        attempts: 0,
        blockNumber: 6001,
        transactionHash: tx,
        logIndex: 2,
      });
      expect(jobs[0]).to.not.have.property("args");

      // The checkpoint is the batch's to move, once every event in it is handled or queued.
      expect(await stateStore.loadCursor()).to.equal(null);
    });

    it("sends CRITICAL alert and captures Sentry exception for non-retryable errors", async function () {
      stubs["./storage/storage"].uploadData.rejects(
        new Error("Completely unexpected failure"),
      );

      const clientPayload = {
        promptText: "Test fatal failure",
        isNewConversation: true,
        previousMessageId: null,
        previousMessageCID: null,
      };
      const payloadBytes = ethers.toUtf8Bytes(createEncryptedString(clientPayload, SESSION_KEY));
      const fakeEvent = makeFakeEvent(6002, {
        args: ["0xUser", 1, 304, 305, payloadBytes, "0xkey"],
      });

      await aiAgentOracle.handleAndRecord(
        "PromptSubmitted", aiAgentOracle.handlePrompt,
        "0xUser", 1, 304, 305, payloadBytes, "0xkey",
        fakeEvent,
      );

      expect(stubs["./alerting"].sendAlert.calledOnce).to.be.true;
      expect(stubs["./alerting"].sendAlert.firstCall.args[0]).to.include("CRITICAL");
      expect(stubs["@sentry/node"].captureException.called).to.be.true;
    });
  });

  describe("Checkpoint and events still in flight", function () {
    // Up to five events are handled at once and finish out of order. If one of them saved the
    // checkpoint as it finished, a crash would resume AFTER an earlier event that was still
    // being answered — and that prompt would never be answered.
    it("does not move the checkpoint past an event still being handled in the same batch", async function () {
      process.env.EVENT_BATCH_SIZE = "10000";
      const now = () => Promise.resolve({ timestamp: Math.floor(Date.now() / 1000) });
      let releaseSlowEvent;
      const slowEventStarted = new Promise((resolve) => {
        releaseSlowEvent = resolve;
      });
      const event = (blockNumber, getBlock) => ({
        eventName: "PromptSubmitted",
        blockNumber,
        transactionIndex: 0,
        index: 0,
        args: ["0xUser", 1, blockNumber, blockNumber + 1, "0x1234", "0xkey"],
        getBlock,
      });
      mockedOracleComponents.contract.queryFilter
        .onFirstCall()
        .resolves([event(1000, () => slowEventStarted.then(now)), event(1004, now)])
        .resolves([]);

      const scan = aiAgentOracle.processPastEvents(1000, 1004);
      // Give the fast event at block 1004 every chance to finish while block 1000 is held.
      for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve));

      expect(await stateStore.loadCursor(), "while block 1000 is still in flight").to.equal(null);

      releaseSlowEvent();
      await scan;

      expect(await stateStore.loadCursor(), "once the whole batch is done").to.equal(1004);
    });

    it("waits for every event of a failed batch before giving the batch back", async function () {
      // If the scan gave up the moment one event failed, the loop would rescan the range while
      // the other events were still being answered — and start each of them a second time.
      process.env.EVENT_BATCH_SIZE = "10000";
      stubs["./storage/storage"].uploadData.rejects(new Error("Autonomys network unreachable"));
      sinon.stub(stateStore, "enqueueFailedJob").rejects(new Error("database unavailable"));
      const clientPayload = {
        promptText: "Queue is down",
        isNewConversation: true,
        previousMessageId: null,
        previousMessageCID: null,
      };
      const payloadBytes = ethers.toUtf8Bytes(createEncryptedString(clientPayload, SESSION_KEY));
      const failing = makeFakeEvent(1001, {
        eventName: "PromptSubmitted",
        transactionIndex: 0,
        args: ["0xUser", 1, 700, 701, payloadBytes, "0xkey"],
      });
      let releaseSlowEvent;
      const held = new Promise((resolve) => {
        releaseSlowEvent = resolve;
      });
      const slow = {
        eventName: "PromptSubmitted",
        blockNumber: 1003,
        transactionIndex: 0,
        index: 1,
        args: ["0xUser", 1, 702, 703, "0x1234", "0xkey"],
        getBlock: () => held.then(() => ({ timestamp: Math.floor(Date.now() / 1000) })),
      };
      mockedOracleComponents.contract.queryFilter.onFirstCall().resolves([failing, slow]).resolves([]);

      let settled = false;
      const scan = aiAgentOracle.processPastEvents(1000, 1004).then(
        () => (settled = true),
        () => (settled = true),
      );
      for (let i = 0; i < 100; i++) await new Promise((resolve) => setImmediate(resolve));

      expect(settled, "while the slow event is still in flight").to.be.false;

      releaseSlowEvent();
      await scan;
      expect(settled).to.be.true;
      expect(await stateStore.loadCursor()).to.equal(null);
    });

    it("does not move the checkpoint when a failed event could not be queued for retry", async function () {
      process.env.EVENT_BATCH_SIZE = "10000";
      stubs["./storage/storage"].uploadData.rejects(new Error("Autonomys network unreachable"));
      sinon.stub(stateStore, "enqueueFailedJob").rejects(new Error("database unavailable"));
      const clientPayload = {
        promptText: "Queue is down",
        isNewConversation: true,
        previousMessageId: null,
        previousMessageCID: null,
      };
      const payloadBytes = ethers.toUtf8Bytes(createEncryptedString(clientPayload, SESSION_KEY));
      const fakeEvent = makeFakeEvent(1002, {
        eventName: "PromptSubmitted",
        transactionIndex: 0,
        args: ["0xUser", 1, 700, 701, payloadBytes, "0xkey"],
      });
      mockedOracleComponents.contract.queryFilter.onFirstCall().resolves([fakeEvent]).resolves([]);

      let error;
      try {
        await aiAgentOracle.processPastEvents(1000, 1004);
      } catch (e) {
        error = e;
      }

      // The event is neither answered nor queued, so the scan must see it again: the batch
      // fails and the checkpoint stays where it was.
      expect(error, "the scan must not report success").to.be.instanceOf(Error);
      expect(await stateStore.loadCursor()).to.equal(null);
    });
  });

  describe("Rapid Successive Events", function () {
    it("processPastEvents handles multiple events in block order without dropping any", async function () {
      process.env.EVENT_BATCH_SIZE = "10000";
      mockedOracleComponents.contract.isOracle.resolves(true);

      const events = [];
      for (let i = 0; i < 5; i++) {
        events.push({
          eventName: "PromptSubmitted",
          blockNumber: 1000 + i,
          transactionIndex: 0,
          args: [
            "0xUser",
            1,
            i * 2,
            i * 2 + 1,
            "0x1234",
            "0xkey",
          ],
          getBlock: () => Promise.resolve({ timestamp: Math.floor(Date.now() / 1000) }),
        });
      }

      // All events returned as PromptSubmitted, others empty
      mockedOracleComponents.contract.queryFilter
        .onFirstCall().resolves(events)
        .onSecondCall().resolves([])
        .onThirdCall().resolves([])
        .onCall(3).resolves([]);

      // The handlers will fail (bad payload) but handleAndRecord silently drops invalid payloads
      await aiAgentOracle.processPastEvents(1000, 1004);

      // All 5 events were processed (queued to the handler)
      // Since payloads are invalid, they get dropped silently — but the state advances
      expect(await stateStore.loadCursor()).to.equal(1004);
      expect(await stateStore.countFailedJobs()).to.deep.equal({ pending: 0, exhausted: 0 });
    });

    it("processPastEvents processes events from multiple blocks without errors", async function () {
      process.env.EVENT_BATCH_SIZE = "10000";
      mockedOracleComponents.contract.isOracle.resolves(true);

      const eventA = {
        eventName: "PromptSubmitted",
        blockNumber: 2000,
        transactionIndex: 5,
        args: ["0xUser", 1, 10, 11, "0x", "0xkey"],
        getBlock: () => Promise.resolve({ timestamp: Math.floor(Date.now() / 1000) }),
      };
      const eventB = {
        eventName: "PromptSubmitted",
        blockNumber: 2000,
        transactionIndex: 2,
        args: ["0xUser", 1, 20, 21, "0x", "0xkey"],
        getBlock: () => Promise.resolve({ timestamp: Math.floor(Date.now() / 1000) }),
      };
      const eventC = {
        eventName: "PromptSubmitted",
        blockNumber: 1999,
        transactionIndex: 10,
        args: ["0xUser", 1, 30, 31, "0x", "0xkey"],
        getBlock: () => Promise.resolve({ timestamp: Math.floor(Date.now() / 1000) }),
      };

      // Feed events out of order — processor sorts them internally
      mockedOracleComponents.contract.queryFilter
        .onFirstCall().resolves([eventA, eventB, eventC])
        .onSecondCall().resolves([])
        .onThirdCall().resolves([])
        .onCall(3).resolves([]);

      await aiAgentOracle.processPastEvents(1999, 2000);

      // All 3 events processed, checkpoint advances to end of batch
      expect(await stateStore.loadCursor()).to.equal(2000);
    });
  });

  describe("Oracle State Persistence", function () {
    it("resumes from lastProcessedBlock after simulated restart, avoiding duplicate processing", async function () {
      process.env.EVENT_BATCH_SIZE = "10000";
      mockedOracleComponents.contract.isOracle.resolves(true);
      mockedOracleComponents.contract.queryFilter.resolves([]);

      // First start: nothing stored, processes from lookback
      expect(await stateStore.loadCursor()).to.equal(null);
      mockedOracleComponents.provider.getBlockNumber.resolves(10000);

      await aiAgentOracle.start();

      // Verify the stored cursor is now 10000
      expect(await stateStore.loadCursor()).to.equal(10000);

      // Simulate restart: the second start reads back what the first one stored
      mockedOracleComponents.provider.getBlockNumber.resolves(10005);
      mockedOracleComponents.contract.queryFilter.resetHistory();

      await aiAgentOracle.start();

      // Should process from 10001 to 10005 — not re-process 8200-10000
      const queryFilterCall = mockedOracleComponents.contract.queryFilter.firstCall;
      expect(queryFilterCall.args[1]).to.equal(10001);
      expect(queryFilterCall.args[2]).to.equal(10005);
    });
  });

  describe("Oracle Start Lifecycle", function () {
    beforeEach(() => {
      process.env.EVENT_BATCH_SIZE = "10000";
      mockedOracleComponents.contract.isOracle.resolves(true);
      mockedOracleComponents.contract.queryFilter.resolves([]);
    });

    it("initializes storage, verifies oracle address, and starts polling", async function () {
      mockedOracleComponents.provider.getBlockNumber.resolves(10000);

      await aiAgentOracle.start();

      expect(stubs["./storage/storage"].initializeStorage.calledOnce).to.be.true;
      expect(mockedOracleComponents.contract.isOracle.calledOnce).to.be.true;

      // start() chose its store through createStateStore (no Postgres configured here, so the
      // file backend) and caught the cursor up to the head before polling.
      expect(stubs["./oracleState/runtime"].createStateStore.calledOnce).to.be.true;
      expect(await stateStore.loadCursor()).to.equal(10000);
    });

    it("resumes from last processed block stored in the state store", async function () {
      await stateStore.advanceCursor(9000);
      mockedOracleComponents.provider.getBlockNumber.resolves(10000);

      await aiAgentOracle.start();

      const queryFilterCall = mockedOracleComponents.contract.queryFilter.firstCall;
      expect(queryFilterCall.args[1]).to.equal(9001);
      expect(queryFilterCall.args[2]).to.equal(10000);
    });

    it("rewinds a stored cursor that is ahead of the chain head before scanning", async function () {
      // A reverted local chain, or an RPC that lags: the stored block does not exist yet. Left
      // alone, the forward-only store would refuse every save until the head caught up, while
      // memory claimed the head — and a restart in between would skip the difference.
      await stateStore.advanceCursor(12000);
      mockedOracleComponents.provider.getBlockNumber.resolves(10000);

      await aiAgentOracle.start();

      expect(await stateStore.loadCursor()).to.equal(10000);
      expect(aiAgentOracle.getLastProcessedBlock()).to.equal(10000);
    });

    it("uses lookback window on fresh start (nothing stored)", async function () {
      mockedOracleComponents.provider.getBlockNumber.resolves(10000);

      await aiAgentOracle.start();

      // Lookback is 1800 blocks from latest
      const queryFilterCall = mockedOracleComponents.contract.queryFilter.firstCall;
      expect(queryFilterCall.args[1]).to.equal(8200);
      expect(queryFilterCall.args[2]).to.equal(10000);
    });
  });
});
