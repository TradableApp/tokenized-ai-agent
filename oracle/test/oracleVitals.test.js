const { expect } = require("chai");
const proxyquire = require("proxyquire").noCallThru();

// Vitals for the oracle heartbeat (CU-86d438hwt).
//
// `daily_activity` could already say the oracle ANSWERED, but not that it is ALIVE — a silent
// oracle and a healthy-but-idle one both produce zero answer rows, and `oasis rofl machine logs`
// surfaces warn/error only. These vitals are the payload of the heartbeat that closes that gap.
//
// THE PROPERTY THAT MATTERS MOST IS THAT THIS NEVER THROWS.
//
// It runs on a background timer whose whole job is to prove the oracle is alive. An exception
// escaping the collector kills the beat, core sees staleness, and reports the oracle as DEAD —
// a false alarm caused by the monitoring, and strictly worse than no monitoring, because it
// trains you to distrust the alert. So every probe degrades to null INDEPENDENTLY: one broken
// RPC must not blank the memory figures sitting next to it.

const OK_DEPS = () => ({
  provider: {
    getBlockNumber: async () => 45714325,
    getBalance: async () => 49928663198858384n, // 0.0499… ETH in wei
  },
  walletAddress: "0x0DECafC0ffee00000000000000000000000009a12",
  queue: { pending: 2, size: 7 },
  readState: async () => ({ lastProcessedBlock: 45714300 }),
  readFailedJobs: async () => [{ id: 1 }, { id: 2 }, { id: 3 }],
  fetchAccountInfo: async () => ({
    pendingUploadCredits: 52428800,
    pendingDownloadCredits: 104857600,
  }),
  diskPath: "/",
});

function load() {
  return proxyquire("../src/oracleVitals", {});
}

describe("collectVitals", () => {
  it("reports process, chain, queue and storage vitals in one snapshot", async () => {
    const { collectVitals } = load();
    const v = await collectVitals(OK_DEPS());

    // Process — mirrors core's ProcessHealth so the Slack block reads consistently.
    expect(v.uptimeSeconds).to.be.a("number").and.to.be.at.least(0);
    expect(v.uptimeHuman).to.be.a("string");
    expect(v.memoryRssMB).to.be.a("number").and.to.be.greaterThan(0);
    expect(v.memoryHeapUsedMB).to.be.a("number").and.to.be.greaterThan(0);
    expect(v.memoryTotalMB).to.be.a("number").and.to.be.greaterThan(0);
    expect(v.memoryPctUsed).to.be.a("number").and.to.be.within(0, 100);
    expect(v.loadAvg1m).to.be.a("number");

    // Chain — the highest-value pair. A stalled listener means paid prompts go unanswered.
    expect(v.lastProcessedBlock).to.equal(45714300);
    expect(v.chainHead).to.equal(45714325);
    expect(v.blockLag).to.equal(25);

    // Wallet — it pays gas to submit answers; empty wallet stops answers silently.
    expect(v.walletBalanceEth).to.be.a("number").and.to.be.closeTo(0.049928, 0.000001);

    expect(v.failedJobsCount).to.equal(3);
    expect(v.queuePending).to.equal(2);
    expect(v.queueSize).to.equal(7);

    expect(v.autoDriveUploadCredits).to.equal(52428800);
    expect(v.autoDriveDownloadCredits).to.equal(104857600);
  });

  it("carries the cumulative AI tier mix, and null when no tally is injected", async () => {
    const { collectVitals } = load();
    const deps = OK_DEPS();
    deps.providerTally = { snapshot: () => ({ elizaos: 40, chaingpt: 2, none: 0 }) };

    const withTally = await collectVitals(deps);
    // The signature of the silent Gemini failover is elizaos collapsing into chaingpt, so the
    // per-tier split has to survive into the heartbeat rather than being summed away.
    expect(withTally.providers).to.deep.equal({ elizaos: 40, chaingpt: 2, none: 0 });

    const withoutTally = await collectVitals(OK_DEPS());
    expect(withoutTally.providers).to.equal(null);
  });

  it("never throws when EVERY probe fails, and reports nulls instead", async () => {
    const { collectVitals } = load();
    const boom = () => {
      throw new Error("probe exploded");
    };
    const v = await collectVitals({
      provider: { getBlockNumber: boom, getBalance: boom },
      walletAddress: "0xdead",
      queue: null,
      readState: boom,
      readFailedJobs: boom,
      fetchAccountInfo: boom,
      diskPath: "/definitely/not/a/real/path/xyzzy",
    });

    expect(v).to.be.an("object");
    expect(v.chainHead).to.equal(null);
    expect(v.lastProcessedBlock).to.equal(null);
    expect(v.blockLag).to.equal(null);
    expect(v.walletBalanceEth).to.equal(null);
    expect(v.failedJobsCount).to.equal(null);
    expect(v.autoDriveUploadCredits).to.equal(null);

    // Process vitals come from `process`/`os` and cannot fail — they must still be present,
    // which is the whole point of degrading per-probe rather than per-snapshot.
    expect(v.memoryRssMB).to.be.a("number").and.to.be.greaterThan(0);
    expect(v.uptimeSeconds).to.be.a("number");
  });

  it("degrades ONE failing probe without blanking its neighbours", async () => {
    const { collectVitals } = load();
    const deps = OK_DEPS();
    deps.provider.getBalance = async () => {
      throw new Error("rpc down");
    };

    const v = await collectVitals(deps);

    expect(v.walletBalanceEth).to.equal(null);
    // Same provider object, different call — must survive.
    expect(v.chainHead).to.equal(45714325);
    expect(v.blockLag).to.equal(25);
    expect(v.failedJobsCount).to.equal(3);
  });

  it("returns a null blockLag rather than a bogus number when either side is unknown", async () => {
    const { collectVitals } = load();
    const deps = OK_DEPS();
    deps.readState = async () => ({}); // no lastProcessedBlock recorded yet (fresh deploy)

    const v = await collectVitals(deps);

    expect(v.lastProcessedBlock).to.equal(null);
    expect(v.chainHead).to.equal(45714325);
    // Not 45714325, which would read as "catastrophically behind" on a fresh deploy and page
    // someone at 3am for a cursor that simply has not been written yet.
    expect(v.blockLag).to.equal(null);
  });

  it("never reports a negative blockLag when the cursor is ahead of a lagging RPC read", async () => {
    const { collectVitals } = load();
    const deps = OK_DEPS();
    deps.readState = async () => ({ lastProcessedBlock: 45714330 }); // ahead of head
    const v = await collectVitals(deps);
    // Load-balanced RPCs legitimately serve a slightly stale head. A negative lag is noise,
    // not a signal — clamp it, but do not pretend the cursor is unknown.
    expect(v.blockLag).to.equal(0);
  });
});
