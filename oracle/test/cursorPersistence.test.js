const { expect } = require("chai");
const fs = require("node:fs");
const path = require("node:path");

// STRUCTURAL GUARD on the chain-cursor write path (CU-86d438hwt).
//
// The cursor is written from SIX places in aiAgentOracle.js. The heartbeat needs the current
// value, and reading the file to get it caused an intermittent null (see oracleVitals.test.js).
// The fix routes every write through one helper that updates the in-memory value AND persists —
// so the heartbeat can read memory.
//
// This guard exists because "update all N call sites" is a mistake I have already made once in
// this feature: the provider tally missed five of ten return points, including the exact branch
// it was written to observe. A raw fs.writeFile to STATE_FILE_PATH that bypasses the helper
// leaves the in-memory value stale, and a stale cursor reports a growing blockLag for an oracle
// that is perfectly healthy — a false alarm, which is the failure mode this whole feature exists
// to avoid.

describe("chain cursor persistence", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/aiAgentOracle.js"), "utf-8");

  it("routes every cursor write through the single helper", () => {
    // The helper itself is the one legitimate writer; everything else must go through it.
    const helperStart = source.indexOf("async function persistCursor(");
    const helperEnd = source.indexOf("\n}", helperStart);
    const raw = source
      .split("\n")
      .map((l, i) => [i + 1, l, source.split("\n").slice(0, i).join("\n").length])
      .filter(([, l]) => /fs\.writeFile\(\s*STATE_FILE_PATH/.test(l))
      .filter(([, , offset]) => offset < helperStart || offset > helperEnd);

    expect(
      raw.map(([n, l]) => `L${n}: ${l.trim()}`),
      "these bypass persistCursor() and will leave the in-memory cursor stale"
    ).to.deep.equal([]);
  });

  it("defines the helper it depends on (so the guard cannot pass vacuously)", () => {
    expect(source).to.match(/function persistCursor\(/);
    expect(source).to.include("getLastProcessedBlock");
  });

  it("does not read start()'s `state` from pollEvents — it is not in scope there", () => {
    // A seed block landed inside pollEvents' `while (true)` during review. Two faults in one:
    // `state` is a start()-local, so the reference is a ReferenceError that crashes the oracle on
    // its FIRST poll; and had it been in scope it would have reset the cursor BACKWARD to the
    // boot-time block on every cycle, making the heartbeat report a false giant lag — the exact
    // alarm this file exists to prevent. Neither unit tests nor CI catch it, because pollEvents
    // needs a live chain to run at all.
    //
    // start() already calls persistCursor(latestBlock) before starting the heartbeat, so the
    // first beat has a value without any seeding inside the loop.
    const source = fs.readFileSync(require.resolve("../src/aiAgentOracle"), "utf8");
    const start = source.indexOf("async function pollEvents(");
    expect(start, "pollEvents should exist").to.be.greaterThan(-1);
    const end = source.indexOf("\nasync function ", start + 1);
    const body = source.slice(start, end === -1 ? undefined : end);

    expect(body, "pollEvents must not reference start()'s local `state`").to.not.match(
      /\bstate\.lastProcessedBlock\b/,
    );
  });

  it("writes the SAME coerced value to memory and to disk", () => {
    // The two copies must never diverge — that divergence is the bug class this whole file exists
    // for. Writing the raw argument while storing the coerced one also means a BigInt (which
    // ethers can hand back) throws inside JSON.stringify AFTER the in-memory cursor has advanced,
    // leaving a silently stale checkpoint. Caught in review on PR #76.
    const source = fs.readFileSync(require.resolve("../src/aiAgentOracle"), "utf8");
    const i = source.indexOf("async function persistCursor(");
    const body = source.slice(i, source.indexOf("\n}", i));

    expect(body, "must persist the coerced number, not the raw argument").to.match(
      /lastProcessedBlock:\s*n\s*\}/,
    );
    expect(body, "must reject a non-finite block number rather than writing it").to.match(
      /Number\.isFinite\(n\)/,
    );
  });
});
