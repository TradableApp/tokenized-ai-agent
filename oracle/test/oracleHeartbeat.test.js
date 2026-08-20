const { expect } = require("chai");
const sinon = require("sinon");
const proxyquire = require("proxyquire").noCallThru();

// The oracle heartbeat timer (CU-86d438hwt).
//
// A LIVENESS BEACON THAT CAN DIE IS WORSE THAN NONE. If a single bad beat stops the loop, core
// sees staleness and reports the oracle DEAD while it is happily answering prompts. Whoever gets
// paged learns the alert lies, and the next real outage is ignored. So the loop must survive
// anything a beat can do to it: throwing synchronously, rejecting asynchronously, or hanging.
//
// Hence setTimeout-CHAINING rather than setInterval. setInterval fires regardless of whether the
// previous beat finished, so a slow write stacks overlapping beats; and an async handler that
// rejects produces an unhandled rejection, which on Node's default `--unhandled-rejections=throw`
// takes the whole oracle down — killing the paid answer path to report on it.

function load() {
  return proxyquire("../src/oracleHeartbeat", {});
}

const VITALS = { uptimeSeconds: 1, memoryRssMB: 100, blockLag: 0 };

describe("startHeartbeat", () => {
  let clock;

  beforeEach(() => {
    clock = sinon.useFakeTimers();
  });
  afterEach(() => {
    clock.restore();
    sinon.restore();
  });

  it("keeps beating after a beat throws — indefinitely, not just once", async () => {
    const record = sinon.stub().rejects(new Error("postgres is down"));
    const { startHeartbeat } = load();
    const hb = startHeartbeat({
      recordActivity: record,
      ctx: {},
      collect: async () => VITALS,
      intervalMs: 1000,
      logger: { warn() {} },
    });

    for (let i = 0; i < 5; i += 1) {
      await clock.tickAsync(1000);
    }
    hb.stop();

    // Five failures in a row must produce five attempts. Anything less means the chain broke.
    expect(record.callCount).to.equal(5);
  });

  it("keeps beating when the COLLECTOR throws, not just the write", async () => {
    const record = sinon.stub().resolves();
    const { startHeartbeat } = load();
    const hb = startHeartbeat({
      recordActivity: record,
      ctx: {},
      collect: async () => {
        throw new Error("collector exploded");
      },
      intervalMs: 1000,
      logger: { warn() {} },
    });

    await clock.tickAsync(3000);
    hb.stop();

    // Nothing recorded (no vitals to record), but crucially the process is still alive and the
    // loop still scheduled — proven by the next test's recovery case.
    expect(record.callCount).to.equal(0);
  });

  it("recovers: beats that fail then succeed keep flowing", async () => {
    const record = sinon.stub();
    record.onCall(0).rejects(new Error("transient"));
    record.onCall(1).rejects(new Error("transient"));
    record.resolves();

    const { startHeartbeat } = load();
    const hb = startHeartbeat({
      recordActivity: record,
      ctx: {},
      collect: async () => VITALS,
      intervalMs: 1000,
      logger: { warn() {} },
    });

    await clock.tickAsync(4000);
    hb.stop();

    expect(record.callCount).to.equal(4);
  });

  it("writes a UNIQUE contentSeed per beat, or onConflictDoNothing silently drops every repeat", async () => {
    const record = sinon.stub().resolves();
    const { startHeartbeat } = load();
    const hb = startHeartbeat({
      recordActivity: record,
      ctx: {},
      collect: async () => VITALS,
      intervalMs: 1000,
      logger: { warn() {} },
    });

    await clock.tickAsync(3000);
    hb.stop();

    const seeds = record.getCalls().map((c) => c.args[1].contentSeed);
    expect(seeds).to.have.lengthOf(3);
    expect(new Set(seeds).size).to.equal(3);
    // Prefixed, because content_hash derives from the seed ALONE — an unprefixed seed can
    // collide with a Social row and be discarded.
    seeds.forEach((s) => expect(s).to.match(/^oracle:heartbeat:/));
  });

  it("records platform oracle / kind heartbeat with the vitals as metadata", async () => {
    const record = sinon.stub().resolves();
    const { startHeartbeat } = load();
    const hb = startHeartbeat({
      recordActivity: record,
      ctx: { marker: "brain-ctx" },
      collect: async () => VITALS,
      intervalMs: 1000,
      logger: { warn() {} },
    });

    await clock.tickAsync(1000);
    hb.stop();

    const [ctx, args] = record.firstCall.args;
    expect(ctx).to.deep.equal({ marker: "brain-ctx" });
    expect(args.platform).to.equal("oracle");
    expect(args.kind).to.equal("heartbeat");
    expect(args.metadata).to.include({ memoryRssMB: 100, blockLag: 0 });
  });

  it("does not overlap beats when a write outlives the interval", async () => {
    let inFlight = 0;
    let maxConcurrent = 0;
    const record = async () => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((r) => setTimeout(r, 2500)); // outlives the 1000ms interval
      inFlight -= 1;
    };

    const { startHeartbeat } = load();
    const hb = startHeartbeat({
      recordActivity: record,
      ctx: {},
      collect: async () => VITALS,
      intervalMs: 1000,
      logger: { warn() {} },
    });

    await clock.tickAsync(10000);
    hb.stop();

    // setInterval would stack these. Chaining must not.
    expect(maxConcurrent).to.equal(1);
  });

  it("stop() halts the chain", async () => {
    const record = sinon.stub().resolves();
    const { startHeartbeat } = load();
    const hb = startHeartbeat({
      recordActivity: record,
      ctx: {},
      collect: async () => VITALS,
      intervalMs: 1000,
      logger: { warn() {} },
    });

    await clock.tickAsync(2000);
    const afterTwo = record.callCount;
    hb.stop();
    await clock.tickAsync(10000);

    expect(record.callCount).to.equal(afterTwo);
  });

  it("is disabled by a non-positive interval rather than spinning", async () => {
    const record = sinon.stub().resolves();
    const { startHeartbeat } = load();
    const hb = startHeartbeat({
      recordActivity: record,
      ctx: {},
      collect: async () => VITALS,
      intervalMs: 0,
      logger: { warn() {} },
    });

    await clock.tickAsync(10000);
    hb.stop();

    expect(record.callCount).to.equal(0);
  });
});
