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

module.exports = {
  BadInputError,
  isBadInputError,
  RetryableError,
  isRetryableError,
  isTransientProviderError,
};
