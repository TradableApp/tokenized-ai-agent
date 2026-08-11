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
 * A bare tool invocation — `await client.foo.bar(…)`. Requires the parenthesis to follow the
 * dotted identifier immediately, so ordinary prose ("activity (per Glassnode) rose") cannot
 * match; but the argument list itself is unconstrained.
 *
 * IT USED TO REQUIRE AN OBJECT LITERAL (`({…})`), which matched the live payload exactly and
 * nothing else. `client.news.list()` and `client.news.get("bitcoin")` were invisible, so a
 * differently-shaped payload from a future MCP tool would have passed straight through as
 * prose. Widening is safe here precisely BECAUSE of the prose floor below: a text is only
 * called a payload when almost nothing survives stripping the code out, so matching a call
 * mentioned inside a real answer costs nothing.
 *
 * THE LEADING CLASS IS `[a-zA-Z_$]`, NOT `[a-z_$]`. Lower-case-only missed an unfenced
 * `SDK.fetchNews({…})` entirely — `\b` cannot re-anchor inside `SDK`, and `fetchNews(` has no
 * dot before its parenthesis — so a capitalised client object was invisible. Confirmed against
 * the module before widening. `SDK.news.get(…)` matched only by luck, on the `news.get(…)`
 * sub-match. A single dot is still required, so a bare `CONSTANT` can never match.
 *
 * The argument body is lazy (`[\s\S]*?`). Greedy would run to the last `)` in the whole text,
 * so one call early in an answer would swallow every sentence after it — and the prose test
 * would then see nothing left and condemn the answer.
 */
const BARE_INVOCATION_SOURCE = String.raw`\b(?:await\s+)?[a-zA-Z_$][\w$]*\.[\w$.]+\([\s\S]*?\)`;

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
 *
 * CALIBRATION. 24 was too high: "Call client.news.get() for the latest feed." leaves 20
 * alphanumeric characters once the call is stripped, so a terse but perfectly real answer was
 * being condemned. That is the exact failure this constant's asymmetry is supposed to avoid, and
 * it gets more likely in Phase 2, where handlers synthesise from shorter action chains than the
 * prose-heavy `chainSynthesisTemplate` produces today. 16 keeps clear water on both sides:
 * padding like "Here you go:" is 9, and the recorded payload is 0. Both boundaries are tested.
 */
const MIN_PROSE_CHARS = 16;

/**
 * True when the whole text is a JSON object or array — i.e. a tool's raw return value.
 *
 * Primitives are excluded deliberately: `JSON.parse` accepts `"61000"` and `"true"`, and a
 * one-word answer, while poor, is still an answer rather than a payload.
 *
 * @param {string} text
 * @returns {boolean}
 */
function isJsonDocument(text) {
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed)) return false; // cheap reject before parsing
  try {
    return typeof JSON.parse(trimmed) === "object";
  } catch {
    return false;
  }
}

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

  // A raw tool RESULT rather than a tool CALL: no fences, no invocation, just the JSON the tool
  // returned. Neither pattern below sees it, so without this it would be stored as the answer.
  // Parsing is the test rather than a regex, because it cannot produce a false positive: an
  // answer written for a human is never itself a well-formed JSON object or array.
  if (isJsonDocument(text)) return true;

  const hasCode = HAS_FENCE.test(text) || HAS_INVOCATION.test(text);
  if (!hasCode) return false;

  const withoutCode = text.replace(ALL_FENCED_BLOCKS, " ").replace(ALL_INVOCATIONS, " ");

  // Count letters and digits only: punctuation, backticks and stray fence markers left behind
  // by an unterminated block are not prose.
  const prose = withoutCode.replace(/[^\p{L}\p{N}]+/gu, "");
  return prose.length < MIN_PROSE_CHARS;
}

/**
 * Actions of OURS whose emission is the synthesised answer rather than a step toward it.
 *
 * `handleChainSynthesis` tags its callback with the action that produced it, so an emission
 * carrying one of these names is the thing we actually want stored.
 */
const SYNTHESIS_ACTIONS = new Set([
  "GET_NEWS_DETAILS",
  "ANALYZE_ASSET_SENTIMENT",
  "ANALYZE_FINANCIAL_IMAGE",
]);

/**
 * Normalises an emission to `{ text, actions }`.
 *
 * Accepts a bare string so callers without attribution — and every test written before it
 * existed — keep working. Attribution is additive, never required.
 */
function normalise(entry) {
  if (typeof entry === "string") return { text: entry, actions: [] };
  if (entry && typeof entry.text === "string") {
    return { text: entry.text, actions: Array.isArray(entry.actions) ? entry.actions : [] };
  }
  return { text: "", actions: [] };
}

/**
 * Picks the answer from everything the run emitted, in emission order.
 *
 * WHY ATTRIBUTION BEATS RECENCY. ElizaOS chooses the actions at runtime from the prompt, so a
 * turn is 0..N callbacks in an order we do not control. "Last substantive" is wrong for a mixed
 * chain: `plugin-mcp`'s `handleToolResponse` runs a reasoning prompt and emits PROSE, so on
 * `GET_NEWS_DETAILS, CALL_MCP_TOOL` the MCP summary arrives last and would silently replace our
 * synthesis. Core never hits this because every callback is its own chat message; the oracle
 * must choose exactly one, so the choice has to be informed by WHO emitted.
 *
 * Mixed chains are desirable — a news answer is better with a live price beside it — so the fix
 * is to prefer our synthesis, never to keep other actions away from the chain.
 *
 * @param {Array<string | {text: string, actions?: string[]}>} [emitted]
 * @returns {string|null} the answer, or null when nothing usable was emitted
 */
function selectAnswer(emitted) {
  if (!Array.isArray(emitted)) return null;

  const entries = emitted.map(normalise).filter((e) => e.text.trim());
  if (entries.length === 0) return null;

  // Attribution outranks recency, but never substance: a payload is not an answer whoever
  // emitted it, so a synthesis that somehow emitted code falls through to the rules below.
  const synthesised = entries.filter(
    (e) => e.actions.some((a) => SYNTHESIS_ACTIONS.has(a)) && !looksLikeToolPayload(e.text),
  );
  if (synthesised.length > 0) return synthesised[synthesised.length - 1].text;

  const candidates = entries.map((e) => e.text);

  // Last substantive emission: later text supersedes earlier text (an actual answer
  // beats the acknowledgement that preceded it), but a tool payload is not an answer
  // at all and never supersedes prose.
  const prose = candidates.filter((t) => !looksLikeToolPayload(t));
  if (prose.length > 0) return prose[prose.length - 1];

  // Everything emitted looked like a payload. Return it rather than nothing: the user
  // has already paid, and an empty answer fails the contract outright. A bad answer is
  // visible and can be flagged by the smoke test; silence cannot.
  //
  // THIS PATH IS THE ORIGINAL DEFECT, and reaching it means the fix has been bypassed.
  // Today it is unreachable in practice only because the agent emits an acknowledgement
  // BEFORE the tool payload — that acknowledgement is prose, so it wins and the payload
  // never does. The acknowledgement is therefore load-bearing: if `@elizaos/plugin-mcp`
  // ever stops emitting one (it is that plugin's `sendInitialResponse`, not ours), every
  // emission becomes a payload and the incident returns silently.
  //
  // PARTIALLY CLOSED as of CU-86d3z0r81. `GET_NEWS_DETAILS` is now registered and runs
  // `handleChainSynthesis`, so a NEWS answer emits synthesised prose of our own and no longer
  // depends on a third-party plugin's courtesy message. Every other query shape still does —
  // the dependency is narrowed, not removed, and closing it fully means porting the remaining
  // analytical actions (ANALYZE_ASSET_SENTIMENT, ANALYZE_FINANCIAL_IMAGE).
  //
  // Until then, treat a hit here as an incident, not a degradation.
  //
  // Logged at ERROR because that is the only level that survives to where anyone will see it:
  // `oasis rofl machine logs` surfaces warn and error, so an INFO line inside the TEE is
  // invisible in practice. Until PR B hardens the smoke, this log is the ONLY detector.
  console.error(
    "[answerSelection] INCIDENT: every emission looked like a tool payload, so one is being " +
      "stored as the answer. The acknowledgement emission is missing — check " +
      "@elizaos/plugin-mcp sendInitialResponse.",
  );
  return candidates[candidates.length - 1];
}

module.exports = { selectAnswer, looksLikeToolPayload };
