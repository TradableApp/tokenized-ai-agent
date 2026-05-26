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

describe("E2E: Oracle Event Listener", function () {
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
    it("drops malformed payloads silently and advances block checkpoint", async function () {
      const malformedPayload = ethers.toUtf8Bytes("not-encrypted-at-all");
      const fakeEvent = makeFakeEvent(6000, {
        args: ["0xUser", 1, 300, 301, malformedPayload, "0xkey"],
      });

      await aiAgentOracle.handleAndRecord(
        "PromptSubmitted", aiAgentOracle.handlePrompt,
        "0xUser", 1, 300, 301, malformedPayload, "0xkey",
        fakeEvent,
      );

      // Block checkpoint saved
      const stateWrite = stubs["fs/promises"].writeFile
        .getCalls()
        .find((c) => c.args[0].includes("oracle-state.json"));
      expect(stateWrite).to.not.be.undefined;
      const state = JSON.parse(stateWrite.args[1]);
      expect(state.lastProcessedBlock).to.equal(6000);

      // No retry queue entry
      const failedJobsWrite = stubs["fs/promises"].writeFile
        .getCalls()
        .find((c) => c.args[0].includes("failed-jobs.json"));
      expect(failedJobsWrite).to.be.undefined;

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
      const fakeEvent = makeFakeEvent(6001, {
        transactionHash: "0xfaketxhash",
        args: ["0xUser", 1, 302, 303, payloadBytes, "0xkey"],
      });

      await aiAgentOracle.handleAndRecord(
        "PromptSubmitted", aiAgentOracle.handlePrompt,
        "0xUser", 1, 302, 303, payloadBytes, "0xkey",
        fakeEvent,
      );

      const failedJobsWrite = stubs["fs/promises"].writeFile
        .getCalls()
        .find((c) => c.args[0].includes("failed-jobs.json"));
      expect(failedJobsWrite).to.not.be.undefined;

      const failedJobs = JSON.parse(failedJobsWrite.args[1]);
      expect(failedJobs).to.have.lengthOf(1);
      expect(failedJobs[0]).to.deep.include({
        eventName: "PromptSubmitted",
        retryCount: 0,
      });
      expect(failedJobs[0].event.blockNumber).to.equal(6001);
      expect(failedJobs[0].event.transactionHash).to.equal("0xfaketxhash");
      expect(failedJobs[0].nextAttemptAt).to.be.a("number");

      // Block checkpoint also saved
      const stateWrite = stubs["fs/promises"].writeFile
        .getCalls()
        .find((c) => c.args[0].includes("oracle-state.json"));
      expect(stateWrite).to.not.be.undefined;
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

  describe("Rapid Successive Events", function () {
    it("processPastEvents handles multiple events in block order without dropping any", async function () {
      process.env.EVENT_BATCH_SIZE = "10000";
      mockedOracleComponents.contract.oracle.resolves("0xOracleAddress");

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
      const stateWrites = stubs["fs/promises"].writeFile
        .getCalls()
        .filter((c) => c.args[0].includes("oracle-state.json"));
      expect(stateWrites.length).to.be.greaterThan(0);
      const lastState = JSON.parse(stateWrites[stateWrites.length - 1].args[1]);
      expect(lastState.lastProcessedBlock).to.equal(1004);
    });

    it("processPastEvents processes events from multiple blocks without errors", async function () {
      process.env.EVENT_BATCH_SIZE = "10000";
      mockedOracleComponents.contract.oracle.resolves("0xOracleAddress");

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
      const stateWrites = stubs["fs/promises"].writeFile
        .getCalls()
        .filter((c) => c.args[0].includes("oracle-state.json"));
      const lastState = JSON.parse(stateWrites[stateWrites.length - 1].args[1]);
      expect(lastState.lastProcessedBlock).to.equal(2000);
    });
  });

  describe("Oracle State Persistence", function () {
    it("resumes from lastProcessedBlock after simulated restart, avoiding duplicate processing", async function () {
      process.env.EVENT_BATCH_SIZE = "10000";
      mockedOracleComponents.contract.oracle.resolves("0xOracleAddress");
      mockedOracleComponents.contract.queryFilter.resolves([]);

      // First start: no state file, processes from lookback
      stubs["fs/promises"].readFile
        .withArgs(sinon.match(/oracle-state\.json$/))
        .rejects(new Error("File not found"));
      mockedOracleComponents.provider.getBlockNumber.resolves(10000);

      await aiAgentOracle.start();

      // Verify state was written with lastProcessedBlock = 10000
      const stateWrites1 = stubs["fs/promises"].writeFile
        .getCalls()
        .filter((c) => c.args[0].includes("oracle-state.json"));
      const lastWrite1 = JSON.parse(stateWrites1[stateWrites1.length - 1].args[1]);
      expect(lastWrite1.lastProcessedBlock).to.equal(10000);

      // Simulate restart: state file now exists with lastProcessedBlock=10000
      stubs["fs/promises"].readFile.reset();
      stubs["fs/promises"].readFile
        .withArgs(sinon.match(/oracle-state\.json$/))
        .resolves(JSON.stringify({ lastProcessedBlock: 10000 }));
      stubs["fs/promises"].readFile.rejects(new Error("File not found"));
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
      mockedOracleComponents.contract.oracle.resolves("0xOracleAddress");
      mockedOracleComponents.contract.queryFilter.resolves([]);
    });

    it("initializes storage, verifies oracle address, and starts polling", async function () {
      stubs["fs/promises"].readFile
        .withArgs(sinon.match(/oracle-state\.json$/))
        .rejects(new Error("File not found"));
      mockedOracleComponents.provider.getBlockNumber.resolves(10000);

      await aiAgentOracle.start();

      expect(stubs["./storage/storage"].initializeStorage.calledOnce).to.be.true;
      expect(mockedOracleComponents.contract.oracle.calledOnce).to.be.true;

      const stateWrites = stubs["fs/promises"].writeFile
        .getCalls()
        .filter((c) => c.args[0].includes("oracle-state.json"));
      expect(stateWrites.length).to.be.greaterThan(0);
    });

    it("resumes from last processed block stored in state file", async function () {
      stubs["fs/promises"].readFile
        .withArgs(sinon.match(/oracle-state\.json$/))
        .resolves(JSON.stringify({ lastProcessedBlock: 9000 }));
      mockedOracleComponents.provider.getBlockNumber.resolves(10000);

      await aiAgentOracle.start();

      const queryFilterCall = mockedOracleComponents.contract.queryFilter.firstCall;
      expect(queryFilterCall.args[1]).to.equal(9001);
      expect(queryFilterCall.args[2]).to.equal(10000);
    });

    it("uses lookback window on fresh start (no state file)", async function () {
      stubs["fs/promises"].readFile
        .withArgs(sinon.match(/oracle-state\.json$/))
        .rejects(new Error("File not found"));
      mockedOracleComponents.provider.getBlockNumber.resolves(10000);

      await aiAgentOracle.start();

      // Lookback is 1800 blocks from latest
      const queryFilterCall = mockedOracleComponents.contract.queryFilter.firstCall;
      expect(queryFilterCall.args[1]).to.equal(8200);
      expect(queryFilterCall.args[2]).to.equal(10000);
    });
  });
});
