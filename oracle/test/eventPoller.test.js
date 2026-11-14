const { expect } = require("chai");
const sinon = require("sinon");

const { createRangePoller } = require("../src/eventPoller");
const { createPollBackoff } = require("../src/pollBackoff");
const { refusedByProvider } = require("./helpers/refusedByProvider");

describe("eventPoller — one pass of the poll loop", () => {
  let head;
  let getHead;
  let roleReady;
  let queryEvents;
  let handled;
  let handleEvent;
  let persistCursor;
  let rewindCursor;
  let onReorg;
  let outage;
  let log;

  const event = (eventName, blockNumber, index) => ({ eventName, blockNumber, index });

  const poller = (overrides = {}) =>
    createRangePoller({
      startBlock: 100,
      batchSize: 10,
      getHead,
      roleReady,
      queryEvents,
      handleEvent,
      persistCursor,
      rewindCursor,
      onReorg,
      outage,
      backoff: createPollBackoff({ baseMs: 4000, capMs: 60000 }),
      catchUpDelayMs: 500,
      log,
      ...overrides,
    });

  const rateLimited = () =>
    Object.assign(new Error("429 Too Many Requests"), {
      info: { response: { statusCode: 429, headers: {} } },
    });

  beforeEach(() => {
    head = 100;
    getHead = sinon.stub().callsFake(async () => head);
    roleReady = sinon.stub().resolves();
    queryEvents = sinon.stub().resolves([]);
    handled = [];
    handleEvent = sinon.stub().callsFake(async (e) => {
      handled.push(`${e.eventName}@${e.blockNumber}:${e.index}`);
    });
    persistCursor = sinon.stub().resolves();
    rewindCursor = sinon.stub().resolves();
    onReorg = sinon.stub();
    outage = { success: sinon.stub(), failure: sinon.stub() };
    log = { log: sinon.stub(), warn: sinon.stub(), error: sinon.stub() };
  });

  it("asks for no logs while the head has not moved, and waits the base interval", async () => {
    const p = poller();

    const wait = await p.tick();

    expect(queryEvents.called).to.equal(false);
    expect(persistCursor.called).to.equal(false);
    expect(wait).to.equal(4000);
    expect(p.cursor()).to.equal(100);
  });

  it("scans the blocks after the cursor in one query, handles them in order and saves the cursor", async () => {
    head = 105;
    queryEvents.resolves([
      event("PromptSubmitted", 101, 0),
      event("RegenerationRequested", 101, 4),
      event("BranchRequested", 103, 1),
      event("MetadataUpdateRequested", 105, 2),
    ]);
    const p = poller();

    const wait = await p.tick();

    expect(queryEvents.callCount).to.equal(1);
    expect(queryEvents.firstCall.args).to.deep.equal([101, 105]);
    expect(handled).to.deep.equal([
      "PromptSubmitted@101:0",
      "RegenerationRequested@101:4",
      "BranchRequested@103:1",
      "MetadataUpdateRequested@105:2",
    ]);
    expect(persistCursor.calledOnceWithExactly(105)).to.equal(true);
    expect(outage.success.calledOnce).to.equal(true);
    expect(p.cursor()).to.equal(105);
    expect(wait).to.equal(4000);
  });

  it("takes no more than the batch size per pass and comes straight back while behind", async () => {
    head = 125;
    const p = poller();

    // 101..110, then 111..120 with the short catch-up wait; 121..125 reaches the head.
    expect(await p.tick()).to.equal(500);
    expect(await p.tick()).to.equal(500);
    expect(await p.tick()).to.equal(4000);

    expect(queryEvents.args).to.deep.equal([
      [101, 110],
      [111, 120],
      [121, 125],
    ]);
    expect(persistCursor.args).to.deep.equal([[110], [120], [125]]);
  });

  it("waits for the oracle role before asking the chain anything", async () => {
    const order = [];
    roleReady.callsFake(async () => order.push("role"));
    getHead.callsFake(async () => {
      order.push("head");
      return 100;
    });

    await poller().tick();

    expect(order).to.deep.equal(["role", "head"]);
  });

  it("saves the cursor only after every event of the pass has been handled", async () => {
    head = 101;
    queryEvents.resolves([event("PromptSubmitted", 101, 0)]);
    let finishHandling;
    handleEvent.callsFake(
      () =>
        new Promise((resolve) => {
          finishHandling = resolve;
        }),
    );
    const p = poller();

    const pass = p.tick();
    while (!finishHandling) await new Promise((resolve) => setImmediate(resolve));

    expect(persistCursor.called).to.equal(false);
    finishHandling();
    await pass;
    expect(persistCursor.calledOnceWithExactly(101)).to.equal(true);
  });

  it("does not move the cursor when an event could not be handled or queued, and scans the range again", async () => {
    head = 102;
    queryEvents.resolves([event("PromptSubmitted", 101, 0), event("PromptSubmitted", 102, 0)]);
    handleEvent.onFirstCall().rejects(new Error("queue write failed"));
    const p = poller();

    const wait = await p.tick();

    // Both events were still started: the second is not abandoned because the first failed.
    expect(handleEvent.callCount).to.equal(2);
    expect(persistCursor.called).to.equal(false);
    expect(p.cursor()).to.equal(100);
    expect(outage.failure.calledOnce).to.equal(true);
    expect(wait).to.equal(8000);

    await p.tick();
    expect(queryEvents.secondCall.args).to.deep.equal([101, 102]);
    expect(persistCursor.calledOnceWithExactly(102)).to.equal(true);
  });

  describe("a provider that answers 429", () => {
    it("backs off further on each refusal, keeps the cursor, then delivers every event once and in order", async () => {
      head = 103;
      const events = [
        event("PromptSubmitted", 101, 0),
        event("BranchRequested", 102, 3),
        event("RegenerationRequested", 103, 1),
      ];
      queryEvents.onCall(0).rejects(rateLimited());
      queryEvents.onCall(1).rejects(rateLimited());
      queryEvents.onCall(2).rejects(rateLimited());
      queryEvents.onCall(3).resolves(events);
      const p = poller();

      // 4000 doubled three times.
      expect(await p.tick()).to.equal(8000);
      expect(await p.tick()).to.equal(16000);
      expect(await p.tick()).to.equal(32000);
      expect(handled).to.deep.equal([]);
      expect(persistCursor.called).to.equal(false);
      expect(p.cursor()).to.equal(100);
      expect(outage.failure.callCount).to.equal(3);

      // The same range is asked for again: nothing was skipped while the provider refused.
      const firstGoodWait = await p.tick();
      expect(queryEvents.args.every(([from, to]) => from === 101 && to === 103)).to.equal(true);
      expect(handled).to.deep.equal([
        "PromptSubmitted@101:0",
        "BranchRequested@102:3",
        "RegenerationRequested@103:1",
      ]);
      expect(persistCursor.calledOnceWithExactly(103)).to.equal(true);

      // Recovery is gradual: 4000 + (32000 - 4000) / 2, then half the excess again.
      expect(firstGoodWait).to.equal(18000);
      expect(await p.tick()).to.equal(11000);
      expect(handled).to.have.lengthOf(3);
    });

    it("does not use the short catch-up wait while it is still backing off", async () => {
      head = 125;
      queryEvents.onCall(0).rejects(rateLimited());
      const p = poller();

      expect(await p.tick()).to.equal(8000);
      // Behind the head, but the provider has just refused: four times the catch-up wait, not
      // 500 and not the 6000 the backoff is on (that would let the chain pull further ahead).
      expect(await p.tick()).to.equal(2000);
    });

    it("goes back to the short catch-up wait once the backoff has fully recovered", async () => {
      head = 100000;
      queryEvents.onCall(0).rejects(rateLimited());
      const p = poller();
      await p.tick(); // 8000

      const waits = [];
      for (let i = 0; i < 14; i++) waits.push(await p.tick());

      // 6000, 5000, 4500, 4250, ... settles on the base after 12 halvings of 4000.
      expect(waits.slice(0, 11).every((wait) => wait === 2000)).to.equal(true);
      expect(waits[13]).to.equal(500);
    });

    it("keeps the provider's address out of the log line and out of what the outage alert gets", async () => {
      queryEvents.rejects(refusedByProvider());
      head = 101;
      const p = poller();

      await p.tick();

      const logged = log.error.firstCall.args.join(" ");
      expect(logged).to.include("SERVER_ERROR: server response 429 Too Many Requests");
      expect(logged).to.not.include("rpc.example");
      const reported = outage.failure.firstCall.args[0];
      expect(reported).to.be.an.instanceOf(Error);
      expect(reported.message).to.equal("SERVER_ERROR: server response 429 Too Many Requests");
      expect(reported.message).to.not.include("rpc.example");
    });

    it("still honours the provider's Retry-After after describing the error", async () => {
      queryEvents.rejects(refusedByProvider(429, "Too Many Requests", { "Retry-After": "30" }));
      head = 101;

      expect(await poller().tick()).to.equal(30000);
    });

    it("treats a refused head read the same way", async () => {
      getHead.onCall(0).rejects(rateLimited());
      const p = poller();

      expect(await p.tick()).to.equal(8000);
      expect(queryEvents.called).to.equal(false);
    });
  });

  describe("a head that drops below the cursor", () => {
    it("rewinds to just under the new head, saves that, reports it and scans from there", async () => {
      head = 90;
      const p = poller();

      await p.tick();

      expect(rewindCursor.calledOnceWithExactly(89)).to.equal(true);
      expect(onReorg.calledOnceWithExactly({ head: 90, cursor: 100, rewoundTo: 89 })).to.equal(
        true,
      );
      expect(queryEvents.firstCall.args).to.deep.equal([90, 90]);
      expect(p.cursor()).to.equal(90);
    });

    it("a reorg report that throws does not stop the pass", async () => {
      head = 90;
      onReorg.throws(new Error("alert channel down"));
      const p = poller();

      await p.tick();

      expect(rewindCursor.calledOnceWithExactly(89)).to.equal(true);
      expect(p.cursor()).to.equal(90);
    });
  });

  it("survives a thrown value that is not an Error", async () => {
    getHead.callsFake(() => Promise.reject(null)); // eslint-disable-line prefer-promise-reject-errors

    expect(await poller().tick()).to.equal(8000);
    expect(outage.failure.firstCall.args[0].message).to.equal("null");
  });

  it("the default settle reports every failure of a pass, not only the first", async () => {
    head = 102;
    queryEvents.resolves([event("PromptSubmitted", 101, 0), event("PromptSubmitted", 102, 0)]);
    handleEvent.onFirstCall().rejects(new Error("first"));
    handleEvent.onSecondCall().rejects(new Error("second"));

    await poller().tick();

    const logged = log.error.args.map((args) => args.join(" ")).join("\n");
    expect(logged).to.include("first");
    expect(logged).to.include("second");
  });

  it("refuses a batch size that is not a positive whole number", () => {
    expect(() => poller({ batchSize: 0 })).to.throw(/batchSize/);
    expect(() => poller({ batchSize: 2.5 })).to.throw(/batchSize/);
  });
});
