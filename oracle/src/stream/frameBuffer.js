const { STREAM_HTTP, isSealedFrame, isSeq } = require("./streamContract");

/**
 * What each answer's current run has sent, kept so a reader that connects late or reconnects
 * gets the frames it missed. It holds only ciphertext and the expected proof, never a key, and it
 * knows nothing about HTTP: the stream server reads it, and a relay or long-poll could too.
 *
 * Lifecycle of one answer:
 *   open   a run starts; any earlier run's frames are dropped (its first frame is a reset)
 *   append frames in seq order; anything out of order, of another run, or not a sealed frame
 *          no longer than the contract's largest (`isSealedFrame`) is ignored
 *   close  the run ended; the frames stay for `graceMs`, for a second device that finds the
 *          answer late, then are dropped. An answered or abandoned run leaves a tombstone for
 *          `tombstoneMs`, so a late reader is told the answer is finished (410) rather than not
 *          open (404). An interrupted run leaves none: a retry may follow, and a reader keeps
 *          asking on 404.
 *
 * WHY THE CAPS. The oracle runs in a TEE with a fixed amount of memory, and a restart drops
 * every job in flight. Frames are bounded per run by the contract, but the number of answers is
 * not, so: at most `maxAnswerBytes` per answer, `maxTotalBytes` in all and `maxOpenAnswers`
 * answers held at once. Finished answers are dropped first to make room. An answer that still
 * does not fit is marked unavailable (503) until its next run: its readers wait for the stored
 * answer, which is unaffected.
 *
 * Nothing here throws to a caller, and nothing here is printed.
 */

const BUFFER_LIMITS = Object.freeze({
  maxAnswerBytes: 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxOpenAnswers: 512,
  /** Tombstones and refusals are a few dozen bytes each; this bounds them too. */
  maxTombstones: 4096,
});

const TOMBSTONE_OUTCOMES = new Set(["answered", "abandoned"]);

/**
 * @param {object} options
 * @param {number} options.graceMs how long a finished answer's frames are kept
 * @param {number} [options.tombstoneMs] how long a dropped answer answers "gone"
 * @param {typeof BUFFER_LIMITS} [options.limits]
 * @param {() => number} [options.now]
 */
function createFrameBuffer({
  graceMs,
  tombstoneMs = STREAM_HTTP.tombstoneMs,
  limits = BUFFER_LIMITS,
  now = () => Date.now(),
} = {}) {
  /** id → { run, expectedProof, frames, bytes, state: open|finished|unavailable, outcome, timer, listeners } */
  const answers = new Map();
  /** id → expiry time; "gone" (410). Insertion order is age order. */
  const tombstones = new Map();
  /** id → expiry time; refused at open for want of room (503) until it opens or expires. */
  const refused = new Map();
  let totalBytes = 0;
  // Counts for the heartbeat, never an id: a climbing count means live views lose frames (a
  // frame out of sequence refuses the rest of its run) or answers find no room.
  let refusedAppends = 0;
  let refusedOpens = 0;

  function notify(entry, event) {
    for (const listener of [...entry.listeners]) {
      try {
        listener(event);
      } catch {
        // One reader's failure is its own; the others and the answer path carry on.
      }
    }
  }

  function remember(map, id) {
    map.delete(id);
    map.set(id, now() + tombstoneMs);
    while (map.size > limits.maxTombstones) map.delete(map.keys().next().value);
  }

  function isLive(map, id) {
    const expires = map.get(id);
    if (expires === undefined) return false;
    if (now() < expires) return true;
    map.delete(id);
    return false;
  }

  function freeFrames(entry) {
    totalBytes -= entry.bytes;
    entry.frames = [];
    entry.bytes = 0;
  }

  /** Removes an answer for good; its readers hear an end. */
  function drop(id) {
    const entry = answers.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    freeFrames(entry);
    answers.delete(id);
    if (TOMBSTONE_OUTCOMES.has(entry.outcome)) remember(tombstones, id);
    notify(entry, { kind: "end" });
    entry.listeners.clear();
  }

  function markUnavailable(entry) {
    freeFrames(entry);
    entry.state = "unavailable";
    notify(entry, { kind: "end" });
  }

  /** Keeps the next frame of the current run; false when it is not kept. */
  function keepFrame(id, { run, seq, ciphertext }) {
    const entry = answers.get(id);
    if (!entry || entry.state !== "open" || run !== entry.run) return false;
    if (!isSeq(seq) || seq !== entry.frames.length || !isSealedFrame(ciphertext)) return false;
    const size = ciphertext.length;
    if (entry.bytes + size > limits.maxAnswerBytes) {
      markUnavailable(entry);
      return false;
    }
    while (totalBytes + size > limits.maxTotalBytes) {
      if (!dropOldestFinished()) {
        markUnavailable(entry);
        return false;
      }
    }
    const frame = { run, seq, ciphertext };
    entry.frames.push(frame);
    entry.bytes += size;
    totalBytes += size;
    notify(entry, { kind: "frame", frame });
    return true;
  }

  /** Drops the oldest finished answer; false when there is none. */
  function dropOldestFinished() {
    for (const [id, entry] of answers) {
      if (entry.state === "finished") {
        drop(id);
        return true;
      }
    }
    return false;
  }

  return {
    /** A run starts. False when there is no room for another answer. */
    open(id, { run, expectedProof }) {
      const existing = answers.get(id);
      if (existing) {
        clearTimeout(existing.timer);
        freeFrames(existing);
        // Readers follow the new run on the same connection (its first frame is a reset), but
        // only while the proof they showed is still the one that opens it.
        if (existing.expectedProof !== expectedProof) {
          notify(existing, { kind: "end" });
          existing.listeners.clear();
        }
        Object.assign(existing, { run, expectedProof, state: "open", outcome: null, timer: null });
        return true;
      }
      while (answers.size >= limits.maxOpenAnswers) {
        if (!dropOldestFinished()) {
          remember(refused, id);
          refusedOpens += 1;
          return false;
        }
      }
      tombstones.delete(id);
      refused.delete(id);
      answers.set(id, {
        run,
        expectedProof,
        frames: [],
        bytes: 0,
        state: "open",
        outcome: null,
        timer: null,
        listeners: new Set(),
      });
      return true;
    },

    /** The next frame of the current run. False when it is not kept, and then counted. */
    append(id, frame) {
      const kept = keepFrame(id, frame);
      if (!kept) refusedAppends += 1;
      return kept;
    },

    /** The current run ended. Its frames stay for the grace period. */
    close(id, { run, outcome }) {
      const entry = answers.get(id);
      if (!entry || run !== entry.run || entry.state === "finished") return false;
      entry.state = entry.state === "unavailable" ? "unavailable" : "finished";
      entry.outcome = outcome;
      entry.timer = setTimeout(() => drop(id), graceMs);
      entry.timer.unref?.();
      if (entry.state === "finished") notify(entry, { kind: "end" });
      return true;
    },

    /**
     * What a reader asking for `id` would find: open, finished (closed, still replayable),
     * unavailable (no room), gone (finished and dropped) or unknown.
     */
    lookup(id) {
      const entry = answers.get(id);
      if (entry) return { state: entry.state, run: entry.run, expectedProof: entry.expectedProof };
      if (isLive(refused, id)) return { state: "unavailable" };
      if (isLive(tombstones, id)) return { state: "gone" };
      return { state: "unknown" };
    },

    /**
     * The current run's frames after `cursor` ({ run, seq }), or all of them when the cursor is
     * absent or names another run.
     */
    framesAfter(id, cursor) {
      const entry = answers.get(id);
      if (!entry) return [];
      if (!cursor || cursor.run !== entry.run) return [...entry.frames];
      return entry.frames.slice(cursor.seq + 1);
    },

    /** Calls `listener` with { kind: "frame", frame } and { kind: "end" }; returns unsubscribe. */
    subscribe(id, listener) {
      const entry = answers.get(id);
      if (!entry) return null;
      entry.listeners.add(listener);
      return () => entry.listeners.delete(listener);
    },

    stats() {
      return {
        answers: answers.size,
        bytes: totalBytes,
        tombstones: tombstones.size,
        refusedOpens,
        refusedAppends,
      };
    },

    /** Drops everything and its timers; readers hear an end. */
    dispose() {
      for (const id of [...answers.keys()]) {
        const entry = answers.get(id);
        entry.outcome = null;
        drop(id);
      }
      tombstones.clear();
      refused.clear();
    },
  };
}

module.exports = { createFrameBuffer, BUFFER_LIMITS };
