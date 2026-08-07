const { looksLikeToolPayload } = require("./answerSelection");

/**
 * Decides whether a stored answer is actually an answer.
 *
 * WHY THIS IS NOT IN THE SMOKE SCRIPT. `base-testnet-smoke.js` asserted structure only — role is
 * "assistant", content longer than 20 characters, `reasoning[]` and `sources[]` non-empty. All
 * four were TRUE for both recorded production failures (a fenced TypeScript snippet, and before
 * that an apology), because the Brain populates reasoning and sources regardless of what the
 * model said. The smoke reported PASS on the exact failures it existed to catch.
 *
 * A green light that costs real money to trust is worse than no light at all. Moving the
 * judgement into a module makes it testable against those recorded failures as fixtures, which
 * a 337-line script that needs a funded wallet and a live TEE never could be.
 *
 * THE ASYMMETRY HERE IS THE OPPOSITE OF `answerSelection`'s. There, wrongly rejecting an answer
 * was the worse error, because the acknowledgement silently took its place. Here, a false
 * FAILURE is worse: a smoke that cries wolf gets muted, and then it catches nothing. So each
 * rejection below is justified by recorded evidence, and the ambiguous cases are allowed to pass.
 */

/** Below this, "content" is not an answer to anything. The recorded apology was ~100. */
const MIN_ANSWER_CHARS = 20;

/**
 * Phrases that open a refusal. Matched only at the START of the answer, and only when nothing
 * substantive follows — see `isNonAnswer`.
 */
const APOLOGY_OPENERS =
  /^\s*(?:i(?:'m| am)\s+sorry|sorry|i\s+apolog|unfortunately|i(?:'m| am)\s+unable|i\s+can(?:not|'t)\b)/i;

/** Hedges that carry no analysis. Used only to measure how much of a refusal is filler. */
const FILLER =
  /\b(?:at the moment|right now|please try again(?: later)?|i (?:do not|don't) have access|as an ai(?: language model)?|currently unavailable|try again later)\b/gi;

/**
 * True when the answer is a refusal and nothing else.
 *
 * NOT "contains an apology". Core's system prompt explicitly instructs the agent: *If data is
 * missing, say "The data isn't there" and move on.* A specific, analytical answer that declines
 * on one point is CORRECT behaviour, and failing the smoke on it would mean the smoke fails when
 * the agent does the right thing. The test is therefore whether anything survives once the
 * apology and its filler are removed.
 *
 * @param {string} text
 * @returns {boolean}
 */
function isNonAnswer(text) {
  if (!APOLOGY_OPENERS.test(text)) return false;

  const remainder = text
    .replace(APOLOGY_OPENERS, " ")
    .replace(FILLER, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "");

  // A refusal that still carries this much prose is an answer that happens to decline.
  return remainder.length < 60;
}

/**
 * Escapes a caller-supplied asset name before it becomes part of a RegExp. The asset comes from
 * the smoke's own prompt rather than from user input, but building patterns from data without
 * escaping is a habit worth not having.
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Tickers for the assets the smoke asks about, so "BTC" satisfies a question about Bitcoin. */
const TICKERS = {
  bitcoin: ["btc", "xbt"],
  ethereum: ["eth", "ether"],
  solana: ["sol"],
};

/**
 * True when the answer refers to the asset that was asked about, by name or ticker.
 *
 * Catches the failure structure alone never can: a fluent, well-sourced, correctly-shaped answer
 * about the wrong subject.
 *
 * @param {string} text
 * @param {string} asset
 * @returns {boolean}
 */
function mentionsAsset(text, asset) {
  const names = [asset.toLowerCase(), ...(TICKERS[asset.toLowerCase()] || [])];
  return names.some((name) => new RegExp(`\\b${escapeRegExp(name)}\\b`, "i").test(text));
}

/**
 * Assesses a decrypted answer MessageFile.
 *
 * Returns two lists rather than a boolean so the smoke can keep its exit-code contract:
 * `fatal` → exit 1, the oracle is broken and someone should be paged; `brain` → exit 2, the
 * oracle is healthy but the Brain's warm cache is cold, which is a data problem to seed rather
 * than an incident. Collapsing them would page a human for a stale cache.
 *
 * @param {{role?: string, content?: string, reasoning?: unknown[], sources?: unknown[]}} answer
 * @param {{asset?: string}} [asked]
 * @returns {{fatal: string[], brain: string[]}}
 */
function assessAnswer(answer, asked = {}) {
  const fatal = [];
  const brain = [];

  const content = typeof answer?.content === "string" ? answer.content : "";
  const reasoning = Array.isArray(answer?.reasoning) ? answer.reasoning : [];
  const sources = Array.isArray(answer?.sources) ? answer.sources : [];

  if (answer?.role !== "assistant") {
    fatal.push(`role is '${answer?.role}', expected 'assistant'`);
  }

  if (!content || content.trim().length < MIN_ANSWER_CHARS) {
    fatal.push("content missing or too short to be an answer");
  } else {
    // Reuses the classifier the oracle answers WITH, rather than writing a second opinion about
    // what a tool payload looks like. If the two ever disagreed, the smoke would be validating
    // something other than what production stores.
    if (looksLikeToolPayload(content)) {
      fatal.push("content is a tool payload / raw code, not an answer");
    } else if (isNonAnswer(content)) {
      fatal.push("content is an apology with no substance — a non-answer");
    } else if (asked.asset && !mentionsAsset(content, asked.asset)) {
      fatal.push(`content never mentions ${asked.asset} — answered about something else`);
    }
  }

  if (!reasoning.length) {
    brain.push("reasoning[] is EMPTY — Brain context not injected (or warm cache is cold)");
  }
  if (!sources.length) {
    brain.push("sources[] is EMPTY — no news citations from the Brain warm cache");
  }

  return { fatal, brain };
}

module.exports = { assessAnswer, isNonAnswer, mentionsAsset };
