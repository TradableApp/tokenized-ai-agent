/**
 * Values that must never be printed: the oracle's own keys.
 *
 * Field names cannot protect them. A key that ends up in an error's message, or in an object
 * somebody logs whole, has no name to match. So the keys themselves are registered here when
 * they are obtained, and everything on its way to the console or to Sentry has any registered
 * value replaced. A ROFL machine's logs are kept and its admin can read them, which is why the
 * console is covered and not only the reports.
 */

const util = require("util");

const REPLACEMENT = "[REDACTED]";
// Shorter than half a key and it could match ordinary text and blank it.
const MIN_HEX_LENGTH = 32;
const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"];
const WRAPPED = Symbol("secretValues.wrapped");

/** Lower-case hex, no prefix. */
const registered = new Set();
let pattern = null;

function toHex(value) {
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  if (typeof value === "string") return value.replace(/^0x/i, "").toLowerCase();

  throw new TypeError("A secret value is registered as hex text or as bytes");
}

/**
 * Registers a value so that it is removed from everything printed or reported from now on.
 * @param {string | Uint8Array} value Hex (with or without 0x) or the bytes themselves.
 */
function registerSecretValue(value) {
  const hex = toHex(value);
  if (!/^[0-9a-f]+$/.test(hex) || hex.length < MIN_HEX_LENGTH) {
    throw new RangeError(`A secret value must be at least ${MIN_HEX_LENGTH} hex characters`);
  }
  registered.add(hex);
  pattern = new RegExp([...registered].join("|"), "gi");
}

/**
 * The text with every registered value replaced. Anything that is not a string is returned as
 * it is.
 */
function redactSecrets(text) {
  if (pattern === null || typeof text !== "string") return text;

  return text.replace(pattern, REPLACEMENT);
}

function redactArgument(argument) {
  if (typeof argument === "string") return redactSecrets(argument);
  if (argument === null || (typeof argument !== "object" && typeof argument !== "function")) {
    return argument;
  }
  // An object is printed by the console the way `inspect` shows it. Only when that text holds
  // a registered value is the object replaced by its cleaned text; otherwise it is passed on
  // untouched, so ordinary logging looks as it always did.
  let shown;
  try {
    shown = util.inspect(argument, { depth: 6, breakLength: Infinity });
  } catch {
    return "[UNPRINTABLE]";
  }
  const cleaned = redactSecrets(shown);

  return cleaned === shown ? argument : cleaned;
}

/**
 * Makes a console remove registered values from whatever it is given. Wrapping twice does
 * nothing the second time.
 * @param {Console} target
 */
function wrapConsole(target = console) {
  if (target[WRAPPED]) return target;
  for (const method of CONSOLE_METHODS) {
    const original = target[method];
    if (typeof original !== "function") continue;
    target[method] = (...args) =>
      original.apply(target, pattern === null ? args : args.map(redactArgument));
  }
  Object.defineProperty(target, WRAPPED, { value: true });

  return target;
}

/** Tests only: forget every registered value. */
function forgetSecretValuesForTest() {
  registered.clear();
  pattern = null;
}

module.exports = { registerSecretValue, redactSecrets, wrapConsole, forgetSecretValuesForTest };
