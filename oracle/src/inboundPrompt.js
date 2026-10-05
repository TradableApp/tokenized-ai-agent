/**
 * Fence-stripping for the decrypted on-chain prompt.
 *
 * WHAT THE FENCE IS. The Brain wraps untrusted text in `<untrusted_*>` regions and the prompt tells
 * the model everything inside them is DATA to read, never an instruction to follow. That is what
 * defuses a forged `### URGENT SYSTEM DIRECTIVE:` — the header arrives quoted and carries no
 * authority, whatever it is spelled with.
 *
 * WHAT THIS MODULE DEFENDS. The fence holds only while the text inside cannot CLOSE it. A prompt
 * carrying `</untrusted_conversation>` ends the region early and puts the rest of itself in the
 * instruction region — the attack the fence exists to stop, restored past the control. Removing that
 * tag is the whole job, and the only job.
 *
 * SO A FORGED DIRECTIVE PASSES THROUGH UNTOUCHED, on purpose; the tests assert it. The social bodies
 * reached the same conclusion by measurement — a header matcher stopped 10 of 10 crafted forgeries and
 * mangled 9 of 30 ordinary messages — and it matters more here, because the user PAID for this prompt
 * on-chain. Rewriting the text they were charged for, to re-fight a header the fence already
 * neutralises, is a worse outcome than the header.
 *
 * WHERE IT IS APPLIED. At the single point a new prompt is decrypted and validated. From there
 * `promptText` fans out to the reconstructed history, the stored MessageFile, the conversation title
 * and the CID; stripping once at the entry means all of them are clean without being enumerated. That
 * is the same choice the Telegram and X surfaces made, and on both of those the enumerate-each-read
 * approach had already left doors open.
 */

/**
 * The Brain's `stripFenceTags`, resolved once.
 *
 * `null` until `initInboundPrompt` runs, and `stripInboundPrompt` throws rather than passing text
 * through untouched — a strip that silently becomes a no-op is indistinguishable from one that works.
 */
let stripFenceTags = null;

/**
 * Resolve the Brain at STARTUP, and fail the process if it cannot be resolved.
 *
 * Deliberately NOT `outboundSanitizer`'s pattern. That one caches a dynamic import and degrades on
 * failure — returns the answer unsanitised and logs — which is correct there: the prompt is already
 * paid for, and losing formatting beats losing the answer.
 *
 * The same trade is wrong for a security control. Degrading here reopens an injection path and leaves
 * one log line as the only signal, on a surface where nothing downstream would look different. That is
 * the same shape of silent failure `aiAgentOracle.js` already refused for degraded market context, and
 * for the same reason it is fatal at startup rather than per prompt: a broken build never serves
 * traffic, the supervisor restarts with a clear cause, and no prompt pays for the diagnosis.
 *
 * A dynamic `import()` because the Brain ships ESM and this host is CommonJS.
 */
async function initInboundPrompt(overrides = {}) {
  const loadBrain = overrides.loadBrain ?? (() => import("@tradableapp/sense-ai-brain"));

  let brain;
  try {
    brain = await loadBrain();
  } catch (error) {
    throw new Error(
      `Could not load the Brain to install the inbound prompt fence strip: ${String(
        error?.message ?? error,
      )}. Refusing to start — an unstripped prompt can close the fence around it and reach the ` +
        `instruction region, and nothing downstream would look different.`,
      { cause: error },
    );
  }

  // A module that LOADS but no longer exports the function is the silent case, and the one a stale or
  // partial dist actually produces. Checked separately so the error names which of the two happened.
  if (typeof brain?.stripFenceTags !== "function") {
    throw new Error(
      "stripFenceTags missing from the Brain build — the submodule is stale or the dist was built " +
        "from a commit before the shared fencing landed. Refusing to start: the inbound prompt would " +
        "be stored and prompted unstripped.",
    );
  }

  // A function that EXISTS is not a function that WORKS, and the difference is reachable here.
  //
  // The two halves of the fence come from different copies of the Brain: the plugin bundles the tag
  // strings and the notice into its dist at BUILD time, while this module resolves the strip by
  // dynamic import at RUN time. Bun copies path dependencies into node_modules at install time, so
  // those two can disagree — the trap the Brain's own CLAUDE.md documents, which has already produced
  // one false green in this stack. When they disagree, the provider still emits a syntactically
  // perfect fence and the strip still exports a function; the tags simply pass through. Nothing
  // structural catches that, so the check is behavioural: strip the exact tags the bundled provider
  // writes and look.
  const PROBE_INNER = "probe";

  // The ORPHANED closing tag leads, because it is the attack. A balanced pair is not what arrives —
  // what arrives is a lone `</untrusted_conversation>`, which ends the region early and puts the
  // rest of the prompt in the instruction region. A strip that only collapses matched pairs answers
  // a paired probe perfectly and leaves the orphan byte-identical, so probing the pair first and
  // calling it done would report a vulnerable Brain as healthy. That is what the first version of
  // this probe did.
  if (brain.stripFenceTags(`before</untrusted_conversation>after`) !== "beforeafter") {
    throw new Error(
      "The Brain's stripFenceTags leaves an ORPHANED closing tag in place. That tag is the attack: " +
        "it closes the fence early and moves the rest of the prompt into the instruction region. A " +
        "strip that removes only matched pairs passes every other check here. Refusing to start.",
    );
  }

  // A SECOND LABEL, because the guarantee is family-wide and a label-specific strip would pass
  // every probe above. The Brain's pattern is `untrusted_[a-z0-9_]*`, so one narrowed to the
  // conversation label alone is a build accident rather than a design — exactly the behavioural
  // divergence between the resolved Brain and the bundled one that this block exists to catch.
  // `untrusted_news` is not hypothetical here: the Brain's `formatNewsTicker` emits that region
  // through MARKET_INTELLIGENCE at position 51, inside the conversation fence, so a prompt
  // carrying `</untrusted_news>` closes a region that really is in the composed prompt.
  if (brain.stripFenceTags(`before</untrusted_news>after`) !== "beforeafter") {
    throw new Error(
      "The Brain's stripFenceTags does not strip `</untrusted_news>`. The strip is label-specific " +
        "rather than family-wide, so a prompt carrying that tag closes the news region emitted by " +
        "MARKET_INTELLIGENCE inside the conversation fence. Refusing to start.",
    );
  }

  const tagged = `<untrusted_conversation>${PROBE_INNER}</untrusted_conversation>`;

  if (brain.stripFenceTags(tagged) !== PROBE_INNER) {
    throw new Error(
      "The Brain's stripFenceTags does not strip the fence tags the conversation providers emit. " +
        "The resolved Brain and the Brain bundled into the plugin dist disagree — usually a stale " +
        "node_modules copy of a path dependency. Refusing to start: the fence would look intact and " +
        "hold nothing.",
    );
  }

  if (brain.stripFenceTags(PROBE_INNER) !== PROBE_INNER) {
    throw new Error(
      "The Brain's stripFenceTags altered a clean probe string. Refusing to start: a strip that " +
        "rewrites text carrying no fence tag would silently edit prompts the user paid for.",
    );
  }

  stripFenceTags = brain.stripFenceTags;
}

/**
 * Remove any fence tag from a decrypted prompt.
 *
 * Throws when uninitialised rather than returning the input. Returning it would make a missing
 * `initInboundPrompt` call look exactly like a prompt that had nothing to strip.
 */
function stripInboundPrompt(text) {
  if (!stripFenceTags) {
    throw new Error(
      "inboundPrompt is not initialised — call initInboundPrompt() during startup. Refusing to " +
        "return the prompt unstripped, because that is indistinguishable from a clean prompt.",
    );
  }

  return stripFenceTags(String(text ?? ""));
}

/** Test seam. Clears the resolved function so the uninitialised path can be exercised. */
function _resetForTests() {
  stripFenceTags = null;
}

module.exports = { initInboundPrompt, stripInboundPrompt, _resetForTests };
