/**
 * Chooses which emitted text becomes the stored answer.
 *
 * WHY THIS IS NOT `finalResponseText = content.text`. ElizaOS emits every intermediate
 * message through the same `onResponse` callback: the acknowledgement, then whatever an
 * action produces. Assigning on each emission means the LAST one wins, so a
 * `CALL_MCP_TOOL` payload silently becomes the user's answer. On base-testnet that
 * stored a TypeScript snippet; a run before it stored an apology. Both were encrypted
 * into an immutable MessageFile the user had already paid for.
 *
 * sense-ai-core avoids this with `utils/actionChainHelper.ts` — action results feed a
 * synthesis pass, so tool output is never itself user-facing. Porting that wholesale is
 * the rest of this task; this module is the narrow, testable part: given everything the
 * run emitted, decide what a user may be charged for.
 *
 * The rule is deliberately "last SUBSTANTIVE emission", not "first" and not "last":
 *   - last, and a tool payload wins (the bug);
 *   - first, and the acknowledgement wins, which is just a different wrong answer.
 */

/**
 * Each pattern is defined ONCE and compiled twice: a plain form for `.test()` and a `/g` form
 * for `.replace()`. They are never interchanged.
 *
 * WHY THE PAIR, rather than one `/g` regex used for both. A `/g` regex is stateful: `.test()`
 * advances `lastIndex` and the next call resumes from there, so consecutive tests on the same
 * object return alternating results. `.replace()` is unaffected (it always scans from the
 * start), which is what makes the bug so easy to introduce and so hard to see — the natural
 * spelling `BARE_INVOCATION.test(text)` would work in the first test of a run and fail in the
 * second, presenting as a flaky classifier rather than as a regex-state bug.
 */
const FENCED = String.raw`\x60\x60\x60`;

/** A fenced code block. Lazy, so consecutive blocks are matched separately rather than as one. */
const FENCED_BLOCK_SOURCE = `${FENCED}[\\s\\S]*?${FENCED}`;

/**
 * A bare tool invocation — `await client.foo.bar({…})` / `client.foo({…})`. Deliberately
 * narrow: it wants a client-ish call WITH an argument object, which is what the MCP
 * payloads look like, rather than any sentence containing a dot or a bracket.
 *
 * The argument body is lazy (`[\s\S]*?`). Greedy would run from the first `{` to the last
 * `}` in the whole text, so one call early in an answer would swallow every sentence
 * between it and the last brace — and the prose test below would then see nothing left.
 */
const BARE_INVOCATION_SOURCE = String.raw`\b(?:await\s+)?[a-z_$][\w$]*\.[\w$.]+\(\s*\{[\s\S]*?\}\s*\)`;

const HAS_FENCE = new RegExp(FENCED);
const HAS_INVOCATION = new RegExp(BARE_INVOCATION_SOURCE);
const ALL_FENCED_BLOCKS = new RegExp(FENCED_BLOCK_SOURCE, "g");
const ALL_INVOCATIONS = new RegExp(BARE_INVOCATION_SOURCE, "g");

/**
 * How much prose has to survive code-stripping for the text to count as an answer.
 *
 * The asymmetry matters. Flagging a real answer stores the acknowledgement instead, which
 * is silent and reads as the model regressing; missing a payload stores something obviously
 * wrong that the smoke test can catch. So the bar is deliberately low — and it can afford
 * to be, because the payload this exists for has *zero* prose around it.
 */
const MIN_PROSE_CHARS = 24;

/**
 * True when the text IS a tool call rather than an answer that happens to contain one.
 *
 * "Contains code" is not the test, and must not be. `chainSynthesisTemplate` — core's, ported
 * verbatim in this same change — instructs the model to wrap any code it includes in fenced
 * blocks. Rejecting every text containing a fence would therefore drop a legitimate synthesised
 * answer the moment it quoted an API call, falling back to "Analysing… stand by." That failure
 * is invisible and looks like the model regressing rather than like a harness bug.
 *
 * So: strip the code out, and ask whether an answer remains. Nothing left means the text was the
 * payload. Prose either side of a snippet means it was an answer.
 *
 * @param {string} [text]
 * @returns {boolean}
 */
function looksLikeToolPayload(text) {
  if (typeof text !== "string" || !text.trim()) return false;

  const hasCode = HAS_FENCE.test(text) || HAS_INVOCATION.test(text);
  if (!hasCode) return false;

  const withoutCode = text.replace(ALL_FENCED_BLOCKS, " ").replace(ALL_INVOCATIONS, " ");

  // Count letters and digits only: punctuation, backticks and stray fence markers left behind
  // by an unterminated block are not prose.
  const prose = withoutCode.replace(/[^\p{L}\p{N}]+/gu, "");
  return prose.length < MIN_PROSE_CHARS;
}

/**
 * Picks the answer from everything the run emitted, in emission order.
 *
 * @param {Array<string>} [emitted]
 * @returns {string|null} the answer, or null when nothing usable was emitted
 */
function selectAnswer(emitted) {
  if (!Array.isArray(emitted)) return null;

  const candidates = emitted.filter((t) => typeof t === "string" && t.trim());
  if (candidates.length === 0) return null;

  // Last substantive emission: later text supersedes earlier text (an actual answer
  // beats the acknowledgement that preceded it), but a tool payload is not an answer
  // at all and never supersedes prose.
  const prose = candidates.filter((t) => !looksLikeToolPayload(t));
  if (prose.length > 0) return prose[prose.length - 1];

  // Everything emitted looked like a payload. Return it rather than nothing: the user
  // has already paid, and an empty answer fails the contract outright. A bad answer is
  // visible and can be flagged by the smoke test; silence cannot.
  return candidates[candidates.length - 1];
}

module.exports = { selectAnswer, looksLikeToolPayload };
