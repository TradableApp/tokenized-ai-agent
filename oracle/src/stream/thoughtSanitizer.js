const { stripStoredAnswer } = require("../inboundPrompt");
const { looksLikeToolPayload, toolFailureKind } = require("../answerSelection");
const { loadOutboundSanitizer } = require("../outboundSanitizer");
const { errorKind } = require("../errorDescription");
const { LIMITS, capChars } = require("./streamContract");
const { noteThoughtDropped } = require("./answerStream");

/**
 * Cleans one model thought, ONCE, before it is either streamed or stored.
 *
 * A thought is shown live and then written with the answer into storage that cannot be changed,
 * so whatever leaves here is final. Unlike the answer it is not what the user paid for, so the
 * rule is the opposite of `sanitizeAnswer`'s: anything doubtful is DROPPED (null), never kept
 * unsanitised.
 *
 * Order: fence tags out (the same strip the stored answer gets, since both go into the same
 * file); a tool payload or the tool plugin's account of a failed step is dropped; the text is cut
 * to a bound; the Brain's outbound sanitiser decides the rest, within a time limit; the result is
 * capped at the step description limit.
 *
 * A thought the sanitiser does not keep is counted by why (`timeout`, `unavailable`, `refused`,
 * `failed`; see `answerStream.THOUGHT_DROP_KINDS`), never by anything in it. What is dropped by
 * design (a tool payload, nothing left after the strip) is not counted.
 *
 * Never throws and never takes longer than `timeoutMs` past the strip.
 */

const THOUGHT_SANITIZE_TIMEOUT_MS = 2000;
const THOUGHT_MAX_CHARS = LIMITS.stepDescriptionChars;

/**
 * The most text handed to the Brain's sanitiser for one thought. Its tag patterns can take time
 * that grows with the square of the length, and the work is synchronous, so the time limit above
 * cannot cut it short: it blocks the event loop, and with it every answer and the heartbeat.
 * Timed with the real Brain on hostile text (many unclosed `<post>` tags): 14 KB took 3 ms,
 * 70 KB 66 ms, 140 KB 300 ms, 280 KB 1145 ms. Scaled down by the square, 32 KB comes to about
 * 15 ms, under the 20 ms we accept, and it is far above anything a model writes as one thought.
 * Only the first `THOUGHT_MAX_CHARS` of the result are kept in any case.
 */
const THOUGHT_SANITIZE_INPUT_MAX_CHARS = 32 * 1024;

const TIMED_OUT = Symbol("timed out");

/** The Brain's verdict: `{ text }`, or `{ dropped }` with why. */
async function brainSanitize(text, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    timer.unref?.();
  });
  const work = (async () => {
    const sanitize = await loadOutboundSanitizer();
    if (typeof sanitize !== "function") return { dropped: "unavailable" };
    let result;
    try {
      result = sanitize(text);
    } catch {
      // Nothing about the error is printed: its text can quote the thought.
      return { dropped: "failed" };
    }
    // Only a string counts. A promise is not awaited here: returned from this async function it
    // would be, and a sanitiser that became async would then decide without the time limit.
    if (result === null) return { dropped: "refused" };
    if (typeof result !== "string") return { dropped: "failed" };
    return { text: result };
  })();
  try {
    const result = await Promise.race([work, timeout]);
    if (result === TIMED_OUT) {
      console.warn("[Stream] Thought sanitiser did not answer in time; the thought is dropped.");
      return { dropped: "timeout" };
    }
    return result;
  } finally {
    clearTimeout(timer);
    // A late rejection of the abandoned work must not surface as an unhandled rejection.
    work.catch(() => {});
  }
}

function drop(kind) {
  noteThoughtDropped(kind);
  return null;
}

/**
 * @param {unknown} thought
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<string|null>} the cleaned thought, or null to drop it
 */
async function sanitizeThought(thought, { timeoutMs = THOUGHT_SANITIZE_TIMEOUT_MS } = {}) {
  try {
    if (typeof thought !== "string") return null;

    const stripped = stripStoredAnswer(thought).trim();
    if (!stripped) return null;
    if (looksLikeToolPayload(stripped) || toolFailureKind(stripped)) return null;

    const bounded = capChars(stripped, THOUGHT_SANITIZE_INPUT_MAX_CHARS);
    const verdict = await brainSanitize(bounded, timeoutMs);
    if (verdict.dropped) return drop(verdict.dropped);
    const trimmed = verdict.text.trim();
    if (!trimmed) return drop("refused");

    return capChars(trimmed, THOUGHT_MAX_CHARS);
  } catch {
    // The fence strip not being ready, or anything else unexpected: drop the thought. Nothing
    // about the error is printed, since its text can quote the thought.
    return drop("failed");
  }
}

/**
 * Loads the Brain's sanitiser ahead of the first prompt, so the first thoughts after a start do
 * not wait on the import and time out. Never throws: a failed load is said here by kind only
 * (the shared load logs its own reason), and the oracle starts all the same.
 *
 * @returns {Promise<boolean>} whether the sanitiser is ready
 */
async function warmThoughtSanitizer() {
  const dropped = "reasoning thoughts are dropped until it loads.";
  try {
    if (typeof (await loadOutboundSanitizer()) === "function") return true;
    console.warn(`[Stream] The sanitiser warm-up found no sanitiser (unavailable); ${dropped}`);
    return false;
  } catch (error) {
    console.warn(`[Stream] The sanitiser warm-up failed (${errorKind(error)}); ${dropped}`);
    return false;
  }
}

module.exports = {
  sanitizeThought,
  warmThoughtSanitizer,
  THOUGHT_SANITIZE_TIMEOUT_MS,
  THOUGHT_MAX_CHARS,
  THOUGHT_SANITIZE_INPUT_MAX_CHARS,
};
