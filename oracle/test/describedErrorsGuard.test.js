const { expect } = require("chai");
const fs = require("node:fs");
const path = require("node:path");

/**
 * A provider's or a database's error message can carry the address it was sent to, access key
 * or password included, and a parse error quotes the text it failed on. In the files below, an
 * error caught in a `catch` block, a `.catch(...)` callback or the second (rejection) argument
 * of `.then(...)`, as an arrow or a `function`, is therefore never handed whole, nor spread
 * (`{ ...error }`), to the console, a logger (any receiver ending in `console`, `log` or
 * `logger`, `this.logger` and `elizaLogger` included; `log`, `info`, `warn`, `error`, `debug`,
 * `trace`, `fatal`, `table`), `process.stderr.write` / `process.stdout.write`, an alert or a
 * thrown error: only what `describeError`, `describedError`, `errorKind` or `withoutAddresses`
 * make of it. Nor is a sink itself the callback (`.catch(console.error)`,
 * `.catch(this.logger.error)`, `.then(ok, console.error)`), which hands it the error whole. A
 * bare rethrow (`throw error;`) and `cause:` in a thrown error pass on the error to code that
 * branches on it, and are allowed.
 *
 * What it does not see: the error copied to another name first (`const e2 = error`); a
 * destructured parameter (`catch ({ message })`, `.catch(({ message }) => …)`); a named handler
 * defined elsewhere (`.catch(handleFailure)`, `.then(task, task)`); a sink not listed above.
 * `Sentry.captureException(error)` is not a sink on purpose: the Sentry scrubber removes
 * addresses from every event it sends.
 *
 * Read from the source, because these lines sit in catch blocks that a unit test rarely reaches
 * (a store that fails while recording a failed retry), and one forgotten line is enough.
 *
 * It reads every source file under src/: each JavaScript file, and the TypeScript source of the
 * ElizaOS plugin (`elizaos/plugins/plugin-senseai/src`), which runs in the same TEE and prints to
 * the same log. Tests (`__tests__`), installed packages (`node_modules`), build output (`dist`)
 * and type declarations (`.d.ts`) are skipped, and so is the plugin's build script, which runs
 * on the machine that builds the image and never in the TEE. A new module is read without being
 * listed.
 */
const SRC = path.join(__dirname, "..", "src");
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "__tests__"]);
const PLUGIN_SOURCE = "elizaos/plugins/plugin-senseai/src/";

/** Every source file under `dir`, relative to it, in a stable order. */
function sourceFiles(dir, prefix = "") {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        files.push(...sourceFiles(path.join(dir, entry.name), relative));
      }
    } else if (
      entry.name.endsWith(".js") ||
      (relative.startsWith(PLUGIN_SOURCE) &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".d.ts"))
    ) {
      files.push(relative);
    }
  }
  return files.sort();
}

const GUARDED = sourceFiles(SRC);

const HELPERS = ["describeError", "describedError", "errorKind", "withoutAddresses"];
const LOG_METHODS = "log|info|warn|error|debug|trace|fatal|table";
const STD_WRITE = "process\\s*\\.\\s*std(?:err|out)\\s*\\.\\s*write";
const SINK = new RegExp(
  `\\b[\\w$]*(?:console|[Ll]og|[Ll]ogger)\\s*\\.\\s*(?:${LOG_METHODS})\\s*(?:\\?\\.\\s*)?\\(|\\b${STD_WRITE}\\s*\\(|\\b(?:sendAlert|alert)\\s*\\(|\\bthrow\\b`,
  "g",
);
const CATCH_BLOCK = /\bcatch\s*\(\s*([A-Za-z_$][\w$]*)(?:\s*:\s*[\w$.<>\[\]|& ]+?)?\s*\)\s*\{/g;
const CATCH_CALLBACK =
  /\.catch\(\s*(?:async\s*)?\(?\s*([A-Za-z_$][\w$]*)(?:\s*:\s*[\w$.<>\[\]|& ]+?)?\s*\)?\s*=>/g;
const CATCH_FUNCTION =
  /\.catch\(\s*(?:async\s+)?function\b\s*[\w$]*\s*\(\s*([A-Za-z_$][\w$]*)(?:\s*:\s*[\w$.<>\[\]|& ]+?)?\s*\)\s*\{/g;
// TypeScript may give the caught name a type (`catch (error: unknown)`, `(e: Error) =>`); the
// name is still what is read.
// A sink given as the callback itself, bound or not: it is called with the error whole. The
// receiver may be any chain of names (`this.logger`, `elizaLogger`).
const SINK_REFERENCE = `(?:(?:[\\w$]+\\s*\\.\\s*)+(?:${LOG_METHODS})|${STD_WRITE}|sendAlert|alert)\\s*(?:\\.\\s*bind\\s*\\([^()]*\\)\\s*)?`;
const POINT_FREE_SINK = new RegExp(`\\.catch\\(\\s*${SINK_REFERENCE}\\)`, "g");
const POINT_FREE_ARGUMENT = new RegExp(`^\\s*${SINK_REFERENCE}$`);
// The same callbacks as above, read from the start of a `.then` rejection argument.
const ARROW_HANDLER =
  /^\s*(?:async\s*)?\(?\s*([A-Za-z_$][\w$]*)(?:\s*:\s*[\w$.<>\[\]|& ]+?)?\s*\)?\s*=>/;
const FUNCTION_HANDLER =
  /^\s*(?:async\s+)?function\b\s*[\w$]*\s*\(\s*([A-Za-z_$][\w$]*)(?:\s*:\s*[\w$.<>\[\]|& ]+?)?\s*\)\s*\{/;
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

/** The start and end of each argument of the call whose parenthesis opens at `open`. */
function callArguments(code, open) {
  const close = closeOf(code, open) - 1;
  const args = [];
  let start = open + 1;
  let level = 0;
  for (let i = open + 1; i < close; i += 1) {
    if ("([{".includes(code[i])) level += 1;
    else if (")]}".includes(code[i])) level -= 1;
    else if (code[i] === "," && level === 0) {
      args.push({ start, end: i });
      start = i + 1;
    }
  }
  args.push({ start, end: close });
  return args;
}

/**
 * The second argument of each `.then(...)` call: a handler, with its body and the name the
 * rejection is given (`bodies`), or a sink passed point-free (`pointFree`, its index).
 */
function thenRejections(code) {
  const bodies = [];
  const pointFree = [];
  for (const match of code.matchAll(/\.then\(/g)) {
    const rejection = callArguments(code, match.index + ".then".length)[1];
    if (!rejection) continue;
    const text = code.slice(rejection.start, rejection.end);
    const handler = text.match(ARROW_HANDLER) ?? text.match(FUNCTION_HANDLER);
    if (handler) {
      bodies.push({
        name: handler[1],
        start: rejection.start + handler[0].length,
        end: rejection.end,
      });
    } else if (POINT_FREE_ARGUMENT.test(text)) pointFree.push(rejection.start);
  }
  return { bodies, pointFree };
}

/** Each catch body in `code`, with the name its error is caught under. */
function catchBodies(code) {
  const bodies = [];
  for (const match of code.matchAll(CATCH_BLOCK)) {
    const open = match.index + match[0].length - 1;
    bodies.push({ name: match[1], start: open, end: closeOf(code, open) });
  }
  for (const pattern of [CATCH_CALLBACK, CATCH_FUNCTION]) {
    for (const match of code.matchAll(pattern)) {
      const open = match.index + ".catch".length;
      const start = match.index + match[0].length;
      bodies.push({ name: match[1], start, end: closeOf(code, open) });
    }
  }
  return [...bodies, ...thenRejections(code).bodies];
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

/**
 * True when `args` hands on `name` whole, or spreads it. A bare rethrow, and `cause:` in a throw,
 * pass. A property of that name (`result.error`) is not the caught error; a spread (`...error`)
 * is, though it too follows a dot.
 */
function handsOn(name, { throws, text }) {
  if (throws && text.trim() === name) return false;
  // A caught name is an identifier, but every character a pattern reads specially is escaped.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let rest = withoutHelperCalls(text);
  if (throws) rest = rest.replace(new RegExp(`\\bcause\\s*:\\s*${escaped}(?![\\w$])`, "g"), " ");
  return new RegExp(`(?:(?<=\\.\\.\\.)|(?<![.\\w$]))${escaped}(?![\\w$])`).test(rest);
}

/** Every place in `src` where a caught error is handed on whole, as "line: source line". */
function offenders(src) {
  const code = codeView(src);
  const lines = src.split("\n");
  const found = new Set();
  const lineOf = (index) => code.slice(0, index).split("\n").length;
  const pointFree = [
    ...[...code.matchAll(POINT_FREE_SINK)].map((match) => match.index),
    ...thenRejections(code).pointFree,
  ];
  for (const index of pointFree) {
    const line = lineOf(index);
    found.add(`${line}: ${lines[line - 1].trim()}`);
  }
  for (const { name, start, end } of catchBodies(code)) {
    const body = code.slice(0, end);
    const sinks = new RegExp(SINK.source, "g");
    sinks.lastIndex = start;
    for (let match = sinks.exec(body); match; match = sinks.exec(body)) {
      const args = sinkArguments(code, match.index, match[0], end);
      if (!handsOn(name, args)) continue;
      const line = lineOf(match.index);
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
  ["a .then rejection arrow", "p.then(ok, (e) => console.error('failed', e));", true],
  [
    "a .then rejection function",
    "p.then(function (v) {\n  use(v);\n}, function (e) {\n  console.error(e);\n});",
    true,
  ],
  ["a point-free .then rejection", "p.then(ok, console.error);", true],
  ["a point-free sink on a longer receiver", "p.catch(this.logger.error);", true],
  ["a point-free framework logger", "p.catch(elizaLogger.error);", true],
  ["a framework logger in a catch block", inCatch('elizaLogger.error("failed", error);'), true],
  ["a logger on this", inCatch('this.logger.warn("failed", error);'), true],
  ["logger.fatal", inCatch("logger.fatal(error);"), true],
  ["console.table", inCatch("console.table(error);"), true],
  ["process.stderr.write", inCatch("process.stderr.write(String(error));"), true],
  [
    "a described .then rejection",
    "p.then(ok, (e) => console.error('x', describeError(e)));",
    false,
  ],
  ["a .then fulfilment logged", "p.then((value) => console.log('got', value));", false],
  ["a .then with named handlers", "p.then(task, task);", false],
  ["a named handler of its own", "p.catch(handleFailure);", false],
  ["a point-free call in a comment", "// p.catch(console.error);\np.catch(handleFailure);", false],
  ["an optional logger call", inCatch("logger.warn?.(`failed: ${error.stack}`);"), true],
  ["a typed catch name", inCatch("logger.error('failed', error);", "error: unknown"), true],
  [
    "a typed catch name described",
    inCatch("logger.error(describeError(error));", "error: unknown"),
    false,
  ],
  ["a typed .catch callback", "p.catch((e: Error) => console.error('failed', e));", true],
  [
    "a typed async .catch callback",
    "p.catch(async (e: unknown) => {\n  logger.warn(`x ${e}`);\n});",
    true,
  ],
  ["a typed .then rejection", "p.then(ok, (e: unknown) => console.error(e));", true],
  ["a typed function callback", "p.catch(function (e: unknown) {\n  console.error(e);\n});", true],
  [
    "a message cast in a thrown error",
    inCatch("throw new Error(`x: ${(error as Error).message}`);", "error: unknown"),
    true,
  ],
  // A cause passes an error on only in a thrown error; in a print it is printed whole.
  ["a cause in a print", inCatch('console.error("x", { cause: error });'), true],
  ["a cause in an alert", inCatch("await sendAlert({ text: 'down', cause: error });"), true],
  // An error that arrives as an ordinary parameter: a crash handler, an error event, a hook.
  [
    "a raw print in an unhandled rejection handler",
    'process.on("unhandledRejection", (reason) => {\n  console.error("[Fatal]", reason);\n});',
    true,
  ],
  [
    "a raw print in an uncaught exception handler",
    'process.on("uncaughtException", function (error) {\n  console.error(error);\n});',
    true,
  ],
  [
    "a described crash handler",
    'process.on("uncaughtException", (error) => {\n  console.error(describedError(error));\n});',
    false,
  ],
  ["a raw print of an error event", "socket.on('error', (err) => console.error(err));", true],
  [
    "a raw alert from a one-off error event",
    "pool.once('error', async (err) => {\n  await sendAlert(`pool: ${err.message}`);\n});",
    true,
  ],
  ["a print of an ordinary event", "stream.on('data', (chunk) => console.log(chunk));", false],
  [
    "a raw print in a retry hook",
    "upload(f, { onRetry: (error) => console.warn(error.message) });",
    true,
  ],
  [
    "a raw alert in a hook with more parameters",
    "track({ onAlert: (error, { failures }) => sendAlert('x', `${failures} ${error.message}`) });",
    true,
  ],
  [
    "a raw print in a hook written as a function",
    "track({ onLost: async function (error) {\n  console.error(error);\n} });",
    true,
  ],
  [
    "a described retry hook",
    "upload(f, { onRetry: (error) => console.warn(describeError(error)) });",
    false,
  ],
  [
    "a hook with no error to print",
    "track({ onRecover: ({ failures }) => console.log(failures) });",
    false,
  ],
  [
    "a settled promise's reason printed whole",
    "for (const r of results) if (r.status === 'rejected') console.error(r.reason);",
    true,
  ],
  [
    "a settled promise's reason described",
    "for (const r of results) console.error(describeError(r.reason));",
    false,
  ],
  // More of the console and of the framework's logger.
  ["console.dir", inCatch("console.dir(error);"), true],
  ["console.assert", inCatch("console.assert(false, error.message);"), true],
  ["console.group", inCatch("console.group(error.message);"), true],
  ["logger.success", inCatch("logger.success(error);"), true],
  ["logger.verbose", inCatch("elizaLogger.verbose(error.message);"), true],
  ["logger.progress", inCatch("logger.progress(`x ${error}`);"), true],
  ["an optional console member", inCatch("console?.error(error);"), true],
  ["a console method by its name in brackets", inCatch('console["error"](error);'), true],
];

describe("errors are described before they are handed on", () => {
  for (const file of GUARDED) {
    it(`${file} never hands a caught error on whole`, () => {
      const found = offenders(fs.readFileSync(path.join(SRC, file), "utf8"));

      expect(found.map((line) => `${file}:${line}`).join("\n")).to.equal("");
    });
  }

  it("reads every source file under src, the plugin's TypeScript included", () => {
    expect(GUARDED).to.include("index.js");
    expect(GUARDED).to.include("storage/autonomys.js");
    expect(GUARDED).to.include("elizaos/plugins/plugin-senseai/src/services/brain.ts");
    expect(GUARDED.some((file) => file.includes("__tests__"))).to.equal(false);
    expect(GUARDED.some((file) => file.endsWith(".d.ts"))).to.equal(false);
    expect(GUARDED).to.not.include("elizaos/plugins/plugin-senseai/build.ts");
  });

  it("fails on a raw print planted in any module it reads", () => {
    const planted =
      "\ntry {\n  run();\n} catch (plantedError) {\n  console.error('failed', plantedError);\n}\n";
    for (const file of GUARDED) {
      const src = fs.readFileSync(path.join(SRC, file), "utf8");
      expect(offenders(src + planted).length, file).to.be.greaterThan(offenders(src).length);
    }
  });

  for (const [form, src, flagged] of FIXTURES) {
    it(`${flagged ? "catches" : "allows"} ${form}`, () => {
      expect(offenders(src).length > 0, src).to.equal(flagged);
    });
  }
});

module.exports = { offenders };
