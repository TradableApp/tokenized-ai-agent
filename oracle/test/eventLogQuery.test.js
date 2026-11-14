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

  it("leaves out a log that could not be decoded, and reports it", async () => {
    // ethers returns a log with no event name when the ABI cannot decode it (for example the
    // deployed contract indexes a field this ABI does not). The cursor will move past it, so
    // it must not go unreported: that prompt is paid for and will only be refunded.
    const undecodable = { blockNumber: 10, index: 0, transactionHash: "0xabc" };
    contract.queryFilter.resolves([undecodable, log("PromptSubmitted", 10, 1)]);
    const onUndecodable = sinon.stub();

    const events = await queryOracleWorkEvents(contract, 10, 10, { onUndecodable });

    expect(events.map((e) => e.eventName)).to.deep.equal(["PromptSubmitted"]);
    expect(onUndecodable.calledOnceWithExactly(undecodable)).to.equal(true);
  });

  it("a report that throws does not lose the events that did decode", async () => {
    contract.queryFilter.resolves([{ blockNumber: 10, index: 0 }, log("PromptSubmitted", 10, 1)]);
    const onUndecodable = sinon.stub().throws(new Error("alert channel down"));

    const events = await queryOracleWorkEvents(contract, 10, 10, { onUndecodable });

    expect(events.map((e) => e.eventName)).to.deep.equal(["PromptSubmitted"]);
  });

  it("a report that rejects later is caught too", async () => {
    contract.queryFilter.resolves([{ blockNumber: 10, index: 0 }, log("PromptSubmitted", 10, 1)]);
    const unhandled = sinon.stub();
    process.on("unhandledRejection", unhandled);
    const onUndecodable = sinon.stub().rejects(new Error("alert channel down"));

    try {
      const events = await queryOracleWorkEvents(contract, 10, 10, { onUndecodable });
      // Unhandled rejections are reported after the microtask queue drains.
      await new Promise((resolve) => setImmediate(resolve));

      expect(events.map((e) => e.eventName)).to.deep.equal(["PromptSubmitted"]);
      expect(unhandled.called).to.equal(false);
    } finally {
      process.removeListener("unhandledRejection", unhandled);
    }
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

  it("decodes all four from one eth_getLogs through a real ethers Contract", async () => {
    // The stub above cannot show that ethers accepts a bare topic array and names each log.
    const iface = new ethers.Interface(AGENT_EVENTS);
    const address = "0x00000000000000000000000000000000000000Aa";
    const user = "0x0000000000000000000000000000000000000001";
    const encoded = (name, args, blockNumber, index) => {
      const { topics, data } = iface.encodeEventLog(name, args);
      return {
        address,
        topics,
        data,
        blockNumber,
        index,
        transactionIndex: 0,
        transactionHash: `0x${"11".repeat(32)}`,
        blockHash: `0x${"22".repeat(32)}`,
        removed: false,
      };
    };
    const getLogs = sinon.stub();
    const provider = { getLogs, resolveName: async (name) => name };
    provider.provider = provider;
    getLogs.callsFake(async () =>
      [
        encoded("MetadataUpdateRequested", [user, 1, "0x01", "0x02"], 12, 0),
        encoded("PromptSubmitted", [user, 1, 2, 3, "0x01", "0x02"], 10, 5),
        encoded("BranchRequested", [user, 1, 2, 3, "0x01", "0x02"], 10, 1),
        encoded("RegenerationRequested", [user, 1, 2, 3, 4, "0x01", "0x02"], 11, 0),
      ].map((raw) => new ethers.Log(raw, provider)),
    );
    const real = new ethers.Contract(address, AGENT_EVENTS, provider);

    const events = await queryOracleWorkEvents(real, 10, 12);

    expect(getLogs.callCount).to.equal(1);
    const sent = getLogs.firstCall.args[0];
    expect(sent.address).to.equal(address);
    // ethers sorts the alternatives; what matters is that topic 0 offers exactly the four.
    expect(sent.topics).to.have.lengthOf(1);
    expect(sent.topics[0]).to.have.members(oracleWorkTopicFilter(real)[0]);
    expect([sent.fromBlock, sent.toBlock]).to.deep.equal([10, 12]);
    expect(events.map((e) => [e.eventName, e.blockNumber, e.index, e.args.length])).to.deep.equal([
      ["BranchRequested", 10, 1, 6],
      ["PromptSubmitted", 10, 5, 6],
      ["RegenerationRequested", 11, 0, 7],
      ["MetadataUpdateRequested", 12, 0, 4],
    ]);
  });

  it("compareLogOrder sorts by block, then by position in the block", () => {
    expect(compareLogOrder(log("a", 1, 9), log("b", 2, 0))).to.be.below(0);
    expect(compareLogOrder(log("a", 2, 1), log("b", 2, 0))).to.be.above(0);
    expect(compareLogOrder(log("a", 2, 1), log("b", 2, 1))).to.equal(0);
  });
});
