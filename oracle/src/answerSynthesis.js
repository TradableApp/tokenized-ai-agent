/**
 * Turns action results into the user-facing answer.
 *
 * WHY. `selectAnswer` stops a tool payload being stored, but it cannot invent an answer — so a
 * tool-using prompt returns the acknowledgement ("Analysing current market intelligence. Stand
 * by."), which is honest and useless: the user paid for analysis and got a status message.
 *
 * sense-ai-core solves this in `utils/actionChainHelper.ts::handleChainSynthesis` — at the last
 * step of the action chain it feeds the ACTION RESULTS into a synthesis prompt and generates the
 * user-facing text from them. Tool output is raw material, never the reply. This is the oracle's
 * equivalent, kept free of ElizaOS action plumbing so the rule is testable without a runtime.
 *
 * TWO CONSTRAINTS CORE DOES NOT HAVE.
 *
 * Paid path — this is an extra LLM call before the user gets anything, on a prompt already
 * charged for on-chain. It is deadline-bounded and returns null on any failure so the caller can
 * fall back to `selectAnswer`. A worse answer beats no answer; an unbounded call is how a prompt
 * times out on-chain with nothing delivered.
 *
 * Concurrency — the oracle drains prompts through a p-queue at concurrency 5, while core's helper
 * was written for a chat loop with one turn in flight. Everything here is per-call: no
 * module-level state, so two syntheses cannot interleave one user's answer into another's
 * immutable MessageFile.
 */

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Mirrors core's chainSynthesisTemplate: the model is given the question and the data the actions
 * returned, and asked for the reply. The instruction to answer FROM the data rather than from
 * prior knowledge is the part that matters — without it the model restates the question from
 * memory and the tool call was pointless.
 */
function buildPrompt(prompt, actionResults) {
  return [
    "# Task: Answer the user using the data gathered below.",
    "",
    "# User's question:",
    prompt,
    "",
    "# Action Results Data:",
    JSON.stringify(actionResults, null, 2),
    "",
    "# Instructions:",
    "- Answer ONLY from the Action Results Data above. Do not rely on prior knowledge.",
    "- If the data does not answer the question, say so plainly rather than speculating.",
    "- Never output code, tool calls, or raw JSON — the reader wants the analysis, not the plumbing.",
    "",
    "Respond using XML in exactly this form:",
    "<response><thought>your reasoning</thought><text>your answer</text></response>",
  ].join("\n");
}

/** Pulls <text> out of the model's XML reply. Returns "" when there is nothing usable. */
function extractText(reply) {
  if (typeof reply !== "string") return "";
  const match = reply.match(/<text>([\s\S]*?)<\/text>/);
  return match ? match[1].trim() : "";
}

/**
 * Synthesises the answer, or returns null so the caller keeps its existing selection.
 *
 * @param {{useModel: Function}} runtime
 * @param {{prompt: string, actionResults: Array<object>, timeoutMs?: number}} opts
 * @returns {Promise<string|null>}
 */
async function synthesizeAnswer(runtime, { prompt, actionResults, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  // Nothing ran, so there is nothing to add. Spending an LLM call to restate the existing
  // answer would be latency on the paid path for no gain.
  if (!Array.isArray(actionResults) || actionResults.length === 0) return null;
  if (typeof runtime?.useModel !== "function") return null;

  try {
    // Deadline enforced here rather than trusting the model client: an unbounded await is how
    // an on-chain prompt expires with no answer delivered at all.
    const reply = await Promise.race([
      runtime.useModel("TEXT_LARGE", { prompt: buildPrompt(prompt, actionResults) }),
      new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);

    const text = extractText(reply);
    return text || null;
  } catch (err) {
    // Never throw into the answer path — the caller falls back to selectAnswer.
    console.error(`[Synthesis] Falling back, synthesis failed: ${String(err?.message ?? err)}`);
    return null;
  }
}

module.exports = { synthesizeAnswer };
