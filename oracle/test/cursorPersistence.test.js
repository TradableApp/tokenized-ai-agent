const { expect } = require("chai");
const sinon = require("sinon");
const { ethers } = require("ethers");
const fs = require("node:fs");
const path = require("node:path");

const { createTempStateStore } = require("./helpers/tempStateStore");

// GUARD on the chain-cursor write path (CU-86d438hwt).
//
// The cursor is written from several places in aiAgentOracle.js. The heartbeat needs the current
// value, and reading it back from storage to get it caused an intermittent null (see
// oracleVitals.test.js). The fix routes every write through one helper that updates the in-memory
// value AND the state store — so the heartbeat can read memory.
//
// This guard exists because "update all N call sites" is a mistake I have already made once in
// this feature: the provider tally missed five of ten return points, including the exact branch
// it was written to observe. A store write that bypasses the helpers leaves the in-memory value
// stale, and a stale cursor reports a growing blockLag for an oracle that is perfectly healthy —
// a false alarm, which is the failure mode this whole feature exists to avoid.
//
// There are two helpers now, not one: `persistCursor` only moves the cursor forward, and
// `rewindCursor` — the one way back — belongs to the reorg branch alone. A rewind anywhere else
// would make the oracle re-answer blocks it has already finished.

const SOURCE = fs.readFileSync(path.join(__dirname, "../src/aiAgentOracle.js"), "utf-8");

/** [start, end) of a top-level function's body, ending at its closing brace in column 0. */
function functionExtent(source, signature) {
  const start = source.indexOf(signature);
  expect(start, `${signature} should exist`).to.be.greaterThan(-1);
  return [start, source.indexOf("\n}", start)];
}

/** [start, end) of the block opened by the first `{` at or after `from`, by brace matching. */
function blockExtent(source, from) {
  const open = source.indexOf("{", from);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}" && --depth === 0) return [open, i + 1];
  }
  throw new Error("unbalanced braces");
}

/** Every match of `pattern` as `L<line>: <text>`, with its offset, for readable failures. */
function matchesOf(source, pattern) {
  const lines = source.split("\n");
  return [...source.matchAll(pattern)].map((m) => {
    const line = source.slice(0, m.index).split("\n").length;
    return { offset: m.index, label: `L${line}: ${lines[line - 1].trim()}` };
  });
}

const outside = ([start, end]) => ({ offset }) => offset < start || offset >= end;

describe("chain cursor persistence", () => {
  describe("structure of aiAgentOracle.js", () => {
    it("touches no state file directly — the store owns the files", () => {
      // The files are the state store's business (oracleState/store.js). A raw read or write here
      // would bypass both the in-memory cursor and the Postgres backend.
      expect(
        matchesOf(SOURCE, /require\(\s*["'](node:)?fs(\/promises)?["']\s*\)/g).map((m) => m.label),
      ).to.deep.equal([]);
      expect(
        matchesOf(SOURCE, /\bfs\.(writeFile|readFile|appendFile|rename|unlink)\w*\(/g).map(
          (m) => m.label,
        ),
      ).to.deep.equal([]);
    });

    it("advances the stored cursor only inside persistCursor", () => {
      const rogue = matchesOf(SOURCE, /\.advanceCursor\(/g).filter(
        outside(functionExtent(SOURCE, "async function persistCursor(")),
      );
      expect(
        rogue.map((m) => m.label),
        "these bypass persistCursor() and will leave the in-memory cursor stale",
      ).to.deep.equal([]);
    });

    it("rewinds the stored cursor only inside rewindCursor", () => {
      const rogue = matchesOf(SOURCE, /\.rewindCursor\(/g).filter(
        outside(functionExtent(SOURCE, "async function rewindCursor(")),
      );
      expect(
        rogue.map((m) => m.label),
        "these bypass rewindCursor() and will leave the in-memory cursor stale",
      ).to.deep.equal([]);
    });

    it("calls rewindCursor only from the reorg branch", () => {
      const reorgIf = SOURCE.indexOf("if (reconciledBlock !== currentBlock)");
      expect(reorgIf, "the reorg branch should exist").to.be.greaterThan(-1);

      // Calls only: not the definition, not the store method it delegates to.
      const calls = matchesOf(SOURCE, /(?<![\w.])rewindCursor\(/g).filter(
        ({ offset }) => !SOURCE.slice(0, offset).endsWith("function "),
      );
      expect(calls, "the reorg branch must rewind the cursor").to.have.lengthOf.at.least(1);
      expect(
        calls.filter(outside(blockExtent(SOURCE, reorgIf))).map((m) => m.label),
        "only a reorg may move the cursor backwards",
      ).to.deep.equal([]);
    });

    it("defines the helpers it depends on (so the guard cannot pass vacuously)", () => {
      expect(SOURCE).to.match(/async function persistCursor\(/);
      expect(SOURCE).to.match(/async function rewindCursor\(/);
      expect(SOURCE).to.include("getLastProcessedBlock");
      // If the store's method names changed, the two guards above would find nothing to flag.
      expect(matchesOf(SOURCE, /stateStore\.advanceCursor\(/g)).to.have.lengthOf(1);
      expect(matchesOf(SOURCE, /stateStore\.rewindCursor\(/g)).to.have.lengthOf(1);
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
      const start = SOURCE.indexOf("async function pollEvents(");
      expect(start, "pollEvents should exist").to.be.greaterThan(-1);
      const end = SOURCE.indexOf("\nasync function ", start + 1);
      const body = SOURCE.slice(start, end === -1 ? undefined : end);

      expect(body, "pollEvents must not reference start()'s local `state`").to.not.match(
        /\bstate\.lastProcessedBlock\b/,
      );
    });
  });

  it("never saves the cursor from the per-event wrapper", () => {
    // handleAndRecord runs once per event, up to five at a time, finishing out of order. A save
    // from there can move the cursor past an earlier event that is still being answered; only
    // the scan loops, which wait for the whole batch, may save it.
    const start = SOURCE.indexOf("async function handleAndRecord(");
    expect(start, "handleAndRecord should exist").to.be.greaterThan(-1);
    const end = SOURCE.indexOf("\nasync function ", start + 1);
    const body = SOURCE.slice(start, end === -1 ? undefined : end);

    expect(body).to.not.match(/\b(persistCursor|rewindCursor)\s*\(/);
  });

  describe("behaviour", () => {
    // aiAgentOracle builds a signer at module load, so the placeholder key in
    // .env.oracle.example is not enough. Scoped to this suite, as in failedJobsProbe.test.js.
    let oracle;
    let saved;
    let temp;

    before(() => {
      const w = ethers.Wallet.createRandom();
      saved = { pk: process.env.PRIVATE_KEY, addr: process.env.AI_AGENT_CONTRACT_ADDRESS };
      process.env.PRIVATE_KEY = w.privateKey;
      process.env.AI_AGENT_CONTRACT_ADDRESS = w.address;
      delete require.cache[require.resolve("../src/aiAgentOracle")];
      oracle = require("../src/aiAgentOracle");
    });

    after(() => {
      if (saved.pk === undefined) delete process.env.PRIVATE_KEY;
      else process.env.PRIVATE_KEY = saved.pk;
      if (saved.addr === undefined) delete process.env.AI_AGENT_CONTRACT_ADDRESS;
      else process.env.AI_AGENT_CONTRACT_ADDRESS = saved.addr;
      delete require.cache[require.resolve("../src/aiAgentOracle")];
    });

    beforeEach(() => {
      temp = createTempStateStore();
      // Injecting a store also resets the in-memory cursor to null.
      oracle.initForTest({ stateStore: temp.store });
    });

    afterEach(() => {
      sinon.restore();
      temp.cleanup();
    });

    it("writes the SAME coerced value to memory and to the store", async () => {
      // The two copies must never diverge — that divergence is the bug class this whole file
      // exists for. ethers can hand back a BigInt; both copies must hold the same plain number.
      await oracle.persistCursor(120n);

      expect(oracle.getLastProcessedBlock()).to.equal(120);
      expect(await temp.store.loadCursor()).to.equal(120);
    });

    it("rejects a non-finite block number rather than writing it", async () => {
      await oracle.persistCursor(50);

      let thrown;
      await oracle.persistCursor(Number.NaN).catch((error) => (thrown = error));

      expect(thrown).to.be.instanceOf(TypeError);
      expect(oracle.getLastProcessedBlock()).to.equal(50);
      expect(await temp.store.loadCursor()).to.equal(50);
    });

    it("ignores a LOWER block: neither memory nor the store moves back", async () => {
      // Handlers finish out of order, so an older block can be reported after a newer one.
      await oracle.persistCursor(200);

      await oracle.persistCursor(150);

      expect(oracle.getLastProcessedBlock()).to.equal(200);
      expect(await temp.store.loadCursor()).to.equal(200);
    });

    it("keeps going when the store cannot be written, with memory holding the new value", async () => {
      // A database outage must not stop the poll loop; the next good write catches the store up.
      const failing = {
        ...temp.store,
        advanceCursor: sinon.stub().rejects(new Error("connection refused")),
      };
      oracle.initForTest({ stateStore: failing });
      const logged = sinon.stub(console, "error");

      await oracle.persistCursor(300);

      expect(oracle.getLastProcessedBlock()).to.equal(300);
      expect(failing.advanceCursor.calledOnceWith(300)).to.be.true;
      expect(logged.calledWithMatch(/Could not store cursor 300/)).to.be.true;
    });

    it("rewindCursor moves memory and the store back together", async () => {
      await oracle.persistCursor(500);

      await oracle.rewindCursor(480);

      expect(oracle.getLastProcessedBlock()).to.equal(480);
      expect(await temp.store.loadCursor()).to.equal(480);
    });
  });
});
