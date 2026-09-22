"use strict";

/**
 * Errors the oracle raises deliberately, so callers can branch on TYPE rather than on message
 * text.
 */

/**
 * The event's own payload is malformed, and no amount of retrying will change that.
 *
 * This type is load-bearing for safety, not tidiness. `handleAndRecord` uses it to decide that an
 * event should be DROPPED PERMANENTLY — no retry, no alert, cursor advanced past it. That is the
 * right response to a genuinely malformed payload and a data-loss bug for anything else.
 *
 * The previous test was `error.message.includes("Unexpected token")` and two sibling substrings.
 * JSON.parse throws exactly that whenever a gateway or RPC answers with an HTML error page, so a
 * transient outage was classified as malicious input and the prompt silently discarded. Only
 * throw this where the INPUT is provably at fault; let everything else surface.
 */
class BadInputError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "BadInputError";
  }
}

/**
 * Is this error the CALLER's fault, such that retrying can never help?
 *
 * A true answer makes `handleAndRecord` drop the event permanently: no retry, no alert, cursor
 * advanced past it. A false positive is therefore silent data loss, so the bar is deliberately
 * high — only errors we ourselves raised as BadInputError qualify.
 *
 * Lives beside the type rather than in aiAgentOracle because it is a pure statement ABOUT the
 * type, and because a predicate this consequential should be testable without standing up the
 * whole oracle module.
 */
function isBadInputError(error) {
  return error instanceof BadInputError;
}

module.exports = { BadInputError, isBadInputError };
