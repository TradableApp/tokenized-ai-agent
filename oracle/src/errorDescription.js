"use strict";

/**
 * A one-line description of an error that is safe to log and to put in an alert.
 *
 * The error ethers throws for a failed request puts the request's address in its `message`,
 * and a provider's address usually carries the account's access key. So a provider error is
 * described by its code and short message (the HTTP status is part of that), and any address
 * left in any other message is removed.
 *
 * @param {unknown} error
 * @returns {string}
 */
function describeError(error) {
  return textOf(error).replace(ADDRESS, "[address removed]");
}

const ADDRESS = /\b(?:https?|wss?):\/\/[^\s"'<>)\]]+/gi;

function textOf(error) {
  if (error === null || typeof error !== "object") return String(error);

  const { shortMessage, message, code } = error;
  if (typeof shortMessage === "string" && shortMessage) {
    return typeof code === "string" && code ? `${code}: ${shortMessage}` : shortMessage;
  }
  if (typeof message === "string" && message) return message;
  if (typeof code === "string" && code) return code;

  return "unknown error";
}

module.exports = { describeError };
