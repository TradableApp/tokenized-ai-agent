/**
 * Outbound sanitisation at the STORAGE boundary.
 *
 * `handleChainSynthesis` already runs the Brain's `sanitizeOutboundText` over OUR synthesis, via
 * `generateSanitized`. It cannot cover what it did not produce, and `selectAnswer` is explicitly
 * allowed to return text from elsewhere: a third-party action's prose (plugin-mcp's
 * `handleToolResponse` runs its own reasoning pass and emits prose), the acknowledgement when
 * nothing of ours spoke, or — on the incident path — a tool payload. Each of those is stored
 * verbatim into an immutable MessageFile the user has already paid for, so the sanitiser belongs
 * where the answer LEAVES the harness as well as where our own text enters it.
 *
 * ORACLE DIVERGENCE (deliberate; forced by the pre-paid immutable answer). sense-ai-core does not
 * sanitise at this boundary because it has no such boundary — every callback is its own chat
 * message the user can challenge, retry, or scroll past. This is one of the three differences
 * §2.7 accepts as forced, and it is recorded here rather than only in the plan.
 *
 * THE FALLBACK RULE, and why it inverts core's. `sanitizeOutboundText` returns null for "this is
 * a template leak — drop it", and core's autonomous callers do exactly that: skipping a tweet
 * costs nothing. This body cannot drop. An empty answer fails the contract outright on a prompt
 * that has been charged on-chain, which is the same invariant `selectAnswer`'s incident path
 * already encodes. So a rejection degrades to the unsanitised text and logs loudly instead.
 *
 * Loaded through a cached dynamic import: the Brain is ESM and this host is CommonJS, so
 * `require` cannot reach it. Same mechanism `brainContext.js` uses — but deliberately NOT via
 * `brainContext.getHandles()`, which returns null when Postgres is unconfigured. Sanitising text
 * needs no database, and making it depend on one would silently disable it wherever the warm
 * cache happens to be unavailable.
 */

/** Resolves to the Brain's `sanitizeOutboundText`, or null when the Brain cannot be loaded. */
let sanitizerPromise = null;

/** Test seam — see `_setSanitizerForTests`. */
let overrideSanitizer = null;
let overrideLoader = null;

/**
 * Imports the Brain barrel once per process and caches the result.
 *
 * A failed import is cached too. A missing Brain is deterministic, not transient, so retrying
 * would add an import attempt to every paid prompt for no possible gain. The rejection is
 * absorbed here rather than stored, so no caller can ever see an unhandled rejection.
 *
 * @returns {Promise<((text: string) => string | null) | null>}
 */
function loadSanitizer() {
  if (overrideSanitizer) return Promise.resolve(overrideSanitizer);
  if (!sanitizerPromise) {
    const load = overrideLoader ?? (() => import("@tradableapp/sense-ai-brain"));
    sanitizerPromise = Promise.resolve()
      .then(load)
      .then((mod) => mod?.sanitizeOutboundText ?? null)
      .catch((error) => {
        console.error(
          "[outboundSanitizer] Could not load the Brain — answers will be stored unsanitised. " +
            `Reason: ${error?.message ?? error}`,
        );
        return null;
      });
  }
  return sanitizerPromise;
}

/**
 * Sanitises the answer chosen by `selectAnswer`, degrading to the original on any failure.
 *
 * @param {string|null|undefined} answer the selected answer
 * @returns {Promise<string|null|undefined>} the cleaned answer, or the original when
 *   sanitisation rejects, throws, or is unavailable
 */
async function sanitizeAnswer(answer) {
  if (typeof answer !== "string" || !answer.trim()) return answer;

  const sanitize = await loadSanitizer();
  if (!sanitize) return answer;

  let cleaned;
  try {
    cleaned = sanitize(answer);
  } catch (error) {
    // Logged at ERROR because that is the only level that survives to where anyone will see it:
    // `oasis rofl machine logs` surfaces warn and error, so an INFO line inside the TEE is
    // invisible in practice.
    console.error(
      `[outboundSanitizer] Sanitiser threw; storing the answer unsanitised. Reason: ${
        error?.message ?? error
      }`,
    );
    return answer;
  }

  if (cleaned) return cleaned;

  // Both falsy outcomes degrade to the original — never to `cleaned` — because the standing
  // invariant is that no quality rule may turn an answer into no-answer on a prompt already
  // charged on-chain. Returning an empty string would do exactly that.
  //
  // But they are logged apart. `null` is the Brain's documented rejection ("template/meta
  // leak"); `""` is not in its behaviour today (every non-null exit has passed a >= 10
  // meaningful-character floor) yet its signature permits it, and reporting a leak that never
  // happened would send whoever is tracing a suspect answer after the wrong thing.
  if (cleaned === null || cleaned === undefined) {
    console.error(
      "[outboundSanitizer] The sanitiser REJECTED the answer as a template/meta leak, but the " +
        "prompt has already been paid for on-chain — storing it unsanitised rather than storing " +
        "nothing. Investigate the emitting action.",
    );
  } else {
    console.error(
      "[outboundSanitizer] The sanitiser returned an EMPTY string, which its contract permits " +
        "but its implementation does not currently produce — storing the answer unsanitised. " +
        "This means sanitizeOutboundText's behaviour has changed; check the Brain.",
    );
  }
  return answer;
}

/**
 * Test seam. Pass a sanitiser function to bypass the Brain entirely, or `null` plus
 * `{ loader }` / `{ loadFails: true }` to drive the load path itself.
 *
 * @param {((text: string) => string | null) | null} sanitizer
 * @param {{loader?: () => Promise<unknown>, loadFails?: boolean}} [options]
 */
function _setSanitizerForTests(sanitizer, options = {}) {
  // TWO precedence rules, both invisible from the call site, both able to make a test pass
  // against a path its author did not mean to exercise — which is worse than a test that fails.
  //
  // Checked in this order because the second guard keys off `sanitizer`, so a null sanitizer
  // would walk straight past it and leave the loader/loadFails clash unreported.
  //
  // (1) `loadFails` overrides `loader` when both are set.
  if (options.loader && options.loadFails) {
    throw new Error(
      "_setSanitizerForTests: loader and loadFails are mutually exclusive — loadFails would " +
        "silently override loader, so the test would exercise the wrong path and still pass.",
    );
  }
  // (2) A sanitizer short-circuits `loadSanitizer` before it ever consults the loader.
  if (sanitizer && (options.loader || options.loadFails)) {
    throw new Error(
      "_setSanitizerForTests: pass EITHER a sanitizer (bypasses loading) OR loader/loadFails " +
        "(drives the load path). The sanitizer short-circuits the loader, so both together " +
        "would silently exercise only the first.",
    );
  }
  overrideSanitizer = sanitizer;
  overrideLoader = options.loadFails
    ? () => Promise.reject(new Error("Cannot find module '@tradableapp/sense-ai-brain'"))
    : (options.loader ?? null);
  sanitizerPromise = null;
}

function _resetForTests() {
  overrideSanitizer = null;
  overrideLoader = null;
  sanitizerPromise = null;
}

module.exports = { sanitizeAnswer, _setSanitizerForTests, _resetForTests };
