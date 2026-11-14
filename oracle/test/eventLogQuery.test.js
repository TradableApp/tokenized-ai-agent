const { expect } = require("chai");
const { ethers } = require("ethers");
const sinon = require("sinon");

const {
  ORACLE_WORK_EVENTS,
  compareLogOrder,
  oracleWorkTopicFilter,
  queryOracleWorkEvents,
} = require("../src/eventLogQuery");

// The four events as the agent declares them: only the names and types matter for the topics.
const AGENT_EVENTS = [
  "event PromptSubmitted(address indexed user, uint256 indexed conversationId, uint256 indexed promptMessageId, uint256 answerMessageId, bytes encryptedPayload, bytes roflEncryptedKey)",
  "event RegenerationRequested(address indexed user, uint256 indexed conversationId, uint256 indexed promptMessageId, uint256 originalAnswerMessageId, uint256 answerMessageId, bytes encryptedPayload, bytes roflEncryptedKey)",
  "event BranchRequested(address indexed user, uint256 indexed originalConversationId, uint256 branchPointMessageId, uint256 newConversationId, bytes encryptedPayload, bytes roflEncryptedKey)",
  "event MetadataUpdateRequested(address indexed user, uint256 indexed conversationId, bytes encryptedPayload, bytes roflEncryptedKey)",
  "event PromptCancelled(address indexed user, uint256 indexed answerMessageId)",
];

describe("eventLogQuery — one log query finds every event the oracle works on", () => {
  let contract;

  beforeEach(() => {
    contract = {
      interface: new ethers.Interface(AGENT_EVENTS),
      queryFilter: sinon.stub().resolves([]),
    };
  });

  const log = (eventName, blockNumber, index) => ({ eventName, blockNumber, index });

  it("names the four events that ask the oracle for work", () => {
    expect(ORACLE_WORK_EVENTS).to.deep.equal([
      "PromptSubmitted",
      "RegenerationRequested",
      "BranchRequested",
      "MetadataUpdateRequested",
    ]);
  });

  it("builds one filter matching any of the four event signatures in topic 0", () => {
    const filter = oracleWorkTopicFilter(contract);

    expect(filter).to.have.lengthOf(1);
    expect(filter[0]).to.deep.equal(
      ORACLE_WORK_EVENTS.map((name) => contract.interface.getEvent(name).topicHash),
    );
    // An event the oracle does not act on is not asked for.
    expect(filter[0]).to.not.include(contract.interface.getEvent("PromptCancelled").topicHash);
  });

  it("makes exactly one query for a range and returns all four event types", async () => {
    contract.queryFilter.resolves([
      log("PromptSubmitted", 10, 0),
      log("RegenerationRequested", 10, 1),
      log("BranchRequested", 11, 0),
      log("MetadataUpdateRequested", 12, 3),
    ]);

    const events = await queryOracleWorkEvents(contract, 10, 12);

    expect(contract.queryFilter.callCount).to.equal(1);
    expect(contract.queryFilter.firstCall.args).to.deep.equal([
      oracleWorkTopicFilter(contract),
      10,
      12,
    ]);
    expect(events.map((e) => e.eventName)).to.deep.equal([
      "PromptSubmitted",
      "RegenerationRequested",
      "BranchRequested",
      "MetadataUpdateRequested",
    ]);
  });

  it("returns the events in block order, then in log order inside a block", async () => {
    contract.queryFilter.resolves([
      log("BranchRequested", 12, 0),
      log("PromptSubmitted", 10, 7),
      log("MetadataUpdateRequested", 10, 2),
      log("RegenerationRequested", 11, 5),
    ]);

    const events = await queryOracleWorkEvents(contract, 10, 12);

    expect(events.map((e) => [e.blockNumber, e.index])).to.deep.equal([
      [10, 2],
      [10, 7],
      [11, 5],
      [12, 0],
    ]);
  });

  it("does not reorder the provider's array in place", async () => {
    const fromProvider = [log("PromptSubmitted", 12, 0), log("PromptSubmitted", 10, 0)];
    contract.queryFilter.resolves(fromProvider);

    await queryOracleWorkEvents(contract, 10, 12);

    expect(fromProvider.map((e) => e.blockNumber)).to.deep.equal([12, 10]);
  });

  it("leaves out a log the contract interface could not name", async () => {
    // ethers hands back a bare Log (no eventName) when topic 0 is not in the ABI.
    contract.queryFilter.resolves([
      { blockNumber: 10, index: 0 },
      log("PromptSubmitted", 10, 1),
    ]);

    const events = await queryOracleWorkEvents(contract, 10, 10);

    expect(events.map((e) => e.eventName)).to.deep.equal(["PromptSubmitted"]);
  });

  it("lets a failed query reach the caller", async () => {
    contract.queryFilter.rejects(new Error("429 Too Many Requests"));

    let thrown;
    try {
      await queryOracleWorkEvents(contract, 10, 12);
    } catch (error) {
      thrown = error;
    }

    expect(thrown?.message).to.equal("429 Too Many Requests");
  });

  it("compareLogOrder sorts by block, then by position in the block", () => {
    expect(compareLogOrder(log("a", 1, 9), log("b", 2, 0))).to.be.below(0);
    expect(compareLogOrder(log("a", 2, 1), log("b", 2, 0))).to.be.above(0);
    expect(compareLogOrder(log("a", 2, 1), log("b", 2, 1))).to.equal(0);
  });
});
