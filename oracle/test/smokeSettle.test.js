const { expect } = require("chai");

// Restart-check support for the Base-testnet smoke (CU-14ym9bvdmju).
//
// A run-day check restarts the ROFL oracle machine while a prompt is pending and proves exactly
// one answer arrives. Three pieces make that observable:
//   1. a SUBMITTED MARKER written as soon as every submit transaction is mined, so a runner knows
//      when to restart the machine;
//   2. a SETTLE WINDOW that keeps watching after the answers arrive, because a duplicate answer
//      (or a reverted duplicate, which spends a nonce but emits no event) lands after the first
//      answer has already passed the existing checks;
//   3. the verdict over those observations, which is pure and tested here against fakes.

const {
  createSubmitGate,
  buildSubmittedMarker,
  writeSubmittedMarker,
  observeSettle,
  evaluateSettle,
  runSettleWindow,
} = require("../scripts/smoke/settle.js");

const ORACLE = "0x00000000000000000000000000000000000000aa";
const ORACLE_CASED = "0x00000000000000000000000000000000000000AA";
const OTHER_ORACLE = "0x00000000000000000000000000000000000000bb";

const record = (i, over = {}) => ({
  index: i,
  account: `0x${String(i + 1).padStart(40, "0")}`,
  conversationId: 100n + BigInt(i),
  promptMessageId: 150n + BigInt(i),
  answerMessageId: 200n + BigInt(i),
  submitTxHash: `0x${"a".repeat(63)}${i}`,
  submitBlock: 1000 + i,
  cid: undefined,
  answerFrom: undefined,
  ...over,
});

/**
 * A fake chain for the observer. `events[i]` is the list of block numbers at which target i's
 * AnswerMessageAdded fires. `refuseOnce` holds "from-to" range keys the node refuses the first
 * time they are asked for; `refuseAlways` holds keys it refuses every time.
 */
function fakeChain({
  head,
  events = [],
  refuseOnce = new Set(),
  refuseAlways = new Set(),
  nonces = {},
}) {
  const calls = { queryFilter: [], getTransactionCount: [] };
  let currentHead = head;
  const agent = {
    filters: {
      AnswerMessageAdded: (conversationId, messageId) => ({
        conversationId: String(conversationId),
        messageId: String(messageId),
      }),
    },
    async queryFilter(filter, from, to) {
      calls.queryFilter.push({ filter, from, to });
      const key = `${from}-${to}`;
      if (refuseAlways.has(key)) throw new Error("block range too large");
      if (refuseOnce.has(key)) {
        refuseOnce.delete(key);
        throw new Error("block range too large");
      }
      const idx = Number(filter.messageId) - 200;
      const blocks = events[idx] || [];
      return blocks.filter((b) => b >= from && b <= to).map((b) => ({ blockNumber: b }));
    },
  };
  const provider = {
    async getBlockNumber() {
      return currentHead;
    },
    async getTransactionCount(address, blockTag) {
      calls.getTransactionCount.push({ address, blockTag });
      const v = nonces[`${address.toLowerCase()}@${blockTag}`];
      if (v === undefined) throw new Error(`no nonce for ${address}@${blockTag}`);
      return v;
    },
  };
  return {
    agent,
    provider,
    calls,
    advance(n) {
      currentHead += n;
    },
  };
}

/** Deterministic clock: every sleep advances it by the requested ms. */
function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, sleep: async (ms) => void (t += ms) };
}

describe("smoke settle: submit gate", () => {
  it("does not fire until every expected prompt has recorded its submit", () => {
    const fired = [];
    const gate = createSubmitGate({ expected: 3, onAllSubmitted: (rs) => fired.push(rs) });
    gate.record(record(0));
    gate.record(record(1));
    expect(fired).to.have.length(0);
    gate.record(record(2));
    expect(fired).to.have.length(1);
    expect(fired[0].map((r) => r.index)).to.deep.equal([0, 1, 2]);
  });

  it("fires exactly once even if a record arrives again", () => {
    const fired = [];
    const gate = createSubmitGate({ expected: 1, onAllSubmitted: (rs) => fired.push(rs) });
    gate.record(record(0));
    gate.record(record(0));
    expect(fired).to.have.length(1);
  });

  it("snapshots each record so later mutation of the prompt result cannot change the marker", () => {
    const fired = [];
    const gate = createSubmitGate({ expected: 1, onAllSubmitted: (rs) => fired.push(rs) });
    const live = record(0);
    gate.record(live);
    live.answerMessageId = 999n;
    expect(fired[0][0].answerMessageId).to.equal(200n);
  });
});

describe("smoke settle: submitted marker", () => {
  const now = () => Date.parse("2026-11-10T03:00:00.000Z");

  it("carries prompt/answer ids, tx hashes, block numbers and a timestamp, and no keys or RPC URL", () => {
    const marker = buildSubmittedMarker({
      env: "base-testnet",
      chainId: 84532,
      records: [record(1), record(0)],
      now,
    });
    expect(marker).to.deep.equal({
      env: "base-testnet",
      chainId: 84532,
      submittedAt: "2026-11-10T03:00:00.000Z",
      prompts: [
        {
          index: 0,
          conversationId: "100",
          promptMessageId: "150",
          answerMessageId: "200",
          submitTxHash: `0x${"a".repeat(63)}0`,
          submitBlock: 1000,
        },
        {
          index: 1,
          conversationId: "101",
          promptMessageId: "151",
          answerMessageId: "201",
          submitTxHash: `0x${"a".repeat(63)}1`,
          submitBlock: 1001,
        },
      ],
    });
    const text = JSON.stringify(marker);
    expect(text).not.to.match(/private|key|https?:/i);
    expect(text).not.to.include(record(0).account);
  });

  it("writes atomically: a temp file, then a rename onto the marker path, creating the directory", () => {
    const ops = [];
    const fsImpl = {
      mkdirSync: (dir, opts) => ops.push(["mkdir", dir, opts]),
      writeFileSync: (file, data) => ops.push(["write", file, data]),
      renameSync: (from, to) => ops.push(["rename", from, to]),
    };
    const marker = { env: "base-testnet", prompts: [] };
    const out = writeSubmittedMarker("/run/smoke/submitted.json", marker, { fsImpl });
    expect(out).to.equal("/run/smoke/submitted.json");
    expect(ops.map((o) => o[0])).to.deep.equal(["mkdir", "write", "rename"]);
    expect(ops[0][1]).to.equal("/run/smoke");
    const tmp = ops[1][1];
    expect(tmp).to.not.equal("/run/smoke/submitted.json");
    expect(JSON.parse(ops[1][2])).to.deep.equal(marker);
    expect(ops[2]).to.deep.equal(["rename", tmp, "/run/smoke/submitted.json"]);
  });
});

describe("smoke settle: observeSettle", () => {
  const cfg = { pollMs: 1000, logsBlockRange: 10 };

  it("counts every AnswerMessageAdded per target across the whole window, walking contiguous capped chunks", async () => {
    const chain = fakeChain({ head: 1025, events: [[1003, 1004], [1010]] });
    const clock = fakeClock();
    const obs = await observeSettle({
      agent: chain.agent,
      provider: chain.provider,
      targets: [
        { conversationId: 100n, answerMessageId: 200n },
        { conversationId: 101n, answerMessageId: 201n },
      ],
      fromBlock: 1000,
      settleMs: 3000,
      ...cfg,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(obs.counts).to.deep.equal([2, 1]);
    expect(obs.endBlock).to.equal(1025);
    for (const c of chain.calls.queryFilter) expect(c.to - c.from).to.be.at.most(9);
  });

  it("sees an answer that lands after the wait phase, once the head moves on", async () => {
    const chain = fakeChain({ head: 1000, events: [[1030]] });
    const clock = fakeClock();
    const obs = await observeSettle({
      agent: chain.agent,
      provider: chain.provider,
      targets: [{ conversationId: 100n, answerMessageId: 200n }],
      fromBlock: 1000,
      settleMs: 60_000,
      ...cfg,
      now: clock.now,
      sleep: async (ms) => {
        clock.sleep(ms);
        chain.advance(10);
      },
    });
    expect(obs.counts).to.deep.equal([1]);
  });

  it("keeps its place across a refused range and retries it, without skipping or double-counting", async () => {
    const chain = fakeChain({ head: 1009, events: [[1005]], refuseOnce: new Set(["1000-1009"]) });
    const clock = fakeClock();
    const logs = [];
    const obs = await observeSettle({
      agent: chain.agent,
      provider: chain.provider,
      targets: [{ conversationId: 100n, answerMessageId: 200n }],
      fromBlock: 1000,
      settleMs: 0,
      ...cfg,
      log: (l) => logs.push(l),
      now: clock.now,
      sleep: clock.sleep,
    });
    // settleMs 0 still performs the final catch-up; the refused chunk is retried and its event counted once.
    expect(obs.counts).to.deep.equal([1]);
    expect(logs.join("\n")).to.match(/refused/);
  });

  it("gives up with a named error when the final catch-up cannot be completed", async () => {
    const chain = fakeChain({ head: 1009, refuseAlways: new Set(["1000-1009"]) });
    const clock = fakeClock();
    let err;
    try {
      await observeSettle({
        agent: chain.agent,
        provider: chain.provider,
        targets: [{ conversationId: 100n, answerMessageId: 200n }],
        fromBlock: 1000,
        settleMs: 0,
        ...cfg,
        now: clock.now,
        sleep: clock.sleep,
      });
    } catch (e) {
      err = e;
    }
    expect(err).to.be.an("error");
    expect(err.message).to.match(/settle window incomplete/);
    expect(err.message).to.include("block range too large");
  });
});

describe("smoke settle: evaluateSettle", () => {
  const targets = [
    { index: 0, conversationId: 100n, answerMessageId: 200n, answered: true },
    { index: 1, conversationId: 101n, answerMessageId: 201n, answered: true },
  ];

  it("passes when each answer id has exactly one event and the oracle sent one tx per answer", () => {
    const v = evaluateSettle({
      targets,
      counts: [1, 1],
      senders: [ORACLE],
      nonce: { before: 40, after: 42 },
    });
    expect(v.verdict).to.equal("pass");
    expect(v.problems).to.deep.equal([]);
    expect(v.answerEventCounts).to.deep.equal([
      { index: 0, answerMessageId: "200", count: 1 },
      { index: 1, answerMessageId: "201", count: 1 },
    ]);
    expect(v.oracleNonce).to.deep.equal({
      address: ORACLE,
      before: 40,
      after: 42,
      delta: 2,
      answered: 2,
    });
  });

  it("fails naming the answer id when a second AnswerMessageAdded appears for it", () => {
    const v = evaluateSettle({
      targets,
      counts: [2, 1],
      senders: [ORACLE],
      nonce: { before: 40, after: 42 },
    });
    expect(v.verdict).to.equal("fail");
    expect(v.problems.join("\n")).to.match(/answerMessageId 200 \(prompt 0\)/);
    expect(v.problems.join("\n")).to.match(/2 AnswerMessageAdded/);
  });

  it("fails when the oracle nonce rose by more than one per answered prompt, even with one event each", () => {
    // A reverted duplicate submitAnswer spends a nonce and emits nothing; only the nonce sees it.
    const v = evaluateSettle({
      targets,
      counts: [1, 1],
      senders: [ORACLE],
      nonce: { before: 40, after: 43 },
    });
    expect(v.verdict).to.equal("fail");
    expect(v.problems.join("\n")).to.match(/sent 3 transaction/);
    expect(v.problems.join("\n")).to.match(/2 answered prompt/);
  });

  it("treats addresses that differ only in case as the same oracle", () => {
    const v = evaluateSettle({
      targets,
      counts: [1, 1],
      senders: [ORACLE, ORACLE_CASED],
      nonce: { before: 1, after: 3 },
    });
    expect(v.verdict).to.equal("pass");
  });

  it("fails when answers came from two different senders, since the nonce cannot be attributed", () => {
    const v = evaluateSettle({
      targets,
      counts: [1, 1],
      senders: [ORACLE, OTHER_ORACLE],
      nonce: null,
    });
    expect(v.verdict).to.equal("fail");
    expect(v.problems.join("\n")).to.match(/2 different senders/);
  });

  it("fails when no answer transaction sender is known, rather than passing an unchecked nonce", () => {
    const v = evaluateSettle({ targets, counts: [1, 1], senders: [], nonce: null });
    expect(v.verdict).to.equal("fail");
    expect(v.problems.join("\n")).to.match(/nonce cannot be checked/);
  });
});

describe("smoke settle: runSettleWindow", () => {
  const cfg = { settleMs: 3000, pollMs: 1000, logsBlockRange: 10 };

  it("skips, with no problems, when no prompt was answered", async () => {
    const chain = fakeChain({ head: 1010 });
    const out = await runSettleWindow({
      agent: chain.agent,
      provider: chain.provider,
      results: [record(0, { error: "TIMEOUT" })],
      cfg,
      now: fakeClock().now,
      sleep: fakeClock().sleep,
    });
    expect(out.verdict).to.equal("skipped");
    expect(out.problems).to.deep.equal([]);
    expect(chain.calls.queryFilter).to.have.length(0);
  });

  it("observes from the earliest submit block, reads the oracle nonce before and after, and records the duration", async () => {
    const chain = fakeChain({
      head: 1020,
      events: [[1003], [1004]],
      nonces: { [`${ORACLE}@1000`]: 7, [`${ORACLE}@1023`]: 9 },
    });
    const clock = fakeClock(5_000);
    const results = [
      record(0, { cid: "bafy0", answerFrom: ORACLE, submitBlock: 1003 }),
      record(1, { cid: "bafy1", answerFrom: ORACLE, submitBlock: 1000 }),
    ];
    const out = await runSettleWindow({
      agent: chain.agent,
      provider: chain.provider,
      results,
      cfg,
      now: clock.now,
      sleep: async (ms) => {
        clock.sleep(ms);
        chain.advance(1);
      },
    });
    expect(out.fromBlock).to.equal(1000);
    expect(out.verdict).to.equal("pass");
    expect(out.durationMs).to.be.at.least(3000);
    expect(out.oracleNonce).to.include({
      address: ORACLE,
      before: 7,
      after: 9,
      delta: 2,
      answered: 2,
    });
    expect(chain.calls.getTransactionCount[0]).to.deep.equal({ address: ORACLE, blockTag: 1000 });
  });

  it("turns an unreadable nonce into a failed verdict instead of throwing out of the run", async () => {
    const chain = fakeChain({ head: 1010, events: [[1003]] });
    const clock = fakeClock();
    const out = await runSettleWindow({
      agent: chain.agent,
      provider: chain.provider,
      results: [record(0, { cid: "bafy0", answerFrom: ORACLE })],
      cfg,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(out.verdict).to.equal("fail");
    expect(out.problems.join("\n")).to.match(/settle window could not be completed/);
  });
});
