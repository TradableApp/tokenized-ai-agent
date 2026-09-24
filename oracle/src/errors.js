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

module.exports = { BadInputError, isBadInputError };
