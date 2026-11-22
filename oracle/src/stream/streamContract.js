const crypto = require("crypto");

const { encryptSymmetrically, GCM_IV_BYTES, GCM_AUTH_TAG_BYTES } = require("./frameCrypto");

/**
 * Live reasoning stream: the oracle's half of the interface contract, version 1.
 *
 * The dApp keeps its own copy of these rules (`src/lib/liveReasoning/contract.ts`). The two are
 * held equal by the shared test vector in `oracle/test/streamContract.test.js`, so any change
 * here is a change to both repos at once, and to that vector.
 *
 * A frame is a small JSON object, sealed with the prompt's session key exactly as the stored
 * answer file is. The type travels only inside the ciphertext. The stored record is a projection
 * of these same frames (see `answerStream.js`), which is what makes what is shown live equal to
 * what is stored.
 */

const STREAM_CONTRACT_VERSION = 1;

const FRAME_TYPES = Object.freeze({
  RESET: "reset",
  SOURCES: "sources",
  STEP: "step",
  ATTEMPT: "attempt",
  ANSWER: "answer",
  DONE: "done",
});

const RESET_REASONS = Object.freeze(["start", "retry"]);
const DONE_OUTCOMES = Object.freeze(["answered", "abandoned", "interrupted"]);

/** Every SSE event has this one name, so a proxy sees only lengths and timing. */
const SSE_EVENT_NAME = "frame";

/**
 * Every limit is applied before a frame is built, so the stored copy is cut the same way.
 *
 * `framePlaintextBytes` holds for every frame but one: the `answer` frame, whose limit is
 * `answerFramePlaintextBytes`. Its text is the exact stored answer and is limited only by
 * `answerTextBytes` (64 KiB of UTF-8; over it the frame is left out and the dApp waits for the
 * stored answer). JSON escaping can grow that text up to six times, since a control character is
 * written `\u00XX` (a quote or backslash doubles, a lone surrogate is 6 bytes for 3), so the text
 * takes at most 6 x 64 KiB = 384 KiB of the plaintext. The rest of the frame (the identities at
 * their longest, a content id of `answerCidChars`, the longest finite duration) is at most 429
 * bytes, so 1 KiB more bounds the whole frame with room to spare.
 *
 * `answerCidChars` bounds the content id an answer frame carries, and it may hold only the
 * characters of an id the storage paths produce (`ANSWER_CID_PATTERN`). The longest today is 59
 * (an Autonomys or local IPFS CIDv1 in base32; a legacy Arweave or Irys id is 43 or 44, a mock id
 * 25); 128 also holds a base32 CIDv1 with a 512-bit hash (113). An answer whose id is over it, or
 * not an id, is sent without its answer frame, as an over-long text is.
 *
 * The oracle never builds a frame over its limit; the dApp refuses one, before decrypting when
 * the sealed text is longer than `MAX_SEALED_FRAME_CHARS` and before parsing when the plaintext
 * is over the limit. A stream server must carry a frame of `MAX_SEALED_FRAME_CHARS`.
 */
const LIMITS = Object.freeze({
  maxSourcesPerFrame: 20,
  sourceTitleChars: 300,
  sourceUrlChars: 2048,
  stepTitleChars: 120,
  stepDescriptionChars: 4000,
  maxStepsPerAttempt: 64,
  maxAttempts: 4,
  answerTextBytes: 64 * 1024,
  framePlaintextBytes: 16 * 1024,
  answerFramePlaintextBytes: 6 * 64 * 1024 + 1024,
  answerCidChars: 128,
});

/**
 * The characters of a sealed frame whose plaintext is `plaintextBytes` long, as
 * `encryptSymmetrically` writes it: base64 of the 12-byte IV (16), a dot, then base64 of the
 * ciphertext with its 16-byte tag (GCM adds no padding).
 */
function sealedFrameChars(plaintextBytes) {
  const base64Chars = (bytes) => 4 * Math.ceil(bytes / 3);
  return base64Chars(GCM_IV_BYTES) + 1 + base64Chars(plaintextBytes + GCM_AUTH_TAG_BYTES);
}

/** The longest sealed frame the contract allows (an answer frame at its limit): 525,693. */
const MAX_SEALED_FRAME_CHARS = sealedFrameChars(LIMITS.answerFramePlaintextBytes);

/** The on-chain uint256 in decimal: no sign, no leading zeros, at most 78 digits. */
const ANSWER_MESSAGE_ID_PATTERN = /^(0|[1-9][0-9]{0,77})$/;
const RUN_PATTERN = /^[0-9a-f]{16}$/;
const REPLICA_PATTERN = /^[a-z0-9-]{1,32}$/;
/** base64url of a 32-byte HMAC, no padding. */
const PROOF_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SSE_EVENT_ID_PATTERN = /^([0-9a-f]{16})\.(0|[1-9][0-9]{0,8})$/;
/** A content id: the base32 and base64url characters the storage ids use, `answerCidChars` at most. */
const ANSWER_CID_PATTERN = new RegExp(`^[A-Za-z0-9_-]{1,${LIMITS.answerCidChars}}$`);

const PROOF_DOMAIN = "senseai-stream:";
const SESSION_KEY_BYTES = 32;
const RUN_BYTES = 8;
const RANDOM_REPLICA_BYTES = 4;

const isAnswerMessageId = (value) => typeof value === "string" && ANSWER_MESSAGE_ID_PATTERN.test(value);
const isRun = (value) => typeof value === "string" && RUN_PATTERN.test(value);
const isReplica = (value) => typeof value === "string" && REPLICA_PATTERN.test(value);
const isSeq = (value) => Number.isSafeInteger(value) && value >= 0;
const isAnswerCid = (value) => typeof value === "string" && ANSWER_CID_PATTERN.test(value);

/** A new run id for every attempt at a job; random so it never repeats across restarts. */
function newRunId(randomBytes = crypto.randomBytes) {
  return randomBytes(RUN_BYTES).toString("hex");
}

/**
 * `ORACLE_REPLICA_ID` when set, otherwise 8 random hex characters chosen once by the caller at
 * boot. A value outside the pattern stops start-up; the message describes it without repeating it.
 */
function resolveReplicaId(env = process.env, randomBytes = crypto.randomBytes) {
  const configured = env.ORACLE_REPLICA_ID;
  if (configured === undefined || configured === "") {
    return randomBytes(RANDOM_REPLICA_BYTES).toString("hex");
  }
  if (!isReplica(configured)) {
    throw new Error("ORACLE_REPLICA_ID must be 1 to 32 characters of a-z, 0-9 and '-'.");
  }
  return configured;
}

function sseEventId(run, seq) {
  return `${run}.${seq}`;
}

/** `{ run, seq }` for a well-formed `<run>.<seq>`, otherwise null. */
function parseSseEventId(text) {
  if (typeof text !== "string") return null;
  const match = SSE_EVENT_ID_PATTERN.exec(text);
  if (!match) return null;
  return { run: match[1], seq: Number(match[2]) };
}

function requireSessionKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== SESSION_KEY_BYTES) {
    throw new TypeError(`The session key must be a ${SESSION_KEY_BYTES}-byte Buffer.`);
  }
}

/**
 * Proof of key: base64url(HMAC-SHA256(session key, "senseai-stream:" + answerMessageId)).
 * Only the user and the oracle can compute it. The oracle hands the stream server this value,
 * never the key.
 */
function streamProof(key, answerMessageId) {
  requireSessionKey(key);
  if (!isAnswerMessageId(answerMessageId)) {
    throw new TypeError("The answer id must be a canonical decimal string.");
  }
  return crypto
    .createHmac("sha256", key)
    .update(Buffer.from(PROOF_DOMAIN + answerMessageId, "utf-8"))
    .digest("base64url");
}

const KNOWN_TYPES = new Set(Object.values(FRAME_TYPES));

/**
 * The plaintext of one frame, its keys in the contract's order (the shared vector depends on it).
 * Identities are checked; `data` is the caller's, already shaped and capped.
 */
function buildFrame({ answerMessageId, run, seq, replica, type, data }) {
  if (!isAnswerMessageId(answerMessageId)) throw new TypeError("Bad frame answer id.");
  if (!isRun(run)) throw new TypeError("Bad frame run.");
  if (!isSeq(seq)) throw new TypeError("Bad frame seq.");
  if (!isReplica(replica)) throw new TypeError("Bad frame replica.");
  if (!KNOWN_TYPES.has(type)) throw new TypeError("Unknown frame type.");
  return { v: STREAM_CONTRACT_VERSION, answerMessageId, run, seq, replica, type, data };
}

/**
 * Cuts text to at most `max` UTF-16 units (what `.length` counts on both sides) without leaving
 * half a surrogate pair at the end. Every text limit in the contract is applied with this, before
 * the frame is built, so the stored copy is cut identically.
 */
function capChars(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** Seals a frame with the session key; the `iv.ciphertext` string a sink receives. */
function encryptFrame(frame, key, ivSource) {
  requireSessionKey(key);
  return encryptSymmetrically(frame, key, ivSource);
}

/**
 * Where the answer path sends frames. All three methods are synchronous, must never throw and
 * never wait on a client:
 *
 *   open(answerMessageId, { run, replica, expectedProof })  // replaces any earlier run's buffer
 *   frame(answerMessageId, { run, seq, ciphertext })        // ciphertext = "iv.ct"
 *   close(answerMessageId, { run, outcome })                 // after the done frame
 *
 * The answer path still guards every call (`answerStream.js`), so a sink that breaks this rule
 * cannot delay or lose an answer.
 */
const SINK_METHODS = Object.freeze(["open", "frame", "close"]);

const noopSink = Object.freeze({
  open() {},
  frame() {},
  close() {},
});

function isSink(candidate) {
  return (
    candidate !== null &&
    typeof candidate === "object" &&
    SINK_METHODS.every((method) => typeof candidate[method] === "function")
  );
}

module.exports = {
  STREAM_CONTRACT_VERSION,
  FRAME_TYPES,
  RESET_REASONS,
  DONE_OUTCOMES,
  SSE_EVENT_NAME,
  LIMITS,
  MAX_SEALED_FRAME_CHARS,
  ANSWER_MESSAGE_ID_PATTERN,
  ANSWER_CID_PATTERN,
  RUN_PATTERN,
  REPLICA_PATTERN,
  PROOF_PATTERN,
  SINK_METHODS,
  noopSink,
  isSink,
  isAnswerMessageId,
  isRun,
  isReplica,
  isAnswerCid,
  sealedFrameChars,
  newRunId,
  resolveReplicaId,
  sseEventId,
  parseSseEventId,
  streamProof,
  buildFrame,
  encryptFrame,
  capChars,
};
