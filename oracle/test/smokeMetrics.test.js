const { expect } = require("chai");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// smoke-metrics.json (CU-14ym9bvdmjr, for CU-14ym9bvahuz): per-prompt ids, gas for the user's
// initiatePrompt and the oracle's submitAnswer, submit-to-answer latency both by wall clock and
// by block timestamp, and a summary — written on EVERY run, pass or fail.

const { buildMetrics, writeMetrics } = require("../scripts/smoke/metrics.js");

const prompt = (i, over = {}) => ({
  index: i,
  account: `0x${String(i).padStart(40, "0")}`,
  conversationId: String(100 + i),
  promptMessageId: String(150 + i),
  answerMessageId: String(200 + i),
  submitTxHash: `0x${"a".repeat(63)}${i}`,
  submitBlock: 1000 + i,
  submitGasUsed: 150000n + BigInt(i),
  submitTimestamp: 1_700_000_000 + i,
  answerTxHash: `0x${"b".repeat(63)}${i}`,
  answerBlock: 1010 + i,
  answerGasUsed: 400000n + BigInt(i) * 1000n,
  answerTimestamp: 1_700_000_020 + i * 10,
  cid: `bafkr6i${"c".repeat(40)}${i}`,
  latencyMs: 20_000 + i * 10_000,
  verdict: "pass",
  ...over,
});

describe("smoke: buildMetrics", () => {
  it("summarises gas, latency and verdicts and keeps every per-prompt id", () => {
    const m = buildMetrics({
      env: "base-testnet",
      chainId: 84532,
      mode: { burst: 3, injection: false },
      startedAt: "2026-10-28T04:00:00.000Z",
      finishedAt: "2026-10-28T04:01:30.000Z",
      prompts: [prompt(0), prompt(1), prompt(2, { verdict: "fail", error: "TIMEOUT" })],
      oracleNonce: { before: 41, after: 44 },
    });
    expect(m.env).to.equal("base-testnet");
    expect(m.mode).to.deep.equal({ burst: 3, injection: false });
    expect(m.prompts).to.have.length(3);
    expect(m.prompts[0].answerGasUsed).to.equal("400000"); // BigInt serialised as decimal string
    expect(m.prompts[0].chainLatencyS).to.equal(20);
    expect(m.summary.count).to.equal(3);
    expect(m.summary.passed).to.equal(2);
    expect(m.summary.failed).to.equal(1);
    expect(m.summary.latencyMs).to.deep.equal({ min: 20000, p50: 30000, max: 40000 });
    expect(m.summary.answerGasUsed).to.deep.equal({ total: "1203000", mean: "401000" });
    expect(m.summary.submitGasUsed.total).to.equal("450003");
    expect(m.oracleNonce).to.deep.equal({ before: 41, after: 44, delta: 3 });
    expect(m.modelSpend.note).to.match(/logs/);
  });

  it("copes with a prompt that never answered (no answer receipt)", () => {
    const m = buildMetrics({
      env: "base-testnet",
      chainId: 84532,
      mode: { burst: 1, injection: false },
      startedAt: "2026-10-28T04:00:00.000Z",
      finishedAt: "2026-10-28T04:05:00.000Z",
      prompts: [
        prompt(0, {
          answerTxHash: undefined,
          answerBlock: undefined,
          answerGasUsed: undefined,
          answerTimestamp: undefined,
          cid: undefined,
          latencyMs: undefined,
          verdict: "fail",
          error: "TIMEOUT",
        }),
      ],
    });
    expect(m.prompts[0].answerGasUsed).to.equal(null);
    expect(m.prompts[0].chainLatencyS).to.equal(null);
    expect(m.summary.latencyMs).to.deep.equal({ min: null, p50: null, max: null });
    expect(m.summary.answerGasUsed).to.deep.equal({ total: "0", mean: null });
    expect(m.oracleNonce).to.equal(null);
  });
});

describe("smoke: writeMetrics", () => {
  it("writes pretty JSON, creating the directory, and returns the path", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-metrics-"));
    const file = path.join(dir, "nested", "smoke-metrics.json");
    try {
      const out = writeMetrics(file, { summary: { count: 1 }, prompts: [{ answerGasUsed: "1" }] });
      expect(out).to.equal(file);
      const back = JSON.parse(fs.readFileSync(file, "utf8"));
      expect(back.summary.count).to.equal(1);
      expect(fs.readFileSync(file, "utf8")).to.match(/\n {2}"summary"/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
