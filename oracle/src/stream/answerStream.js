const {
  FRAME_TYPES,
  RESET_REASONS,
  DONE_OUTCOMES,
  LIMITS,
  buildFrame,
  encryptFrame,
  newRunId,
  streamProof,
  isSink,
  noopSink,
  capChars,
  isAnswerCid,
} = require("./streamContract");
const { errorKind } = require("../errorDescription");

/**
 * One run of one answer on the live stream.
 *
 * Builds the plaintext frames of the contract (`streamContract.js`), seals each with the prompt's
 * session key and hands the ciphertext to a sink. The plaintext is kept: `record()` projects it
 * into the reasoning and sources the answer MessageFile stores, so what was shown live and what is
 * stored come from the same frames, built before encryption and before any send.
 *
 * WHY A QUEUE. Thoughts arrive from ElizaOS's async callback and are sanitised asynchronously
 * before they become steps; two sanitisations finishing out of order would put the steps out of
 * order. Every frame after the reset is APPLIED through one queue, so frames keep the order of the
 * calls that asked for them.
 *
 * WHY THE WORK STARTS WHEN IT IS QUEUED. Each piece of work (a thought's sanitising) is started at
 * once and given `taskTimeoutMs` from that moment; only applying its result waits for the work
 * queued before it. So every piece is settled, applied or cut off, within `taskTimeoutMs` of being
 * queued, however many are queued, and a `flush()` waits at most that long for the work queued
 * before it. Run one after another, N slow thoughts would need N times as long, and a bounded
 * flush would lose the later ones.
 *
 * WHY NOTHING HERE CAN HURT AN ANSWER. No method throws or returns a promise the answer path must
 * wait on, except `flush()`, which is bounded by `flushTimeoutMs`. A piece of work that hangs is cut
 * off, so it cannot hold back the frames behind it, and its late result is dropped and counted.
 * Every sink call is guarded and never awaited. A run holds a bounded number of
 * frames (one reset, at most four attempts of at most 64 steps and one sources frame each, one
 * answer, one done), each bounded in size. A stream that cannot be built is replaced by an offline
 * one: the record still works and nothing is sent.
 *
 * Once `record()` has been read, no further step, sources or attempt frame is built, so nothing
 * can be shown live that the stored record does not hold.
 */

/**
 * How long one piece of queued work may take, from when it was queued. Above the thought
 * sanitiser's own limit (`THOUGHT_SANITIZE_TIMEOUT_MS`, 2 s, pinned by a test), so a thought is
 * cut off by the sanitiser, which counts why, before the stream gives up on it.
 */
const DEFAULT_TASK_TIMEOUT_MS = 2500;
/** Room for applying the settled results (each a small seal) and for timer lateness. */
const FLUSH_MARGIN_MS = 500;
/**
 * How long `flush()` may make the answer wait. Every piece of work queued before the flush is
 * settled within `taskTimeoutMs` of being queued (see the header), so the bound is that plus the
 * margin: 3 s by default. If it is reached anyway (a blocked event loop), a step that lands after
 * the record was read is neither streamed nor stored, and is counted as a `late` drop.
 */
const DEFAULT_FLUSH_TIMEOUT_MS = DEFAULT_TASK_TIMEOUT_MS + FLUSH_MARGIN_MS;
const OFFLINE_ANSWER_ID = "0";
const OFFLINE_REPLICA = "offline";

/**
 * Why a thought was neither streamed nor stored. `timeout`, `unavailable`, `refused` and `failed`
 * come from the thought sanitiser; `late` is a step that landed after its run had ended or its
 * record had been read. What is dropped by design (a tool payload, nothing left after the fence
 * strip) is not counted.
 */
const THOUGHT_DROP_KINDS = Object.freeze(["timeout", "unavailable", "refused", "failed", "late"]);

// Process-wide counts for the heartbeat. Never an id.
const counters = {
  framesBuilt: 0,
  sinkFailures: 0,
  sealFailures: 0,
  // Queued work whose result could not be applied (a step's numbering function that threw):
  // nothing was sent or kept for it.
  buildFailures: 0,
  thoughtsDropped: Object.fromEntries(THOUGHT_DROP_KINDS.map((kind) => [kind, 0])),
};
const streamCounters = Object.freeze({
  snapshot: () => ({ ...counters, thoughtsDropped: { ...counters.thoughtsDropped } }),
});

let thoughtDropListener = null;

/** Who hears of each dropped thought, by kind (the oracle's alert); null for nobody. */
function setThoughtDropListener(listener) {
  thoughtDropListener = typeof listener === "function" ? listener : null;
}

/** Counts one dropped thought by its kind and tells the listener. Never throws. */
function noteThoughtDropped(kind) {
  if (!THOUGHT_DROP_KINDS.includes(kind)) return;
  counters.thoughtsDropped[kind] += 1;
  try {
    thoughtDropListener?.(kind);
  } catch {
    // An alert that fails must not reach the answer path.
  }
}

const noop = () => undefined;

function cleanSources(list) {
  if (!Array.isArray(list)) return [];
  const kept = [];
  for (const item of list) {
    if (kept.length >= LIMITS.maxSourcesPerFrame) break;
    const title = typeof item?.title === "string" ? item.title.trim() : "";
    const url = typeof item?.url === "string" ? item.url.trim() : "";
    if (!title || !url || url.length > LIMITS.sourceUrlChars) continue;
    let protocol;
    try {
      ({ protocol } = new URL(url));
    } catch {
      continue;
    }
    if (protocol !== "http:" && protocol !== "https:") continue;
    kept.push({ title: capChars(title, LIMITS.sourceTitleChars), url });
  }
  return kept;
}

function cleanStep(value) {
  const title = typeof value?.title === "string" ? value.title.trim() : "";
  const description = typeof value?.description === "string" ? value.description.trim() : "";
  if (!title || !description) return null;
  return {
    title: capChars(title, LIMITS.stepTitleChars),
    description: capChars(description, LIMITS.stepDescriptionChars),
  };
}

/**
 * The stored record: every step and source built, each with its attempt, and `answerAttempt`,
 * the attempt current when the record was read (the highest attempt any frame built carries; 1
 * when no fallback tier was entered). The record is read once the answer is in, so that is the
 * attempt that produced it, and every item with a lower attempt belongs to an earlier one.
 */
function projectRecord(frames) {
  const reasoning = [];
  const sources = [];
  let answerAttempt = 1;
  for (const frame of frames) {
    if (frame.type === FRAME_TYPES.STEP) {
      const { title, description, attempt } = frame.data;
      reasoning.push({ title, description, attempt });
    } else if (frame.type === FRAME_TYPES.SOURCES) {
      for (const { title, url } of frame.data.sources) {
        sources.push({ title, url, attempt: frame.data.attempt });
      }
    }
    if (frame.type === FRAME_TYPES.STEP || frame.type === FRAME_TYPES.SOURCES || frame.type === FRAME_TYPES.ATTEMPT) {
      answerAttempt = Math.max(answerAttempt, frame.data.attempt);
    }
  }
  return { reasoning, sources, answerAttempt };
}

function buildStream(options, deliver) {
  const {
    answerMessageId,
    sessionKey,
    replica,
    sink = noopSink,
    run = newRunId(),
    ivSource,
    taskTimeoutMs = DEFAULT_TASK_TIMEOUT_MS,
    flushTimeoutMs = DEFAULT_FLUSH_TIMEOUT_MS,
  } = options;
  const id = deliver ? answerMessageId : OFFLINE_ANSWER_ID;
  const replicaId = deliver ? replica : OFFLINE_REPLICA;
  const reason = RESET_REASONS.includes(options.reason) ? options.reason : "start";

  let expectedProof;
  if (deliver) {
    if (!isSink(sink)) throw new TypeError("The stream sink lacks open, frame or close.");
    // Checks the key and the id; the frame builder below checks the run and the replica.
    expectedProof = streamProof(sessionKey, answerMessageId);
  }
  // The reset is built (which checks the run and the replica) and sealed before the sink hears of
  // the run. If it cannot be sealed, this throws and the caller gets an offline stream, rather
  // than a run opened on the sink whose seq 0 never comes.
  const reset = buildFrame({
    answerMessageId: id,
    run,
    seq: 0,
    replica: replicaId,
    type: FRAME_TYPES.RESET,
    data: { reason },
  });
  const resetCiphertext = deliver ? encryptFrame(reset, sessionKey, ivSource) : undefined;

  const frames = [];
  let seq = 0;
  let attempt = 1;
  let closing = false;
  let ended = false;
  let sealed = false;
  let answered = false;
  let sinkFailureLogged = false;
  const stepsInAttempt = new Map();
  const attemptsWithSources = new Set();
  let tail = Promise.resolve();

  function noteSinkFailure(error) {
    counters.sinkFailures += 1;
    if (sinkFailureLogged) return;
    sinkFailureLogged = true;
    console.warn(`[Stream] The stream sink failed (${errorKind(error)}); the answer is not affected.`);
  }

  function callSink(method, info) {
    if (!deliver) return;
    try {
      const result = sink[method](id, info);
      if (result && typeof result.then === "function") result.then(undefined, noteSinkFailure);
    } catch (error) {
      noteSinkFailure(error);
    }
  }

  /**
   * Builds, seals, keeps and sends one frame. True when built; false when it would be over
   * `maxBytes`; null when it could not be sealed. The frame is sealed BEFORE it takes a sequence
   * number or is kept, so a seal that fails leaves no gap the dApp would wait on and nothing in
   * the record that was not sent.
   */
  function emit(type, data, maxBytes = LIMITS.framePlaintextBytes) {
    const frame = buildFrame({ answerMessageId: id, run, seq, replica: replicaId, type, data });
    if (Buffer.byteLength(JSON.stringify(frame), "utf-8") > maxBytes) return false;
    let ciphertext;
    if (deliver) {
      try {
        ciphertext = encryptFrame(frame, sessionKey, ivSource);
      } catch {
        // Nothing about the frame or the error is printed: either can carry its text.
        counters.sealFailures += 1;
        return null;
      }
    }
    frames.push(frame);
    seq += 1;
    if (!deliver) return true;
    counters.framesBuilt += 1;
    callSink("frame", { run, seq: frame.seq, ciphertext });
    return true;
  }

  /**
   * Starts `produce` (sync or async) now and settles within `taskTimeoutMs`: to
   * `{ value }`, or to null when it threw or took too long. `onLate` gets a value that arrives
   * after the cut-off.
   */
  function startBounded(produce, onLate) {
    return new Promise((resolve) => {
      let finished = false;
      const finish = (outcome) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve(outcome);
      };
      const timer = setTimeout(() => finish(null), taskTimeoutMs);
      timer.unref?.();
      let pending;
      try {
        pending = Promise.resolve(produce());
      } catch {
        finish(null);
        return;
      }
      pending.then(
        (value) => {
          if (!finished) {
            finish({ value });
            return;
          }
          try {
            onLate?.(value);
          } catch {
            // Counting a late result must not throw out of a promise nobody awaits.
          }
        },
        () => finish(null),
      );
    });
  }

  /** Starts the work now; applies its result in queue order. */
  function enqueue(produce, apply, onLate) {
    const settled = startBounded(produce, onLate);
    tail = tail
      .then(() => settled)
      .then((outcome) => {
        if (!outcome) return;
        try {
          apply(outcome.value);
        } catch {
          // A frame that cannot be built is skipped, neither sent nor kept, and counted; nothing
          // about it is printed (it could carry model text).
          counters.buildFailures += 1;
        }
      });
  }

  callSink("open", { run, replica: replicaId, expectedProof });
  frames.push(reset);
  seq = 1;
  if (deliver) {
    counters.framesBuilt += 1;
    callSink("frame", { run, seq: 0, ciphertext: resetCiphertext });
  }

  return {
    run,
    replica: replicaId,

    /** The sources for the current attempt: once per attempt, before its first step. */
    sources(list) {
      if (closing) return;
      let items;
      try {
        items = cleanSources(list);
      } catch {
        return;
      }
      if (items.length === 0) return;
      enqueue(noop, () => {
        if (sealed || ended) return;
        if (attemptsWithSources.has(attempt) || (stepsInAttempt.get(attempt) ?? 0) > 0) return;
        // Trimmed from the end until the frame fits the plaintext limit.
        for (let n = items.length; n > 0; n -= 1) {
          const built = emit(FRAME_TYPES.SOURCES, { attempt, sources: items.slice(0, n) });
          if (built) {
            attemptsWithSources.add(attempt);
            return;
          }
          // Not sealed: nothing is sent, and a shorter list would not seal either.
          if (built === null) return;
        }
      });
    },

    /**
     * A step of the current attempt: a `{ title, description }`, or a function giving one (or
     * null to skip), possibly async. The work may also give a function of the step's place in
     * its attempt (0 for the first step built in it), called when the step is applied, so a
     * "Step N" title follows the order the steps are shown in. Order is the order of the calls.
     *
     * A step whose work gives something after the run ended, after the record was read or after
     * its cut-off is neither streamed nor stored, and is counted as a `late` drop.
     */
    step(stepOrWork) {
      if (closing) return;
      const produce = typeof stepOrWork === "function" ? stepOrWork : () => stepOrWork;
      const late = (value) => {
        if (value) noteThoughtDropped("late");
      };
      enqueue(
        produce,
        (value) => {
          if (sealed || ended) {
            late(value);
            return;
          }
          const count = stepsInAttempt.get(attempt) ?? 0;
          const step = cleanStep(typeof value === "function" ? value(count) : value);
          if (!step) return;
          if (count >= LIMITS.maxStepsPerAttempt) return;
          if (emit(FRAME_TYPES.STEP, { attempt, ...step })) stepsInAttempt.set(attempt, count + 1);
        },
        late,
      );
    },

    /**
     * A fallback tier started. Earlier steps stay; this is not a reset. Not after the record was
     * read, so the attempt it stores as the answering one is the last one shown.
     */
    attempt() {
      if (closing) return;
      enqueue(noop, () => {
        if (sealed || ended || attempt >= LIMITS.maxAttempts) return;
        attempt += 1;
        emit(FRAME_TYPES.ATTEMPT, { attempt });
      });
    },

    /** The completed answer, once, after this run's submitAnswer receipt. */
    answer(answer) {
      if (closing) return;
      const text = answer?.text;
      const answerMessageCID = answer?.answerMessageCID;
      const reasoningDuration = answer?.reasoningDuration;
      if (typeof text !== "string" || typeof answerMessageCID !== "string") return;
      enqueue(noop, () => {
        if (ended || answered) return;
        answered = true;
        // Over a limit the frame is left out and the dApp waits for the stored answer.
        if (Buffer.byteLength(text, "utf-8") > LIMITS.answerTextBytes) return;
        if (!isAnswerCid(answerMessageCID)) return;
        const data = { text, answerMessageCID };
        if (Number.isFinite(reasoningDuration)) data.reasoningDuration = reasoningDuration;
        emit(FRAME_TYPES.ANSWER, data, LIMITS.answerFramePlaintextBytes);
      });
    },

    /** The last frame of the run, once; the sink is closed after it. */
    done(outcome) {
      if (closing || !DONE_OUTCOMES.includes(outcome)) return;
      closing = true;
      enqueue(noop, () => {
        if (ended) return;
        // The sink is closed whether or not the done frame could be built or sealed (a seal
        // failure is counted in emit): a run left open would hold its readers until it expires,
        // and the stored answer is what they fall back to either way.
        emit(FRAME_TYPES.DONE, { outcome });
        ended = true;
        callSink("close", { run, outcome });
      });
    },

    /** Resolves when the work queued so far is done, or after `flushTimeoutMs`. Never rejects. */
    flush() {
      const current = tail;
      return new Promise((resolve) => {
        const timer = setTimeout(resolve, flushTimeoutMs);
        timer.unref?.();
        current.then(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    },

    /**
     * The stored reasoning, sources and answering attempt: a projection of the frames built.
     * Seals all three.
     */
    record() {
      sealed = true;
      return projectRecord(frames);
    },
  };
}

/**
 * Opens the live stream for one run of one answer. Never throws: a stream that cannot be built
 * (a malformed key, id or replica, or something that is not a sink) is replaced by an offline one.
 *
 * @param {object} options
 * @param {string} options.answerMessageId canonical decimal string
 * @param {Buffer} options.sessionKey the prompt's 32-byte session key
 * @param {string} options.replica this process's replica id
 * @param {object} [options.sink] the sink (see streamContract); the no-op sink by default
 * @param {"start"|"retry"} [options.reason] whether this process ran the job before
 */
function createAnswerStream(options = {}) {
  try {
    return buildStream(options, true);
  } catch (error) {
    console.warn(`[Stream] Could not open a live stream (${errorKind(error)}); answering without one.`);
    return buildStream({ reason: options.reason }, false);
  }
}

/** A stream that builds a record and sends nothing, for callers with no answer to stream. */
function createOfflineStream() {
  return buildStream({}, false);
}

module.exports = {
  createAnswerStream,
  createOfflineStream,
  streamCounters,
  noteThoughtDropped,
  setThoughtDropListener,
  THOUGHT_DROP_KINDS,
  DEFAULT_TASK_TIMEOUT_MS,
  DEFAULT_FLUSH_TIMEOUT_MS,
  FLUSH_MARGIN_MS,
};
