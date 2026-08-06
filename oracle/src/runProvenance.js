const { reasoningFromThoughts } = require("./answerProvenance");

/**
 * Run-correlated provenance collector.
 *
 * WHY NOT A LOCAL ARRAY. `queryElizaOS` currently accumulates reasoning in a closure-local
 * array, which is safe because each call owns one. ElizaOS's live signals do not work that way:
 * `runtime.registerEvent(ACTION_STARTED, …)` registers on the RUNTIME, which is shared, while
 * the oracle drains prompts through a p-queue with CONCURRENCY 5. A handler that simply
 * appended would interleave thoughts from different users' prompts into each other's answers,
 * then write that into an immutable, already-paid-for MessageFile on decentralised storage.
 *
 * So every signal is correlated by a run key — the oracle's per-conversation roomId — and
 * handlers are registered ONCE at startup. Registering per prompt would leak a handler per
 * prompt, and each leaked handler multiplies the cross-talk.
 *
 * WHY THIS SHAPE NOW, while output is still buffered. ElizaOS already exposes everything
 * streaming needs, in the order a UI wants it: sources are known BEFORE inference
 * (composeState), actions and thoughts arrive DURING (ACTION_STARTED/COMPLETED, onResponse),
 * the answer lands last. Building the buffered version on a correlated collector makes future
 * streaming to the dApp a TRANSPORT change; a closure array would have to be discarded.
 *
 * Nothing here throws. Provenance is decoration on an answer the user has already paid for.
 */

/** Bound on tracked runs. A crash between begin() and finish() must not grow this forever. */
const DEFAULT_MAX_RUNS = 256;

function createRunProvenance({ maxRuns = DEFAULT_MAX_RUNS } = {}) {
  // Map preserves insertion order, which gives oldest-first eviction for free.
  const runs = new Map();

  /** Starts tracking a run, seeded with the sources composed before inference. */
  function begin(runKey, { sources = [] } = {}) {
    if (runKey === undefined || runKey === null) return;

    // Evict oldest first so a leaked run cannot displace live ones indefinitely.
    while (runs.size >= maxRuns) {
      const oldest = runs.keys().next().value;
      if (oldest === undefined) break;
      runs.delete(oldest);
    }

    runs.set(runKey, {
      sources: Array.isArray(sources) ? sources : [],
      thoughts: [],
      currentAction: "",
    });
  }

  /** Notes which action is in flight, so thoughts emitted during it can be attributed. */
  function actionStarted(runKey, actionName) {
    const run = runs.get(runKey);
    if (!run) return;
    run.currentAction = typeof actionName === "string" ? actionName.trim() : "";
  }

  function actionCompleted(runKey, _actionName) {
    const run = runs.get(runKey);
    if (!run) return;
    run.currentAction = "";
  }

  /**
   * Records a thought. `action` wins when supplied; otherwise the action currently in flight
   * attributes it — ACTION_STARTED tells us what is running, while onResponse delivers the
   * thought without that attribution, and pairing them is the point of listening to both.
   *
   * An event for a run we never saw is IGNORED rather than auto-creating one: a stray or late
   * event must not conjure a run that then leaks.
   */
  function recordThought(runKey, thought, action) {
    const run = runs.get(runKey);
    if (!run) return;

    const text = typeof thought === "string" ? thought.trim() : "";
    if (!text) return;

    const attributed = typeof action === "string" && action.trim() ? action.trim() : run.currentAction;
    run.thoughts.push(attributed ? { thought: text, action: attributed } : { thought: text });
  }

  /**
   * Ends a run and returns its provenance, forgetting it.
   *
   * Used for RUN_ENDED and RUN_TIMEOUT alike: a timed-out run must still surrender the partial
   * reasoning it gathered rather than discarding it silently. An unknown key yields the empty
   * shape, so the answer path never has to branch on whether tracking happened.
   */
  function finish(runKey) {
    const run = runs.get(runKey);
    if (!run) return { reasoning: [], sources: [] };

    runs.delete(runKey);
    return {
      reasoning: reasoningFromThoughts(run.thoughts),
      sources: run.sources,
    };
  }

  /** Tracked run count — exposed so leak safety can be asserted rather than assumed. */
  function size() {
    return runs.size;
  }

  return { begin, actionStarted, actionCompleted, recordThought, finish, size };
}

module.exports = { createRunProvenance, DEFAULT_MAX_RUNS };
