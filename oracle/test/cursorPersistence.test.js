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
});
