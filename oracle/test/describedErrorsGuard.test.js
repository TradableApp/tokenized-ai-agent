const { expect } = require("chai");
const fs = require("node:fs");
const path = require("node:path");

/**
 * A provider's or a database's error message can carry the address it was sent to, access key
 * or password included, and a parse error quotes the text it failed on. In the files below, an
 * error caught in a `catch` block or a `.catch(...)` callback is therefore never handed whole to
 * the console, a logger, an alert or a thrown error: only what `describeError`, `describedError`,
 * `errorKind` or `withoutAddresses` make of it. A bare rethrow (`throw error;`) and `cause:` in
 * a thrown error pass on the error to code that branches on it, and are allowed.
 *
 * Read from the source, because these lines sit in catch blocks that a unit test rarely reaches
 * (a store that fails while recording a failed retry), and one forgotten line is enough.
 *
 * It covers only the files in GUARDED: the oracle's main module and the modules that talk to the
 * chain and to the oracle's own database. Other modules under src/ are not read by it.
 */
const SRC = path.join(__dirname, "..", "src");
const GUARDED = [
  "aiAgentOracle.js",
  "eventPoller.js",
  "oracleRoleGate.js",
  "oracleState/runtime.js",
  "oracleState/store.js",
  "oracleState/outageTracker.js",
];

const HELPERS = ["describeError", "describedError", "errorKind", "withoutAddresses"];
const SINK =
  /\b(?:console|log|logger)\.(?:log|info|warn|error|debug|trace)\s*\(|\b(?:sendAlert|alert)\s*\(|\bthrow\b/g;
const CATCH_BLOCK = /\bcatch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\{/g;
const CATCH_CALLBACK = /\.catch\(\s*(?:async\s*)?\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>/g;
// After these, a "/" starts a regular expression rather than dividing.
const BEFORE_REGEX = new Set([..."(,=:[!&|?{};+-*%<>~^"]);

const blank = (char) => (char === "\n" ? "\n" : " ");

/** Skips a regular expression literal starting at `i`, returning its end and blanked text. */
function regexLiteral(src, i) {
  let j = i + 1;
  let inClass = false;
  while (j < src.length && src[j] !== "\n") {
    if (src[j] === "\\") j += 1;
    else if (src[j] === "[") inClass = true;
    else if (src[j] === "]") inClass = false;
    else if (src[j] === "/" && !inClass) break;
    j += 1;
  }
  return { end: j + 1, text: `/${" ".repeat(Math.max(0, j - i - 1))}/` };
}

/** Blanks a quoted string starting at `i`; returns its end and blanked text. */
function quoted(src, i) {
  const quote = src[i];
  let text = quote;
  let j = i + 1;
  while (j < src.length && src[j] !== quote && src[j] !== "\n") {
    text += src[j] === "\\" ? "  " : " ";
    j += src[j] === "\\" ? 2 : 1;
  }
  return { end: j + 1, text: text + (src[j] ?? "") };
}

/** Blanks a comment starting at `i`; returns its end and blanked text. */
function comment(src, i) {
  const end = src[i + 1] === "/" ? src.indexOf("\n", i) : src.indexOf("*/", i + 2) + 2;
  const stop = end < (src[i + 1] === "/" ? 0 : 2) ? src.length : end;
  return { end: stop, text: [...src.slice(i, stop)].map(blank).join("") };
}

/**
 * The source with comments and literal text blanked out, the same length and line breaks, so
 * that only code is left; a template literal's `${...}` expressions are kept as code.
 */
function codeView(src) {
  let out = "";
  let i = 0;
  let depth = 0;
  let last = "";
  const frames = []; // "template", or a number: the brace depth a `${` expression opened at
  const take = ({ end, text }) => {
    out += text;
    i = end;
  };
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (frames.at(-1) === "template") {
      if (c === "`") frames.pop();
      if (c === "$" && next === "{") frames.push(depth++);
      const width = c === "\\" || (c === "$" && next === "{") ? 2 : 1;
      take({ end: i + width, text: c === "`" ? c : blank(c).repeat(width) });
      if (c === "`") last = c;
    } else if (c === "/" && (next === "/" || next === "*")) take(comment(src, i));
    else if (c === '"' || c === "'") {
      take(quoted(src, i));
      last = c;
    } else if (c === "`") {
      frames.push("template");
      take({ end: i + 1, text: c });
    } else if (c === "/" && (last === "" || BEFORE_REGEX.has(last) || /\breturn\s*$/.test(out))) {
      take(regexLiteral(src, i));
      last = "/";
    } else {
      if (c === "{") depth += 1;
      if (c === "}") depth -= 1;
      const closesExpression = c === "}" && frames.at(-1) === depth;
      if (closesExpression) frames.pop();
      take({ end: i + 1, text: closesExpression ? " " : c });
      if (!/\s/.test(c)) last = c;
    }
  }
  return out;
}

/** The index just past the bracket that closes the one at `open`. */
function closeOf(code, open) {
  const pairs = { "(": ")", "{": "}", "[": "]" };
  const want = pairs[code[open]];
  let count = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === code[open]) count += 1;
    else if (code[i] === want && (count -= 1) === 0) return i + 1;
  }
  return code.length;
}

/** Each catch body in `code`, with the name its error is caught under. */
function catchBodies(code) {
  const bodies = [];
  for (const match of code.matchAll(CATCH_BLOCK)) {
    const open = match.index + match[0].length - 1;
    bodies.push({ name: match[1], start: open, end: closeOf(code, open) });
  }
  for (const match of code.matchAll(CATCH_CALLBACK)) {
    const open = match.index + ".catch".length;
    bodies.push({ name: match[1], start: match.index + match[0].length, end: closeOf(code, open) });
  }
  return bodies;
}

/** What a sink at `at` hands on: a call's arguments, or a throw's expression. */
function sinkArguments(code, at, sink, end) {
  if (sink.startsWith("throw")) {
    let i = at + sink.length;
    let level = 0;
    for (; i < end; i += 1) {
      if ("([{".includes(code[i])) level += 1;
      else if (")]}".includes(code[i])) {
        if (level === 0) break;
        level -= 1;
      } else if (code[i] === ";" && level === 0) break;
    }
    return { throws: true, text: code.slice(at + sink.length, i) };
  }
  const open = at + sink.length - 1;
  return { throws: false, text: code.slice(open + 1, closeOf(code, open) - 1) };
}

/** `text` with every description helper's call blanked, so what is left is handed on whole. */
function withoutHelperCalls(text) {
  let result = text;
  const helper = new RegExp(`\\b(?:${HELPERS.join("|")})\\s*\\(`, "g");
  for (const match of [...text.matchAll(helper)].reverse()) {
    const open = match.index + match[0].length - 1;
    const close = closeOf(result, open);
    result = result.slice(0, match.index) + " ".repeat(close - match.index) + result.slice(close);
  }
  return result;
}

/** True when `args` hands on `name` whole. A bare rethrow, and `cause:` in a throw, pass. */
function handsOn(name, { throws, text }) {
  if (throws && text.trim() === name) return false;
  // A caught name is an identifier, but every character a pattern reads specially is escaped.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let rest = withoutHelperCalls(text);
  if (throws) rest = rest.replace(new RegExp(`\\bcause\\s*:\\s*${escaped}(?![\\w$])`, "g"), " ");
  return new RegExp(`(?<![.\\w$])${escaped}(?![\\w$])`).test(rest);
}

/** Every place in `src` where a caught error is handed on whole, as "line: source line". */
function offenders(src) {
  const code = codeView(src);
  const lines = src.split("\n");
  const found = new Set();
  for (const { name, start, end } of catchBodies(code)) {
    const body = code.slice(0, end);
    const sinks = new RegExp(SINK.source, "g");
    sinks.lastIndex = start;
    for (let match = sinks.exec(body); match; match = sinks.exec(body)) {
      const args = sinkArguments(code, match.index, match[0], end);
      if (!handsOn(name, args)) continue;
      const line = code.slice(0, match.index).split("\n").length;
      found.add(`${line}: ${lines[line - 1].trim()}`);
    }
  }
  return [...found];
}

const inCatch = (body, name = "error") => `try {\n  run();\n} catch (${name}) {\n${body}\n}\n`;

// Each form a raw error has been handed on in, and each form that is allowed.
const FIXTURES = [
  [
    "an error on its own line of a call",
    inCatch('console.error(\n  "failed:",\n  error,\n);'),
    true,
  ],
  ["its stack", inCatch("console.error(`failed: ${error.stack}`);"), true],
  ["the error in a template", inCatch("console.warn(`failed: ${error}`);"), true],
  ["String(error)", inCatch('log.error("failed: " + String(error));'), true],
  ["JSON.stringify(error)", inCatch("console.error(JSON.stringify(error));"), true],
  ["util.inspect(error)", inCatch("console.error(util.inspect(error));"), true],
  ["an error between two texts", inCatch('console.error("x", error, "y");'), true],
  ["an object holding it", inCatch('console.error("failed", { error });'), true],
  ["the error alone", inCatch("console.error(error);"), true],
  ["its cause's message", inCatch("console.error(`x ${error.cause.message}`);"), true],
  ["another catch name", inCatch("console.warn('lost', failure);", "failure"), true],
  ["a .catch callback", "p.catch((e) => console.error('send failed', e));", true],
  ["a message in an alert", inCatch("await sendAlert(`down: ${error.message}`);"), true],
  ["a message in a thrown error", inCatch("throw new Error(`x: ${error.message}`);"), true],
  ["describeError", inCatch("console.error(`failed: ${describeError(error)}`);"), false],
  [
    "describedError over lines",
    inCatch('console.error(\n  "x",\n  describedError(error),\n);'),
    false,
  ],
  ["errorKind", inCatch("console.error(`failed (${errorKind(error)})`);"), false],
  ["a bare rethrow", inCatch("throw error;"), false],
  ["the word in text", inCatch('console.error("an error happened", describeError(error));'), false],
  ["a commented-out line", inCatch("// console.error(error);\nconsole.error('x');"), false],
  ["a property of that name", inCatch("console.error(result.error, describeError(error));"), false],
  ["a cause in a thrown error", inCatch("throw new Error('x', { cause: error });"), false],
  ["a described .catch callback", "p.catch((e) => console.error('x', describeError(e)));", false],
  ["a spread of it", inCatch('console.error("failed", { ...error });'), true],
  ["a spread in an alert", inCatch("await sendAlert({ text: 'down', ...error });"), true],
  [
    "a spread in a thrown error",
    inCatch("throw Object.assign(new Error('x'), { ...error });"),
    true,
  ],
  ["a function callback", "p.catch(function (e) {\n  console.error('failed', e);\n});", true],
  [
    "a named async function callback",
    "p.catch(async function onFail(e) {\n  await sendAlert(`down: ${e.message}`);\n});",
    true,
  ],
  ["a point-free console.error", "p.catch(console.error);", true],
  ["a point-free console.warn", "p.catch(console.warn);", true],
  ["a point-free logger call", "p.catch(logger.error);", true],
  ["a point-free bound console.error", "p.catch(console.error.bind(console));", true],
  ["a point-free alert", "p.catch(sendAlert);", true],
  [
    "a described function callback",
    "p.catch(function (e) {\n  console.error('x', describeError(e));\n});",
    false,
  ],
  [
    "a spread of something else",
    inCatch("console.error('x', { ...context }, describeError(error));"),
    false,
  ],
  ["a named handler of its own", "p.catch(handleFailure);", false],
  ["a point-free call in a comment", "// p.catch(console.error);\np.catch(handleFailure);", false],
];

describe("errors are described before they are handed on", () => {
  for (const file of GUARDED) {
    it(`${file} never hands a caught error on whole`, () => {
      const found = offenders(fs.readFileSync(path.join(SRC, file), "utf8"));

      expect(found.map((line) => `${file}:${line}`)).to.deep.equal([]);
    });
  }

  for (const [form, src, flagged] of FIXTURES) {
    it(`${flagged ? "catches" : "allows"} ${form}`, () => {
      expect(offenders(src).length > 0, src).to.equal(flagged);
    });
  }
});

module.exports = { offenders };
