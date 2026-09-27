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
