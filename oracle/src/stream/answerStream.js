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
 * WHY A SERIAL QUEUE. Thoughts arrive from ElizaOS's async callback and are sanitised
 * asynchronously before they become steps; two sanitisations finishing out of order would put the
 * steps out of order. Every frame after the reset goes through one queue, so frames keep the order
 * of the calls that asked for them.
 *
 * WHY NOTHING HERE CAN HURT AN ANSWER. No method throws or returns a promise the answer path must
 * wait on, except `flush()`, which is bounded by `flushTimeoutMs`. Each queued piece of work is cut
 * off after `taskTimeoutMs`, so one that hangs cannot hold back the frames behind it, and its late
 * result is dropped. Every sink call is guarded and never awaited. A run holds a bounded number of
 * frames (one reset, at most four attempts of at most 64 steps and one sources frame each, one
 * answer, one done), each bounded in size. A stream that cannot be built is replaced by an offline
 * one: the record still works and nothing is sent.
 *
 * Once `record()` has been read, no further step or sources frame is built, so nothing can be
 * shown live that the stored record does not hold.
 */

const DEFAULT_TASK_TIMEOUT_MS = 2500;
const DEFAULT_FLUSH_TIMEOUT_MS = 3000;
const OFFLINE_ANSWER_ID = "0";
const OFFLINE_REPLICA = "offline";

// Process-wide counts for the heartbeat. Never an id.
const counters = { framesBuilt: 0, sinkFailures: 0 };
const streamCounters = Object.freeze({ snapshot: () => ({ ...counters }) });

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

function projectRecord(frames) {
  const reasoning = [];
  const sources = [];
  for (const frame of frames) {
    if (frame.type === FRAME_TYPES.STEP) {
      const { title, description, attempt } = frame.data;
      reasoning.push({ title, description, attempt });
    } else if (frame.type === FRAME_TYPES.SOURCES) {
      for (const { title, url } of frame.data.sources) {
        sources.push({ title, url, attempt: frame.data.attempt });
      }
    }
  }
  return { reasoning, sources };
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
  buildFrame({ answerMessageId: id, run, seq: 0, replica: replicaId, type: FRAME_TYPES.RESET, data: null });

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

  /** Builds, keeps and sends one frame; false when it would be over `maxBytes` and was not built. */
  function emit(type, data, maxBytes = LIMITS.framePlaintextBytes) {
    const frame = buildFrame({ answerMessageId: id, run, seq, replica: replicaId, type, data });
    if (Buffer.byteLength(JSON.stringify(frame), "utf-8") > maxBytes) return false;
    frames.push(frame);
    seq += 1;
    if (!deliver) return true;
    counters.framesBuilt += 1;
    let ciphertext;
    try {
      ciphertext = encryptFrame(frame, sessionKey, ivSource);
    } catch (error) {
      noteSinkFailure(error);
      return true;
    }
    callSink("frame", { run, seq: frame.seq, ciphertext });
    return true;
  }

  /** Runs `produce` (sync or async), then `apply` with its value, unless it took too long. */
  function runBounded(produce, apply) {
    return new Promise((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, taskTimeoutMs);
      timer.unref?.();
      let pending;
      try {
        pending = Promise.resolve(produce());
      } catch {
        finish();
        return;
      }
      pending.then(
        (value) => {
          if (finished) return;
          try {
            apply(value);
          } catch {
            // A frame that cannot be built is skipped; nothing about it is printed.
          }
          finish();
        },
        finish,
      );
    });
  }

  function enqueue(produce, apply) {
    tail = tail.then(() => runBounded(produce, apply));
  }

  callSink("open", { run, replica: replicaId, expectedProof });
  emit(FRAME_TYPES.RESET, { reason });

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
          if (emit(FRAME_TYPES.SOURCES, { attempt, sources: items.slice(0, n) })) {
            attemptsWithSources.add(attempt);
            return;
          }
        }
      });
    },

    /**
     * A step of the current attempt: a `{ title, description }`, or a function giving one (or
     * null to skip), possibly async. Order is the order of the calls.
     */
    step(stepOrWork) {
      if (closing) return;
      const produce = typeof stepOrWork === "function" ? stepOrWork : () => stepOrWork;
      enqueue(produce, (value) => {
        if (sealed || ended) return;
        const step = cleanStep(value);
        if (!step) return;
        const count = stepsInAttempt.get(attempt) ?? 0;
        if (count >= LIMITS.maxStepsPerAttempt) return;
        if (emit(FRAME_TYPES.STEP, { attempt, ...step })) stepsInAttempt.set(attempt, count + 1);
      });
    },

    /** A fallback tier started. Earlier steps stay; this is not a reset. */
    attempt() {
      if (closing) return;
      enqueue(noop, () => {
        if (ended || attempt >= LIMITS.maxAttempts) return;
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
        // Over the limit the frame is left out and the dApp waits for the stored answer.
        if (Buffer.byteLength(text, "utf-8") > LIMITS.answerTextBytes) return;
        const data = { text, answerMessageCID };
        if (Number.isFinite(reasoningDuration)) data.reasoningDuration = reasoningDuration;
        emit(FRAME_TYPES.ANSWER, data, Infinity);
      });
    },

    /** The last frame of the run, once; the sink is closed after it. */
    done(outcome) {
      if (closing || !DONE_OUTCOMES.includes(outcome)) return;
      closing = true;
      enqueue(noop, () => {
        if (ended) return;
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

    /** The stored reasoning and sources: a projection of the frames built. Seals both. */
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
  DEFAULT_TASK_TIMEOUT_MS,
  DEFAULT_FLUSH_TIMEOUT_MS,
};
