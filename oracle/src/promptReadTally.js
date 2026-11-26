"use strict";

/**
 * Counts the prompts that could not be read, by kind, and the prompts that were, and says so in
 * one notice at most once an hour.
 *
 * A prompt that cannot be read (its wrapped session key does not open, holds a key of the wrong
 * length, or there is none; its payload is not text) is the sender's mistake and is dropped with
 * no alert of its own. But every prompt fails that way when the dApp encrypts to a key this
 * oracle does not hold, or a dApp build sends something the oracle cannot read, and then no prompt
 * is answered. The counts tell the two apart: some unreadable among many read is senders; none
 * read is the dApp or the oracle's key. The notice carries counts and fixed words only.
 *
 * Pure: no I/O. The caller sends the notice.
 */

const { monotonicNow } = require("./alertThrottle");

/** The ways a prompt can fail to be read. */
const UNREADABLE = Object.freeze({
  wrapNotOpened: "wrap-not-opened",
  keyWrongLength: "key-wrong-length",
  payloadNotUtf8: "payload-not-utf8",
  noKey: "no-key",
});

const KIND_WORDS = Object.freeze({
  [UNREADABLE.wrapNotOpened]: "the wrapped session key did not open",
  [UNREADABLE.keyWrongLength]: "the wrapped session key was not 32 bytes",
  [UNREADABLE.payloadNotUtf8]: "the payload was not UTF-8 text",
  [UNREADABLE.noKey]: "no session key was sent and none stored",
});

const NOTICE_INTERVAL_MS = 60 * 60 * 1000;
// With none read, this many unreadable in one window is no longer a sender or two.
const CRITICAL_AFTER = 3;

function emptyCounts() {
  return Object.fromEntries(Object.values(UNREADABLE).map((kind) => [kind, 0]));
}

/**
 * @param {{ intervalMs?: number, now?: () => number }} [options] `now` defaults to a clock that
 *        only goes forward.
 */
function createPromptReadTally({ intervalMs = NOTICE_INTERVAL_MS, now = monotonicNow } = {}) {
  let read = 0;
  let unreadable = emptyCounts();
  let lastNoticeAt = null;

  const unreadableTotal = () => Object.values(unreadable).reduce((sum, n) => sum + n, 0);

  function buildNotice() {
    const total = unreadableTotal();
    const critical = read === 0 && total >= CRITICAL_AFTER;
    const title = critical
      ? "CRITICAL: No Requests Could Be Read"
      : "Some Requests Could Not Be Read";
    const lines = [
      `Requests read since the last notice: ${read}`,
      `Requests that could not be read: ${total}`,
      ...Object.values(UNREADABLE).map((kind) => `- ${KIND_WORDS[kind]}: ${unreadable[kind]}`),
      "",
      "A request is a prompt, a regeneration, a branch or a rename or delete. Each one that " +
        "could not be read was dropped. A single one is a sender's mistake. " +
        "If none is being read, check that the " +
        "oracle public key the dApp encrypts to (the dApp's VITE_ORACLE_PUBLIC_KEY) is this " +
        "oracle's, and that the deployed dApp build is the current one.",
      "This notice is sent at most once an hour.",
    ];

    return { title, message: lines.join("\n") };
  }

  return {
    /** A prompt whose session key and payload were both read. */
    noteRead() {
      read += 1;
    },

    /** A prompt that could not be read, by its kind; an unknown kind is not counted. */
    noteUnreadable(kind) {
      if (Object.hasOwn(unreadable, kind)) unreadable[kind] += 1;
    },

    /**
     * The notice to send now, or null: nothing could not be read since the last one, or the
     * last one was less than the interval ago. Taking a notice starts the counts again.
     */
    takeNotice() {
      if (unreadableTotal() === 0) return null;
      const at = now();
      if (lastNoticeAt !== null && at - lastNoticeAt < intervalMs) return null;

      const notice = buildNotice();
      read = 0;
      unreadable = emptyCounts();
      lastNoticeAt = at;

      return notice;
    },
  };
}

module.exports = { UNREADABLE, createPromptReadTally };
