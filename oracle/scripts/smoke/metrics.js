/**
 * smoke-metrics.json: per-prompt ids, gas for the user's initiatePrompt and the oracle's
 * submitAnswer, submit-to-answer latency by wall clock and by block timestamp, and a summary.
 * Written on EVERY run, pass or fail, so a failed run still leaves the numbers behind.
 *
 * BigInt gas values serialise as decimal strings — JSON has no BigInt and a Number would round
 * past 2^53 on a mainnet total eventually.
 */
const fs = require("node:fs");
const path = require("node:path");

const big = (v) => (v === undefined || v === null ? null : String(v));
const num = (v) => (v === undefined || v === null ? null : Number(v));

const sumBig = (values) => values.reduce((acc, v) => acc + BigInt(v), 0n);

/** Conventional median: the middle sample, or the rounded mean of the two middle samples. */
function median(sorted) {
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  return n % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function latencySummary(values) {
  const sorted = values.filter((v) => v != null).sort((a, b) => a - b);
  if (!sorted.length) return { min: null, p50: null, max: null };
  return { min: sorted[0], p50: median(sorted), max: sorted[sorted.length - 1] };
}

/** No samples → null, not "0": a run where nothing was submitted did not cost zero gas. */
function gasSummary(values) {
  const present = values.filter((v) => v != null);
  if (!present.length) return { total: null, mean: null };
  const total = sumBig(present);
  return { total: total.toString(), mean: (total / BigInt(present.length)).toString() };
}

/**
 * @param {{env: string, chainId: number, mode: {burst: number, injection: boolean},
 *   startedAt: string, finishedAt: string, prompts: object[],
 *   oracleNonce?: {before: number, after: number} | null}} run
 */
function buildMetrics({ env, chainId, mode, startedAt, finishedAt, prompts, oracleNonce }) {
  const rows = prompts.map((p) => ({
    index: p.index,
    account: p.account,
    conversationId: big(p.conversationId),
    promptMessageId: big(p.promptMessageId),
    answerMessageId: big(p.answerMessageId),
    submitTxHash: p.submitTxHash ?? null,
    submitBlock: num(p.submitBlock),
    submitGasUsed: big(p.submitGasUsed),
    submitTimestamp: num(p.submitTimestamp),
    answerTxHash: p.answerTxHash ?? null,
    answerBlock: num(p.answerBlock),
    answerGasUsed: big(p.answerGasUsed),
    answerTimestamp: num(p.answerTimestamp),
    cid: p.cid ?? null,
    latencyMs: num(p.latencyMs),
    chainLatencyS:
      p.answerTimestamp != null && p.submitTimestamp != null
        ? Number(p.answerTimestamp) - Number(p.submitTimestamp)
        : null,
    verdict: p.verdict,
    error: p.error ?? null,
  }));

  return {
    env,
    chainId,
    mode,
    startedAt,
    finishedAt,
    prompts: rows,
    summary: {
      count: rows.length,
      passed: rows.filter((r) => r.verdict === "pass").length,
      failed: rows.filter((r) => r.verdict !== "pass").length,
      latencyMs: latencySummary(rows.map((r) => r.latencyMs)),
      chainLatencyS: latencySummary(rows.map((r) => r.chainLatencyS)),
      submitGasUsed: gasSummary(rows.map((r) => r.submitGasUsed)),
      answerGasUsed: gasSummary(rows.map((r) => r.answerGasUsed)),
    },
    oracleNonce: oracleNonce
      ? {
          before: oracleNonce.before,
          after: oracleNonce.after,
          delta: oracleNonce.after - oracleNonce.before,
        }
      : null,
    modelSpend: {
      note:
        "Token counts are not persisted by the oracle. Model calls for this window are in the oracle's " +
        "Postgres `logs` table: SELECT type, body->>'provider', body->>'executionTime', created_at " +
        "FROM logs WHERE type LIKE 'useModel:%' AND created_at BETWEEN startedAt AND finishedAt.",
    },
  };
}

/** Writes pretty JSON, creating the directory; returns the path written. */
function writeMetrics(file, metrics) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(metrics, null, 2)}\n`);
  return file;
}

module.exports = { buildMetrics, writeMetrics };
