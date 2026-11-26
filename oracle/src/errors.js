"use strict";

/**
 * Errors the oracle raises deliberately, so callers can branch on TYPE rather than on message
 * text.
 */

/**
 * The event's own payload is malformed, and no amount of retrying will change that.
 *
 * Load-bearing for safety, not tidiness: `handleAndRecord` uses this type to drop an event
 * PERMANENTLY — no retry, no alert, cursor advanced past it. That is right for a genuinely
 * malformed payload and silent data loss for anything else, so only throw it where the INPUT is
 * provably at fault.
 *
 * The previous test was `error.message.includes("Unexpected token")` and two sibling substrings.
 * JSON.parse throws exactly that whenever a gateway or RPC answers with an HTML error page, so a
 * transient outage was classified as malicious input and the prompt silently discarded.
 */
class BadInputError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "BadInputError";
  }
}

/** Is this error the CALLER's fault, such that retrying can never help? */
function isBadInputError(error) {
  return error instanceof BadInputError;
}

/**
 * A dependency failed in a way that a later attempt may well succeed at: a storage provider's
 * 5xx/429, a dropped connection, a timeout. `handleAndRecord` branches on this TYPE to queue the
 * event for retry instead of declaring it fatal.
 *
 * Why a type: the previous test was a chain of `error.message.includes(...)` substrings. On the
 * 2026-11-09 Base Sepolia run day the Autonomys SDK threw `Failed to upload file chunk: Service
 * Unavailable` — status as words, not a number, and no provider name — so a transient 503 fell
 * through to the fatal branch and a paid prompt was dropped. The layer that KNOWS a failure is
 * transient (the storage wrapper) says so by throwing this; the handler no longer guesses from
 * message text.
 */
class RetryableError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "RetryableError";
  }
}

/** Is this a failure a later attempt may succeed at, so the event belongs in the retry queue? */
function isRetryableError(error) {
  return error instanceof RetryableError;
}

/**
 * A stored file's body passed its byte limit while it was being read, or its declared length
 * was already over it. Reading stopped there and the connection was closed.
 *
 * Bad input, so the event is dropped: every file the oracle writes is well under the limit
 * (`storage/storedFileFetch.js`), so a file over it was not written as part of a conversation,
 * and the content id that names it came from the user's payload or from a file sealed with the
 * user's own key. Retrying would read the same bytes again.
 *
 * `limitBytes` and `bytesRead` are numbers only, for the log line.
 */
class StoredFileTooLargeError extends BadInputError {
  constructor({ limitBytes, bytesRead }) {
    super(
      `Stored file is over its ${limitBytes}-byte limit; reading stopped after ${bytesRead} bytes.`,
    );
    this.name = "StoredFileTooLargeError";
    this.limitBytes = limitBytes;
    this.bytesRead = bytesRead;
  }
}

/**
 * A stored file did not arrive in full within its time limit, and the request was ended.
 *
 * Retryable where it reaches the handler, which is only a conversation's key file: without the
 * key nothing can be answered, and a gateway that is slow now may serve it in a minute. A history
 * walk never lets it reach the handler: it stops at the file and the prompt is answered with the
 * newer messages read so far, as for any other fetch that fails.
 */
class StoredFileTimeoutError extends RetryableError {
  constructor({ timeoutMs }) {
    super(`Stored file did not arrive within ${timeoutMs} ms; the request was ended.`);
    this.name = "StoredFileTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * The codes ethers gives a request that did not get a usable answer.
 *
 * - SERVER_ERROR, TIMEOUT, NETWORK_ERROR: the provider refused it or answered with an error
 *   status, nothing came back in time, or the network could not be reached. SERVER_ERROR covers
 *   every status, a revoked key's 401 included: the event is still valid, and the poll loop's
 *   outage alert is what reports a provider that stays down.
 * - UNKNOWN_ERROR: a JSON-RPC error ethers could not place, which is how a rate limit answered
 *   in the response body arrives.
 * - NONCE_EXPIRED, REPLACEMENT_UNDERPRICED: the provider answered with a stale pending nonce
 *   (one node of a load-balanced endpoint behind the others). The transaction was not accepted.
 */
const TRANSIENT_PROVIDER_CODES = new Set([
  "SERVER_ERROR",
  "TIMEOUT",
  "NETWORK_ERROR",
  "UNKNOWN_ERROR",
  "NONCE_EXPIRED",
  "REPLACEMENT_UNDERPRICED",
]);

/**
 * Did a request to the chain provider fail in a way that says nothing about what was asked?
 *
 * Any read made while an event is being handled can fail like this (the event's block, a
 * contract read, a gas estimate). The event is as valid as it was, so it belongs in the retry
 * queue. By code, which ethers sets, and not by message text.
 */
function isTransientProviderError(error) {
  if (error === null || typeof error !== "object") return false;
  if (TRANSIENT_PROVIDER_CODES.has(error.code)) return true;
  return isRpcErrorThatIsNotARevert(error);
}

/**
 * ethers reports ANY JSON-RPC error answered to eth_call or eth_estimateGas as a call exception
 * with no revert data: a rate limit and "header not found" as much as a revert whose data the
 * provider left out. The provider's own error is kept under `info.error`, and its message is
 * what tells them apart.
 *
 * Only an error whose message is there and does not speak of a revert counts. A revert is the
 * contract's answer; retrying it would pay for the model and storage again to be refused again.
 * When there is nothing to tell which it was, it is not assumed transient.
 */
function isRpcErrorThatIsNotARevert(error) {
  if (error.code !== "CALL_EXCEPTION" || error.data != null || error.receipt) return false;
  const message = error.info?.error?.message;
  return typeof message === "string" && message !== "" && !/revert/i.test(message);
}

/**
 * A file was not uploaded because it is larger than the largest file the oracle writes
 * (`LARGEST_WRITTEN_FILE_BYTES`), which is what every reader of stored files allows for. A file
 * over it would be refused by the next prompt that reads it, so it is never written.
 *
 * Retryable: no such file can be built from the limits the oracle holds, so reaching this is the
 * oracle's own fault; the event is queued and asked again (a model can answer shorter), and a
 * prompt that never fits is refunded by the escrow's timeout.
 */
class StoredFileWriteRefusedError extends RetryableError {
  constructor({ limitBytes, sizeBytes }) {
    super(
      `File of ${sizeBytes} bytes not uploaded: over the ${limitBytes}-byte written-file limit.`,
    );
    this.name = "StoredFileWriteRefusedError";
    this.limitBytes = limitBytes;
    this.sizeBytes = sizeBytes;
  }
}

module.exports = {
  BadInputError,
  isBadInputError,
  RetryableError,
  isRetryableError,
  StoredFileTooLargeError,
  StoredFileTimeoutError,
  StoredFileWriteRefusedError,
  isTransientProviderError,
};
