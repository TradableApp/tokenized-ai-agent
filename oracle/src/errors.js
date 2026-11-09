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

module.exports = { BadInputError, isBadInputError, RetryableError, isRetryableError };
