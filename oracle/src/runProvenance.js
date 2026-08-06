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
 * So thoughts are correlated by a per-run HANDLE, not by roomId. roomId is derived from
 * conversationId and is therefore stable per conversation, so two prompts in the same
 * conversation can be in flight together and a room-keyed run would let the second clobber the
 * first. roomId survives only as a secondary index, because ACTION_STARTED/COMPLETED carry
 * nothing else — and when a room holds more than one live run those events are dropped rather
 * than guessed (see soleRunIn).
 *
 * Handlers are registered ONCE PER RUNTIME. Registering per prompt would leak a handler per
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
  // roomKey -> Set of live run ids. Action events carry only a roomId, so this is what decides
  // whether attribution is unambiguous.
  const byRoom = new Map();
  let nextRunId = 0;

  function forget(runId) {
    const run = runs.get(runId);
    if (!run) return;
    runs.delete(runId);
    const siblings = byRoom.get(run.roomKey);
    if (siblings) {
      siblings.delete(runId);
      if (siblings.size === 0) byRoom.delete(run.roomKey);
    }
  }

  /**
   * Starts tracking a run and returns a handle UNIQUE to it.
   *
   * Keyed by handle rather than by roomId because roomId is derived from conversationId and is
   * therefore stable per conversation: two PromptSubmitted events for the SAME conversation can
   * be in flight together under the p-queue, and keying by room would let the second clobber the
   * first — attributing one user's thoughts to the other's answer, permanently.
   */
  function begin(roomKey, { sources = [] } = {}) {
    // Evict oldest first so a leaked run cannot displace live ones indefinitely.
    while (runs.size >= maxRuns) {
      const oldest = runs.keys().next().value;
      if (oldest === undefined) break;
      forget(oldest);
    }

    const runId = `run-${(nextRunId += 1)}`;
    runs.set(runId, {
      roomKey,
      sources: Array.isArray(sources) ? sources : [],
      thoughts: [],
      currentAction: "",
    });

    if (!byRoom.has(roomKey)) byRoom.set(roomKey, new Set());
    byRoom.get(roomKey).add(runId);

    return runId;
  }

  /** The single live run for a room, or null when zero or ambiguous. */
  function soleRunIn(roomKey) {
    const siblings = byRoom.get(roomKey);
    if (!siblings || siblings.size !== 1) return null;
    return siblings.values().next().value;
  }

  /** Notes which action is in flight, so thoughts emitted during it can be attributed. */
  /**
   * ACTION_STARTED carries only a roomId, so when two runs share a room the event cannot be
   * attributed to either. It is dropped rather than guessed: absent attribution is a missing
   * title, wrong attribution is a permanent lie in immutable storage.
   */
  function actionStarted(roomKey, actionName) {
    const runId = soleRunIn(roomKey);
    if (!runId) return;
    runs.get(runId).currentAction = typeof actionName === "string" ? actionName.trim() : "";
  }

  function actionCompleted(roomKey, _actionName) {
    const runId = soleRunIn(roomKey);
    if (!runId) return;
    runs.get(runId).currentAction = "";
  }

  /**
   * Records a thought. `action` wins when supplied; otherwise the action currently in flight
   * attributes it — ACTION_STARTED tells us what is running, while onResponse delivers the
   * thought without that attribution, and pairing them is the point of listening to both.
   *
   * An event for a run we never saw is IGNORED rather than auto-creating one: a stray or late
   * event must not conjure a run that then leaks.
   */
  function recordThought(runId, thought, action) {
    const run = runs.get(runId);
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
  function finish(runId) {
    const run = runs.get(runId);
    if (!run) return { reasoning: [], sources: [] };

    forget(runId);
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
