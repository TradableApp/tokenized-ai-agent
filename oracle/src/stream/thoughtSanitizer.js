const { stripStoredAnswer } = require("../inboundPrompt");
const { looksLikeToolPayload, toolFailureKind } = require("../answerSelection");
const { loadOutboundSanitizer } = require("../outboundSanitizer");
const { LIMITS, capChars } = require("./streamContract");

/**
 * Cleans one model thought, ONCE, before it is either streamed or stored.
 *
 * A thought is shown live and then written with the answer into storage that cannot be changed,
 * so whatever leaves here is final. Unlike the answer it is not what the user paid for, so the
 * rule is the opposite of `sanitizeAnswer`'s: anything doubtful is DROPPED (null), never kept
 * unsanitised.
 *
 * Order: fence tags out (the same strip the stored answer gets, since both go into the same
 * file); a tool payload or the tool
 * plugin's account of a failed step is dropped; the Brain's outbound sanitiser decides the rest,
 * within a time limit; the result is capped at the step description limit.
 *
 * Never throws and never takes longer than `timeoutMs` past the strip.
 */

const THOUGHT_SANITIZE_TIMEOUT_MS = 2000;
const THOUGHT_MAX_CHARS = LIMITS.stepDescriptionChars;

const TIMED_OUT = Symbol("timed out");

async function brainSanitize(text, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    timer.unref?.();
  });
  const work = (async () => {
    const sanitize = await loadOutboundSanitizer();
    if (typeof sanitize !== "function") return null;
    const result = sanitize(text);
    // Only a string counts. A promise is not awaited here: returned from this async function it
    // would be, and a sanitiser that became async would then decide without the time limit.
    return typeof result === "string" ? result : null;
  })();
  try {
    const result = await Promise.race([work, timeout]);
    if (result === TIMED_OUT) {
      console.warn("[Stream] Thought sanitiser did not answer in time; the thought is dropped.");
      return null;
    }
    return result;
  } finally {
    clearTimeout(timer);
    // A late rejection of the abandoned work must not surface as an unhandled rejection.
    work.catch(() => {});
  }
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

    const cleaned = await brainSanitize(stripped, timeoutMs);
    if (typeof cleaned !== "string") return null;
    const trimmed = cleaned.trim();
    if (!trimmed) return null;

    return capChars(trimmed, THOUGHT_MAX_CHARS);
  } catch {
    // The fence strip not being ready, or the sanitiser throwing: drop the thought. Nothing about
    // the error is printed, since its text can quote the thought.
    return null;
  }
}

module.exports = { sanitizeThought, THOUGHT_SANITIZE_TIMEOUT_MS, THOUGHT_MAX_CHARS };
