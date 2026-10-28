/**
 * Burst mode: N prompts from N accounts at once, exercising the oracle's p-queue and tx mutex.
 *
 * The contract reverts a second submitAnswer for the same id (JobAlreadyFinalized), so a
 * duplicated answer cannot show up as two finalisations. What CAN go wrong under concurrency is
 * cross-wiring — one answer's CID or id landing on another prompt — or more than one
 * AnswerMessageAdded log for a single id. This is the judgement over the per-prompt results;
 * answer QUALITY is judged per prompt by assessAnswer, upstream of this.
 */

const groupShared = (results, key) => {
  const byValue = new Map();
  results.forEach((r) => {
    const v = r[key];
    if (v === undefined || v === null) return;
    const k = String(v);
    byValue.set(k, [...(byValue.get(k) || []), r.index]);
  });
  return [...byValue.entries()].filter(([, idx]) => idx.length > 1);
};

/**
 * @param {Array<{index: number, answerMessageId?: string|bigint, cid?: string,
 *   answerEventCount?: number, error?: string}>} results
 * @param {{expected?: number}} [opts]
 * @returns {{ok: boolean, problems: string[]}}
 */
function assertOneAnswerPerPrompt(results, { expected } = {}) {
  const problems = [];

  if (expected !== undefined && results.length !== expected)
    problems.push(`expected ${expected} prompt results, got ${results.length}`);

  results.forEach((r) => {
    // An errored prompt has no events by definition — one line for it, not two.
    if (r.error) problems.push(`prompt ${r.index} did not get an answer: ${r.error}`);
    else if (r.answerEventCount !== 1)
      problems.push(
        `prompt ${r.index} has ${r.answerEventCount ?? 0} AnswerMessageAdded logs for ` +
          `answerMessageId ${r.answerMessageId} (expected exactly 1)`,
      );
  });

  groupShared(results, "answerMessageId").forEach(([id, idx]) =>
    problems.push(`answerMessageId ${id} is shared by prompts ${idx.join(", ")}`),
  );
  groupShared(results, "cid").forEach(([cid, idx]) =>
    problems.push(`CID ${cid} is shared by prompts ${idx.join(", ")} — answers cross-wired`),
  );

  return { ok: problems.length === 0, problems };
}

module.exports = { assertOneAnswerPerPrompt };
