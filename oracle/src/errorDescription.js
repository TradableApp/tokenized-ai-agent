"use strict";

const { withoutRequestSecrets } = require("./requestSecrets");

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
  return withoutAddresses(textOf(error));
}

/**
 * `text` with every address in it removed. For text this module did not write: an alert built
 * elsewhere, a field of an error report.
 *
 * @param {string} text
 * @returns {string}
 */
function withoutAddresses(text) {
  const withoutWholeAddresses = String(text).replace(ADDRESS, (address) =>
    PUBLIC_ADDRESSES.has(address) ? address : "[address removed]",
  );

  // A request described in parts ("POST /v2/<key>") has no address to find, only the key.
  return withoutRequestSecrets(withoutWholeAddresses);
}

/**
 * An error that says what `error` says and can be thrown, printed or reported whole.
 *
 * `describeError` gives a line of text. Where an Error object is needed (a rethrow that ends in
 * the process's crash handler, a log line that should keep the frames), the original cannot be
 * used: its message, its stack and the request it carries all hold the address. This one has
 * the description as its message, the original's frames, and its code for callers that branch
 * on it. Nothing else of the original comes along.
 *
 * @param {unknown} error
 * @returns {Error}
 */
function describedError(error) {
  const described = new Error(describeError(error));
  if (error === null || typeof error !== "object") return described;

  if (typeof error.name === "string" && error.name) described.name = error.name;
  if (typeof error.code === "string" && error.code) described.code = error.code;

  const frames =
    typeof error.stack === "string"
      ? error.stack.split("\n").filter((line) => /^\s+at /.test(line))
      : [];
  described.stack = withoutAddresses(
    [`${described.name}: ${described.message}`, ...frames].join("\n"),
  );
  return described;
}

/**
 * The kind of `error` and nothing it says: its code, or its name where it has none, when that is
 * text or a number of letters, digits, "_", "." and "-", at most 64 characters; "Error" when
 * neither is, or neither can be read. It never throws. For a log line or an alert about an error
 * whose message may carry an address, as a database error carries the one it was connecting to.
 *
 * @param {unknown} error
 * @returns {string}
 */
function errorKind(error) {
  for (const property of ["code", "name"]) {
    const kind = plainKind(readProperty(error, property));
    if (kind !== null) return kind;
  }
  return "Error";
}

/** `value[property]`, or undefined where reading it throws (a getter that throws). */
function readProperty(value, property) {
  try {
    return value?.[property];
  } catch {
    return undefined;
  }
}

// A code or name as a log line and an alert can carry it: one short word, never an address.
const KIND = /^[A-Za-z0-9_.-]{1,64}$/;

function plainKind(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value);
  return KIND.test(text) ? text : null;
}

// Any scheme (a database address carries a password as an RPC address carries a key), with the
// slashes plain or escaped as JSON escapes them. Greedy on purpose: everything up to the next
// space, quote or closing parenthesis goes, trailing punctuation included. Stopping at a dot or
// a colon would stop inside the host name and leave the path behind, which is where a provider
// puts the access key; stopping at a square bracket would stop inside an IPv6 host.
const ADDRESS = /[a-z][a-z0-9+.-]*:(?:\\?\/){2}[^\s"'<>)]+/gi;

// Addresses an alert shows on purpose: where the operator goes to act on it. Matched whole, so
// anything longer that starts the same way is removed like any other address.
const PUBLIC_ADDRESSES = new Set(["https://ai3.storage/"]);

function textOf(error) {
  if (error === null || typeof error !== "object") return String(error);

  const { shortMessage, message, code } = error;
  if (typeof shortMessage === "string" && shortMessage) {
    const short = typeof code === "string" && code ? `${code}: ${shortMessage}` : shortMessage;
    return `${short}${revertDetail(error)}`;
  }
  if (typeof message === "string" && message) return message;
  if (typeof code === "string" && code) return code;

  return "unknown error";
}

/**
 * What a revert reverted with. The short message of a custom error is only "execution reverted
 * (unknown custom error)"; the decoded error, or failing that the revert data, is what tells
 * one from another.
 */
function revertDetail(error) {
  if (error.code !== "CALL_EXCEPTION") return "";
  const signature = error.revert?.signature;
  if (typeof signature === "string" && signature) return ` (reverted with ${signature})`;
  const { data } = error;
  if (typeof data === "string" && /^0x[0-9a-f]+$/i.test(data)) {
    // Selector plus two words is enough to identify it; the rest is marked as cut.
    return ` (revert data ${data.length > 138 ? `${data.slice(0, 138)}…` : data})`;
  }
  return "";
}

module.exports = { describeError, describedError, errorKind, withoutAddresses };
