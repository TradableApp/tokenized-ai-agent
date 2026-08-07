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

/** Fenced code block, anywhere in the text. */
const FENCED_CODE = /```/;

/**
 * A bare tool invocation — `await client.foo.bar({…})` / `client.foo({…})`. Deliberately
 * narrow: it wants a client-ish call WITH an argument object, which is what the MCP
 * payloads look like, rather than any sentence containing a dot or a bracket.
 */
const BARE_INVOCATION = /\b(?:await\s+)?[a-z_$][\w$]*\.[\w$.]+\(\s*\{[\s\S]*\}\s*\)/;

/**
 * True when the text looks like a tool call rather than an answer.
 *
 * Kept conservative on purpose. The oracle answers questions ABOUT crypto tooling, so
 * flagging any text that mentions an API or a function would drop legitimate analysis —
 * a worse failure than the one being fixed, because it would present as the model being
 * bad rather than as a harness bug. Prose that merely *mentions* code is not a payload.
 *
 * @param {string} [text]
 * @returns {boolean}
 */
function looksLikeToolPayload(text) {
  if (typeof text !== "string" || !text.trim()) return false;
  return FENCED_CODE.test(text) || BARE_INVOCATION.test(text);
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
