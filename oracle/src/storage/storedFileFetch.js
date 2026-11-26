"use strict";

const { LIMITS, sealedFrameChars } = require("../stream/streamContract");
const { StoredFileTooLargeError, StoredFileTimeoutError } = require("../errors");

const KIB = 1024;
const MIB = 1024 * KIB;

/**
 * The largest file the oracle writes is an assistant MessageFile (`formatters.js`), sealed by
 * `encryptSymmetrically` as `base64(iv).base64(ciphertext + tag)`. Its plaintext JSON holds:
 *
 * - reasoning: at most `maxAttempts` (4) x `maxStepsPerAttempt` (64) steps, and each step is
 *   cut to fit a frame of `framePlaintextBytes` (16 KiB) before it is streamed and stored, so
 *   4 MiB at most;
 * - sources: one frame of `framePlaintextBytes` per attempt, so 64 KiB at most;
 * - the answer, which the oracle does not cut: the stream carries one of at most
 *   `answerTextBytes` (64 KiB) of UTF-8, and `ANSWER_ALLOWANCE_BYTES` (1 MiB of JSON, sixteen
 *   times that) is allowed for it here;
 * - its ids, content ids and times, well under 1 KiB.
 *
 * Sealed, that is `LARGEST_WRITTEN_FILE_BYTES` (about 6.8 MiB). A user's prompt file is far
 * smaller (5,000 characters of prompt), and a file as written in practice is a few KB.
 */
const ANSWER_ALLOWANCE_BYTES = 1 * MIB;
const LARGEST_WRITTEN_FILE_PLAINTEXT_BYTES =
  LIMITS.maxAttempts * LIMITS.maxStepsPerAttempt * LIMITS.framePlaintextBytes +
  LIMITS.maxAttempts * LIMITS.framePlaintextBytes +
  ANSWER_ALLOWANCE_BYTES +
  1 * KIB;
const LARGEST_WRITTEN_FILE_BYTES = sealedFrameChars(LARGEST_WRITTEN_FILE_PLAINTEXT_BYTES);

/**
 * The most bytes read for one stored file: the largest file the oracle writes with about 18%
 * to spare. A body is counted as it arrives and the request is ended at the first chunk that
 * passes it; a declared `Content-Length` over it is refused before any of the body is read, and
 * one under it is not trusted.
 */
const MAX_STORED_FILE_BYTES = 8 * MIB;

/**
 * The longest one stored file may take, from the request to the last byte of its body. The
 * largest file the oracle writes arrives within it at 2 Mbit/s; a file as written in practice
 * takes about a second. Past it the request is ended and the fetch is a retryable timeout.
 */
const STORED_FILE_TIMEOUT_MS = 30 * 1000;

/** The response's declared length, when it declares one as a plain number. */
function declaredLength(response) {
  const header = response.headers?.get?.("content-length");
  return typeof header === "string" && /^\d{1,16}$/.test(header) ? Number(header) : null;
}

/** Ends the request: the connection is closed rather than left to drain. Never throws. */
function endRequest(controller, body) {
  controller.abort();
  if (body && typeof body.cancel === "function") body.cancel().catch(() => {});
}

/** Reads the body chunk by chunk, stopping at the first chunk that passes `limitBytes`. */
async function readCapped(response, limitBytes, controller) {
  const declared = declaredLength(response);
  if (declared !== null && declared > limitBytes) {
    endRequest(controller, response.body);
    throw new StoredFileTooLargeError({ limitBytes, bytesRead: 0 });
  }
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks = [];
  let bytesRead = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytesRead += value.byteLength;
    if (bytesRead > limitBytes) {
      controller.abort();
      reader.cancel().catch(() => {});
      throw new StoredFileTooLargeError({ limitBytes, bytesRead });
    }
    chunks.push(value);
  }
  // One copy at the end: the chunks are never concatenated as they arrive.
  return Buffer.concat(chunks, bytesRead);
}

/**
 * Fetches one stored file within a byte limit and a time limit.
 *
 * @param {(signal: AbortSignal) => Promise<Response>} send makes the request, passing `signal`
 *   to `fetch`, so the time limit and the byte limit can both end it.
 * @param {object} [options]
 * @param {number} [options.maxBytes] the byte limit, `MAX_STORED_FILE_BYTES` when not given.
 * @param {number} [options.timeoutMs] the time limit, `STORED_FILE_TIMEOUT_MS` when not given.
 * @param {(response: Response) => Error} options.refusal the error for a response that is not ok.
 * @returns {Promise<Buffer>} the body.
 * @throws {StoredFileTooLargeError} over the byte limit (bad input).
 * @throws {StoredFileTimeoutError} over the time limit (retryable).
 */
async function fetchStoredFile(
  send,
  { maxBytes = MAX_STORED_FILE_BYTES, timeoutMs = STORED_FILE_TIMEOUT_MS, refusal } = {},
) {
  const limitBytes = Math.min(Math.max(0, Math.floor(maxBytes)), MAX_STORED_FILE_BYTES);
  const limitMs = Math.max(1, Math.floor(timeoutMs));
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, limitMs);

  try {
    const response = await send(controller.signal);
    if (!response.ok) {
      endRequest(controller, response.body);
      throw refusal(response);
    }
    return await readCapped(response, limitBytes, controller);
  } catch (error) {
    if (error instanceof StoredFileTooLargeError) throw error;
    // Whatever the abort surfaced as (an AbortError, a stream error, a refusal racing it), the
    // fetch ran out of time.
    if (timedOut) throw new StoredFileTimeoutError({ timeoutMs: limitMs });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  ANSWER_ALLOWANCE_BYTES,
  LARGEST_WRITTEN_FILE_BYTES,
  MAX_STORED_FILE_BYTES,
  STORED_FILE_TIMEOUT_MS,
  fetchStoredFile,
};
