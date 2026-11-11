/**
 * Restart-check support for the Base-testnet smoke (CU-14ym9bvdmju).
 *
 * A run-day check restarts the ROFL oracle machine while prompts are pending and proves that
 * exactly one answer arrives per prompt. Three pieces:
 *
 *   1. createSubmitGate / buildSubmittedMarker / writeSubmittedMarker — the SUBMITTED MARKER. Written
 *      once every prompt's submit transaction is mined, so the runner that restarts the machine
 *      knows the moment to do it. No keys and no RPC URL ever enter it.
 *   2. observeSettle — the SETTLE WINDOW observer. After the answers arrive it keeps walking the
 *      chain for SMOKE_SETTLE_MS and counts every AnswerMessageAdded for each answer id, reading
 *      the same contiguous, capped eth_getLogs chunks as answerWait.js (providers refuse wider
 *      ranges outright).
 *   3. evaluateSettle — the verdict. Pure over its inputs. A second event for one answer id fails;
 *      so does an oracle nonce that rose by more than one per answered prompt. The nonce check is
 *      there because a duplicate submitAnswer that reverts (the contract's JobAlreadyFinalized)
 *      spends a nonce and emits nothing, so the event count alone cannot see it.
 *
 * Every clock, provider and filesystem is injected so the tests run against fakes.
 */
const fs = require("node:fs");
const path = require("node:path");

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FINAL_CATCH_UP_ATTEMPTS = 5;

const errorText = (e) => e?.shortMessage || e?.message || String(e);

/**
 * Collects each prompt's submit record as its transaction is mined; fires `onAllSubmitted` once,
 * with the records in prompt-index order, when the last expected prompt has recorded.
 */
function createSubmitGate({ expected, onAllSubmitted }) {
  const records = new Map();
  let fired = false;
  return {
    record(result) {
      if (fired) return;
      records.set(result.index, { ...result });
      if (records.size < expected) return;
      fired = true;
      onAllSubmitted([...records.values()].sort((a, b) => a.index - b.index));
    },
  };
}

/** The marker a restart runner watches for. Ids, tx hashes, blocks and a timestamp only. */
function buildSubmittedMarker({ env, chainId, records, now = Date.now }) {
  return {
    env,
    chainId,
    submittedAt: new Date(now()).toISOString(),
    prompts: [...records]
      .sort((a, b) => a.index - b.index)
      .map((r) => ({
        index: r.index,
        conversationId: String(r.conversationId),
        promptMessageId: String(r.promptMessageId),
        answerMessageId: String(r.answerMessageId),
        submitTxHash: r.submitTxHash,
        submitBlock: r.submitBlock,
      })),
  };
}

/**
 * Writes the marker via a temp file and a rename, so a watcher that polls for the path never reads
 * a half-written file. Returns the path written.
 */
function writeSubmittedMarker(file, marker, { fsImpl = fs } = {}) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  fsImpl.mkdirSync(dir, { recursive: true });
  fsImpl.writeFileSync(tmp, `${JSON.stringify(marker, null, 2)}\n`);
  fsImpl.renameSync(tmp, file);
  return file;
}

/**
 * Walks every target's AnswerMessageAdded filter forward from `fromBlock`, counting events, for
 * `settleMs`, then catches up to the head. Each target keeps its own cursor and advances it only
 * past chunks that were actually read, so a refused chunk is retried, never skipped or counted
 * twice.
 *
 * @returns {Promise<{durationMs: number, endBlock: number, counts: number[], txHashes: string[]}>}
 *   `txHashes` are the distinct transactions that emitted the counted events
 */
async function observeSettle({
  agent,
  provider,
  targets,
  fromBlock,
  settleMs,
  pollMs,
  logsBlockRange,
  log = () => {},
  now = Date.now,
  sleep = defaultSleep,
}) {
  const range = Math.max(1, Math.floor(logsBlockRange));
  const start = now();
  const deadline = start + settleMs;
  const filters = targets.map((t) =>
    agent.filters.AnswerMessageAdded(t.conversationId, t.answerMessageId),
  );
  const cursors = targets.map(() => fromBlock);
  const counts = targets.map(() => 0);
  const txHashes = new Set();
  let head;

  /** One pass to the current head. Returns the last RPC error, or null when fully caught up. */
  async function scan() {
    head = await provider.getBlockNumber();
    let lastError = null;
    for (let i = 0; i < targets.length; i++) {
      while (cursors[i] <= head) {
        const to = Math.min(head, cursors[i] + range - 1);
        let evts;
        try {
          evts = await agent.queryFilter(filters[i], cursors[i], to);
        } catch (e) {
          lastError = errorText(e);
          log(
            `eth_getLogs refused for blocks ${cursors[i]}-${to}: ${lastError} — retrying next pass`,
          );
          break; // this target's chunk is unread; keep its cursor
        }
        counts[i] += evts.length;
        for (const e of evts) if (e.transactionHash) txHashes.add(e.transactionHash);
        cursors[i] = to + 1;
      }
    }
    return lastError;
  }

  while (now() < deadline) {
    try {
      await scan();
    } catch (e) {
      log(`transient RPC error during settle (${errorText(e)}) — retrying...`);
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollMs, remaining));
  }

  // Final catch-up to the head: the window is not closed until every block has been read.
  let lastError = "no attempt";
  for (let attempt = 1; attempt <= FINAL_CATCH_UP_ATTEMPTS; attempt++) {
    try {
      const err = await scan();
      if (!err)
        return { durationMs: now() - start, endBlock: head, counts, txHashes: [...txHashes] };
      lastError = err;
    } catch (e) {
      lastError = errorText(e);
    }
    if (attempt < FINAL_CATCH_UP_ATTEMPTS) await sleep(pollMs);
  }
  throw new Error(
    `settle window incomplete after ${FINAL_CATCH_UP_ATTEMPTS} attempts (last RPC error: ${lastError})`,
  );
}

/**
 * The verdict over one settle window. Pure.
 *
 * @param {object} args
 * @param {Array<{index: number, conversationId: any, answerMessageId: any, answered: boolean}>} args.targets
 * @param {number[]} args.counts  AnswerMessageAdded events seen per target over the window
 * @param {string[]} args.senders  distinct sender addresses of the answer transactions
 * @param {{before: number, after: number} | null} args.nonce  oracle nonce at the window's edges
 */
function evaluateSettle({ targets, counts, senders, nonce }) {
  const problems = [];
  const answeredCount = targets.filter((t) => t.answered).length;

  // The window opens at the earliest submit block, so an answered prompt's own event is always
  // inside it: 0 means the observer missed it, 2 or more means a duplicate. A prompt the run
  // never saw answered must stay that way.
  targets.forEach((t, i) => {
    const expected = t.answered ? 1 : 0;
    if (counts[i] !== expected)
      problems.push(
        `answerMessageId ${String(t.answerMessageId)} (prompt ${t.index}) has ${counts[i]} AnswerMessageAdded event(s) in the settle window (expected ${expected === 1 ? "exactly 1" : "0 — the run did not see it answered"})`,
      );
  });

  let oracleNonce = null;
  const unique = [...new Set(senders.map((s) => s.toLowerCase()))];
  if (unique.length === 0) {
    problems.push(
      "no answer transaction sender was recorded, so the oracle nonce cannot be checked",
    );
  } else if (unique.length > 1) {
    problems.push(
      `answers were submitted from ${unique.length} different senders (${unique.join(", ")}) — expected one oracle`,
    );
  } else if (nonce) {
    const delta = nonce.after - nonce.before;
    oracleNonce = {
      address: unique[0],
      before: nonce.before,
      after: nonce.after,
      delta,
      answered: answeredCount,
    };
    if (delta > answeredCount)
      problems.push(
        `oracle ${unique[0]} sent ${delta} transaction(s) in the settle window for ${answeredCount} answered prompt(s) — at most one submitAnswer per prompt, so this is a duplicate attempt or an unrelated transaction from the oracle account`,
      );
  }

  return {
    verdict: problems.length ? "fail" : "pass",
    problems,
    answerEventCounts: targets.map((t, i) => ({
      index: t.index,
      answerMessageId: String(t.answerMessageId),
      count: counts[i],
    })),
    oracleNonce,
  };
}

/**
 * Runs the whole settle window for a finished run. Never throws: an unreadable chain becomes a
 * failed verdict, so the metrics file is still written. With no answered prompt there is nothing
 * to settle against and the verdict is "skipped" (the run already fails for the missing answers).
 *
 * @returns {Promise<object>} the `settle` block for the metrics file
 */
async function runSettleWindow({
  agent,
  provider,
  results,
  cfg,
  log = () => {},
  now = Date.now,
  sleep = defaultSleep,
}) {
  const targets = results
    .filter((r) => r.conversationId !== undefined && r.answerMessageId !== undefined)
    .map((r) => ({
      index: r.index,
      conversationId: r.conversationId,
      answerMessageId: r.answerMessageId,
      answered: r.cid != null,
      submitBlock: r.submitBlock,
    }));
  const answered = targets.filter((t) => t.answered);
  const base = { settleMs: cfg.settleMs, fromBlock: null, endBlock: null, durationMs: 0 };
  if (!answered.length)
    return { ...base, verdict: "skipped", problems: [], answerEventCounts: [], oracleNonce: null };

  const fromBlock = Math.min(...targets.map((t) => t.submitBlock));
  const senders = results.filter((r) => r.cid != null && r.answerFrom).map((r) => r.answerFrom);
  log(`settle window: observing ${cfg.settleMs} ms from block ${fromBlock}...`);

  try {
    const obs = await observeSettle({
      agent,
      provider,
      targets,
      fromBlock,
      settleMs: cfg.settleMs,
      pollMs: cfg.pollMs,
      logsBlockRange: cfg.logsBlockRange,
      log,
      now,
      sleep,
    });
    if (!senders.length) {
      // The run's answer metadata is best-effort; the window saw the answer transactions itself.
      for (const hash of obs.txHashes) {
        const tx = await provider.getTransaction(hash);
        if (tx?.from) senders.push(tx.from);
      }
    }
    const unique = [...new Set(senders.map((s) => s.toLowerCase()))];
    let nonce = null;
    if (unique.length === 1) {
      // Read at the submit block (before any answer) and at the end of the window, so the delta
      // covers every submitAnswer the oracle sent in between.
      const before = await provider.getTransactionCount(unique[0], fromBlock);
      const after = await provider.getTransactionCount(unique[0], obs.endBlock);
      nonce = { before, after };
    }
    const verdict = evaluateSettle({ targets, counts: obs.counts, senders, nonce });
    return { ...base, fromBlock, endBlock: obs.endBlock, durationMs: obs.durationMs, ...verdict };
  } catch (e) {
    return {
      ...base,
      fromBlock,
      verdict: "fail",
      problems: [`settle window could not be completed: ${errorText(e)}`],
      answerEventCounts: [],
      oracleNonce: null,
    };
  }
}

module.exports = {
  createSubmitGate,
  buildSubmittedMarker,
  writeSubmittedMarker,
  observeSettle,
  evaluateSettle,
  runSettleWindow,
};
