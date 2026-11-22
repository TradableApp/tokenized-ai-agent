"use strict";

const { withoutNetworkPeers } = require("./networkPeers");
const { withoutRequestSecrets } = require("./requestSecrets");

/**
 * A one-line description of an error that is safe to log, to put in an alert, to store and to
 * report.
 *
 * The error ethers throws for a failed request puts the request's address in its `message`,
 * and a provider's address usually carries the account's access key. So a provider error is
 * described by its code and short message (the HTTP status is part of that). Any other error is
 * described by its message, with its code in front when the message does not already name it,
 * and a model provider's error by its name and status only, since its message can echo the
 * request or the response. Then `describedText` makes one line of it: see there for what is
 * removed and how it is capped.
 *
 * Two things are kept on purpose. A revert's data is the contract's answer, read from the
 * chain, and is what tells one custom error from another; it is added after the text is
 * cleaned, at most selector and two words. A host and path written without a scheme
 * ("rpc.example/v2/...") is not recognised as an address, since every stack frame's file path
 * would look like one; the secret parts of every configured address are removed from it by
 * value all the same (`requestSecrets.js`).
 *
 * @param {unknown} error
 * @returns {string}
 */
function describeError(error) {
  const { text, revert } = partsOf(error);
  return `${describedText(text)}${revert}${causeKind(error)}`;
}

// The longest description, before a revert's data and a cause's kind are added. Enough for a
// code and a short message; nothing past it is read by anyone acting on an alert.
const MAX_DESCRIBED_LENGTH = 300;
// The most of one line that is cleaned. Text past it is dropped before cleaning, back to the
// last space, so that the cut never leaves part of a word (a key, an address) behind.
const MAX_CLEANED_INPUT = 4096;
const VALUE_REMOVED = "[value removed]";
const CUT = "…";

/**
 * Any text as `describeError` writes an error's: the first line that is not blank; a failed
 * query's text and values dropped ("Failed query: <sql> params: <values>" is "Failed query");
 * addresses, configured secrets and network peers removed (`withoutAddresses`); quoted values
 * (a database quotes back the value it refused, a user name, a file path), bearer tokens, JWTs,
 * long base64 runs, wallet addresses and other long hex removed; and only then capped at
 * `MAX_DESCRIBED_LENGTH`, so that a cut can never leave part of a secret where a pattern would
 * have found it whole. A four-byte selector (0x and eight hex digits) names an error and is
 * kept. For text that is not an error's: an exception's message in a report, a framework's line.
 *
 * @param {unknown} text
 * @returns {string}
 */
function describedText(text) {
  const line =
    String(text)
      .split(/\r\n|\r|\n/)
      .find((each) => each.trim()) ?? "";
  const { head, isCut } = bounded(line);
  const cleaned = withoutValues(withoutAddresses(withoutQueryDetail(head))).trim();
  const marked = isCut ? `${cleaned}${CUT}` : cleaned;

  return marked.length > MAX_DESCRIBED_LENGTH
    ? `${marked.slice(0, MAX_DESCRIBED_LENGTH - CUT.length)}${CUT}`
    : marked;
}

/** The first `MAX_CLEANED_INPUT` characters, back to the last space, and whether any were cut. */
function bounded(text) {
  if (text.length <= MAX_CLEANED_INPUT) return { head: text, isCut: false };
  const head = text.slice(0, MAX_CLEANED_INPUT);
  let end = head.length;
  while (end > 0 && !/\s/.test(head[end - 1])) end -= 1;
  return { head: head.slice(0, end), isCut: true };
}

// A failed query's text and the values bound to it, to the end of the text. The fact that a
// query failed is kept, and the database's code comes with the error's cause.
const FAILED_QUERY = /\b(Failed query)\b[\s\S]*$/i;
const QUERY_PARAMETERS = /\s*\bparams:[\s\S]*$/i;

/**
 * `text` without a failed query's text and bound values ("Failed query: <sql>\nparams: <values>"
 * is "Failed query"; anything after "params:" goes). For text this module did not write: a line
 * the framework prints.
 *
 * @param {string} text
 * @returns {string}
 */
function withoutQueryDetail(text) {
  return String(text).replace(FAILED_QUERY, "$1").replace(QUERY_PARAMETERS, "");
}

// A value in double quotes, or in single quotes that do not sit inside a word (so "can't" stays).
const QUOTED = /"[^"\n]*"|(?<!\w)'[^'\n]*'(?!\w)/g;
const BEARER = /\b(Bearer)\s+[^\s,;]+/gi;
const JWT = /\beyJ[\w-]{2,}\.[\w-]{2,}\.[\w-]*/g;
// 0x and nine or more hex digits (a wallet address, a hash, call data), or sixteen or more hex
// digits standing alone.
const LONG_HEX = /0x[0-9a-f]{9,}|(?<![0-9a-z])[0-9a-f]{16,}(?![0-9a-z])/gi;
// A run of 32 or more base64 characters holding a letter and a digit: a key, a token, a blob.
const BASE64_RUN = /(?<![A-Za-z0-9+/_=-])[A-Za-z0-9+/_-]{32,}={0,2}(?![A-Za-z0-9+/_=-])/g;

function withoutValues(text) {
  return text
    .replace(QUOTED, VALUE_REMOVED)
    .replace(BEARER, `$1 ${VALUE_REMOVED}`)
    .replace(JWT, VALUE_REMOVED)
    .replace(LONG_HEX, VALUE_REMOVED)
    .replace(BASE64_RUN, (run) => (/\d/.test(run) && /[A-Za-z]/.test(run) ? VALUE_REMOVED : run));
}

/**
 * The kind of `error.cause`, one level down, as " (cause: KIND)", or nothing when it has none.
 * Node's fetch fails with "fetch failed" and keeps what happened (ECONNREFUSED, a timeout) in the
 * cause. Only the kind: the cause's message can carry the address it was sent to.
 */
function causeKind(error) {
  const cause = readProperty(error, "cause");
  if (cause === undefined || cause === null) return "";
  return ` (cause: ${errorKind(cause)})`;
}

/**
 * `text` with every address in it removed: written with a scheme, configured (by value), or
 * the peer of a failed connection. For text this module did not write: an alert built
 * elsewhere, a field of an error report. Unlike `describedText` it keeps every line, any length
 * and wallet addresses, which an alert names on purpose (the oracle's own, a contract's).
 *
 * @param {string} text
 * @returns {string}
 */
function withoutAddresses(text) {
  const withoutWholeAddresses = String(text).replace(
    ADDRESS,
    (match, lead, address) =>
      `${lead}${PUBLIC_ADDRESSES.has(address) ? address : "[address removed]"}`,
  );

  // A request described in parts ("POST /v2/<key>") has no address to find, only the key.
  // A failed connection names its peer with no scheme in front (networkPeers.js).
  return withoutNetworkPeers(withoutRequestSecrets(withoutWholeAddresses));
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

  // A name is text the thrower chose, and goes out with the stack: kept only when it is one
  // short word, as a kind is. Nothing else of the original comes along: not its address, port,
  // host name or host, which a failed connection carries as fields.
  described.name = plainKind(readProperty(error, "name")) ?? "Error";
  const code = readProperty(error, "code");
  if (typeof code === "string" && plainKind(code) !== null) described.code = code;

  const stack = readProperty(error, "stack");
  const frames =
    typeof stack === "string" ? stack.split("\n").filter((line) => /^\s+at /.test(line)) : [];
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
//
// A match may begin only where a run of the characters a scheme holds begins (the look-behind).
// Without that, every position of a long run without "://" was tried and scanned to the run's
// end: quadratic time, tens of seconds on 200,000 characters. With it, a run is scanned once.
// The scheme still starts at the run's first letter, as before: the characters a scheme cannot
// start with that come before it (`lead`) are matched and put back. The scheme's length is not
// capped: a cap would leave an address glued to a longer run unremoved.
const ADDRESS = /(?<![a-z0-9+.-])([0-9+.-]*)([a-z][a-z0-9+.-]*:(?:\\?\/){2}[^\s"'<>)]+)/gi;

// Addresses an alert shows on purpose: where the operator goes to act on it. Matched whole, so
// anything longer that starts the same way is removed like any other address.
const PUBLIC_ADDRESSES = new Set(["https://ai3.storage/"]);

/**
 * What an error says, before it is cleaned, and its revert detail, added after. A model
 * provider's error (the AI SDK names its errors AI_…, and carries the request and the response)
 * is its name and status only.
 */
function partsOf(error) {
  if (error === null || typeof error !== "object") return { text: String(error), revert: "" };

  const shortMessage = readProperty(error, "shortMessage");
  const message = readProperty(error, "message");
  const code = readProperty(error, "code");
  const kind = plainKind(code);
  if (typeof shortMessage === "string" && shortMessage) {
    const short = typeof code === "string" && code ? `${code}: ${shortMessage}` : shortMessage;
    return { text: short, revert: revertDetail(error) };
  }
  if (isModelProviderError(error)) {
    const status = readProperty(error, "statusCode");
    const name = plainKind(readProperty(error, "name")) ?? "Error";
    return { text: Number.isInteger(status) ? `${name} (status ${status})` : name, revert: "" };
  }
  if (typeof message === "string" && message.trim()) {
    const named = kind !== null && !message.includes(kind) ? `${kind}: ${message}` : message;
    return { text: named, revert: "" };
  }
  if (typeof code === "string" && code) return { text: code, revert: "" };

  return { text: "unknown error", revert: "" };
}

function isModelProviderError(error) {
  const name = readProperty(error, "name");
  if (typeof name === "string" && /^AI_[A-Za-z]+$/.test(name)) return true;
  return ["requestBodyValues", "responseBody"].some((field) => {
    try {
      return field in error;
    } catch {
      return false;
    }
  });
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

module.exports = {
  describeError,
  describedError,
  describedText,
  errorKind,
  withoutAddresses,
  withoutQueryDetail,
  MAX_DESCRIBED_LENGTH,
};
