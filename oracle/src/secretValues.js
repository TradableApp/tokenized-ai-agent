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

function escapeForPattern(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every way the bytes of one value get written down: as hex (run together, or spaced as a
 * Buffer prints), as a list of numbers (as a Uint8Array prints, whatever the padding), and in
 * base64 of either alphabet.
 */
function formsOf(hex) {
  const pairs = hex.match(/../g);
  const bytes = Buffer.from(hex, "hex");
  const base64 = bytes.toString("base64").replace(/=+$/, "");

  return [
    pairs.join("\\s*"),
    pairs.map((pair) => parseInt(pair, 16)).join("\\s*,\\s*"),
    `${escapeForPattern(base64)}=*`,
    `${escapeForPattern(bytes.toString("base64url"))}=*`,
  ];
}

/**
 * Registers a value so that it is removed from everything printed or reported from now on.
 * @param {string | Uint8Array} value Hex (with or without 0x) or the bytes themselves.
 */
function registerSecretValue(value) {
  const hex = toHex(value);
  if (!/^(?:[0-9a-f]{2})+$/.test(hex) || hex.length < MIN_HEX_LENGTH) {
    throw new RangeError(`A secret value must be at least ${MIN_HEX_LENGTH} hex characters`);
  }
  registered.add(hex);
  pattern = new RegExp([...registered].flatMap(formsOf).join("|"), "gi");
}

/**
 * The text with every registered value replaced, in any of the forms it can be written in.
 * Anything that is not a string is returned as it is.
 */
function redactSecrets(text) {
  if (pattern === null || typeof text !== "string") return text;

  return text.replace(pattern, REPLACEMENT);
}

/** Whether these bytes are a registered value. For reports that carry bytes as bytes. */
function isSecretBytes(view) {
  if (registered.size === 0 || !ArrayBuffer.isView(view)) return false;

  return registered.has(Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString("hex"));
}

const SHOWN = { depth: 6, breakLength: Infinity };

/**
 * What a console call would print, cleaned. The arguments are put together first, as the
 * console itself would, because a value can be assembled by the format string or sit inside an
 * object. Only when that text holds a registered value is it printed in place of the
 * arguments; otherwise they are passed on untouched, so ordinary logging looks as it did.
 */
function cleanedArguments(args) {
  let shown;
  try {
    shown = util.formatWithOptions(SHOWN, ...args);
  } catch {
    return ["[UNPRINTABLE]"];
  }
  const cleaned = redactSecrets(shown);

  return cleaned === shown ? args : [cleaned];
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
      original.apply(target, pattern === null ? args : cleanedArguments(args));
  }
  // `dir` shows one object with its own options, and does not go through the methods above.
  const originalDir = target.dir;
  if (typeof originalDir === "function") {
    target.dir = (object, options) => {
      if (pattern === null) return originalDir.call(target, object, options);
      const [cleaned] = cleanedArguments([object]);

      return cleaned === object
        ? originalDir.call(target, object, options)
        : originalDir.call(target, cleaned, options);
    };
  }
  Object.defineProperty(target, WRAPPED, { value: true });

  return target;
}

/** Tests only: forget every registered value. */
function forgetSecretValuesForTest() {
  registered.clear();
  pattern = null;
}

module.exports = {
  registerSecretValue,
  redactSecrets,
  isSecretBytes,
  wrapConsole,
  forgetSecretValuesForTest,
};
