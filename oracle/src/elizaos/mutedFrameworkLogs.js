"use strict";

const { describeError, describedText } = require("../errorDescription");

/**
 * The lines of the framework's MCP plugin that the oracle does not print, and how every other
 * line the framework prints is cleaned first (`cleanedFrameworkArgs`).
 *
 * The plugin prints each tool's documentation, the arguments the model chose for a call, the
 * model's reasoning, and the prompt it builds from a tool's output. The documentation is pages
 * long. The rest is written by the model from the user's prompt, or holds what a tool returned,
 * and the oracle's logs are read outside the TEE. The tool server watch prints its own line for
 * each call, with the server, the tool and the outcome only.
 *
 * It is put on the framework's shared logger, which the plugin uses, and on the agent runtime's
 * own logger, which the runtime builds for itself (`cleanRuntimeLogger`). Both are also held at
 * warning level (frameworkLogLevel.js).
 */

// Hidden when printed as information. A warning or an error that names the server is how the
// server's faults are seen, so these terms are not applied there.
const MUTED_AT_INFO = [
  "# Response Schema",
  "$defs:",
  "When using this tool, always use the",
  "This endpoint allows you to query",
  "ref:",
  "jq_filter",
  "coingecko_mcp_local",
  // The model's choice of tool, with the arguments it wrote, after parsing.
  "[SELECTED] Tool Selection result",
  // The model's reasoning for the call.
  "[CALLING] Calling tool",
  // The prompt built from the tool's output and the user's message.
  "reasoning prompt",
];

// Hidden at every level: the model's raw choice of tool and arguments, and, as an error, the
// start of it when it could not be read. The watch counts such runs for the heartbeat.
const MUTED_AT_ANY_LEVEL = ["[WITH-MODEL-RETRY]"];

function written(arg) {
  if (typeof arg !== "object" || arg === null) return String(arg);
  try {
    return JSON.stringify(arg) ?? "";
  } catch {
    // A value that cannot be written out (it refers to itself, or holds a BigInt) is no reason
    // for the framework's log call to throw. Its keys are enough to match on.
    return Object.keys(arg).join(" ");
  }
}

/**
 * @param {unknown[]} args What the framework's logger was called with.
 * @param {string} level One of FRAMEWORK_LOG_LEVELS.
 * @returns {boolean} Whether the line is one the oracle does not print.
 */
function isMutedFrameworkLog(args, level) {
  const line = args.map(written).join(" ");
  if (MUTED_AT_ANY_LEVEL.some((term) => line.includes(term))) return true;

  const isInformation = level === "info" || level === "log";

  return isInformation && MUTED_AT_INFO.some((term) => line.includes(term));
}

// Every level of the framework's logger, so that none prints uncleaned.
const FRAMEWORK_LOG_LEVELS = [
  "info",
  "log",
  "warn",
  "error",
  "fatal",
  "debug",
  "trace",
  "success",
  "progress",
  "verbose",
];

// The fields of a structured line whose text is kept: each names a part of the system (a module,
// a tool server, a tool, a database extension), never what a user or the model wrote.
const NAME_FIELDS = new Set(["src", "serverName", "toolName", "extension"]);
// The fields that carry an error: printed as their description.
const ERROR_FIELDS = new Set(["error", "err", "errorMessage"]);

const described = (value) => (value instanceof Error ? describeError(value) : describedText(value));

/** A field of a structured line, or undefined where it is not printed. */
function cleanedField(key, value) {
  if (ERROR_FIELDS.has(key)) {
    return typeof value === "string" || value instanceof Error ? described(value) : undefined;
  }
  if (typeof value === "string") return NAME_FIELDS.has(key) ? describedText(value) : undefined;
  if (value === null || typeof value !== "object") return value;
  return undefined;
}

/** An element of a list, or undefined where it is not printed. */
function cleanedElement(value) {
  if (typeof value === "string" || value instanceof Error) return described(value);
  if (value === null || typeof value !== "object") return value;
  return undefined;
}

function cleanedArgument(arg) {
  if (typeof arg === "string" || arg instanceof Error) return described(arg);
  if (arg === null || typeof arg !== "object") return arg;
  // The elements of a list and the fields of a structured line, one level down: the framework
  // puts the error's text there, and the model's reply, a message's content and other text.
  if (Array.isArray(arg)) {
    return arg.map(cleanedElement).filter((value) => value !== undefined);
  }
  return Object.fromEntries(
    Object.entries(arg)
      .map(([key, value]) => [key, cleanedField(key, value)])
      .filter(([, value]) => value !== undefined),
  );
}

/**
 * What the framework's logger was called with, cleaned: the framework and its plugins print
 * errors themselves (a failed query with its text and its bound values, a peer it could not
 * reach), and the agent runtime warns with the start of the model's reply when it cannot read
 * it. Text is printed as `describedText` writes it (its first line, without a failed query's
 * text and values, addresses, configured secrets, peers and quoted values), an error object as
 * its description. In a structured line only counts, flags, the fields that name a part of the
 * system and an error's description are kept; every other text field, and anything nested, is
 * dropped. A list keeps its numbers and flags and its text and errors as above. Other values
 * pass through. A copy; the arguments are not changed.
 *
 * @param {unknown[]} args
 * @returns {unknown[]}
 */
function cleanedFrameworkArgs(args) {
  try {
    return args.map(cleanedArgument);
  } catch {
    // A field whose getter throws is no reason for the framework's log call to throw.
    return ["[framework line not printed: it could not be read]"];
  }
}

/**
 * One level of a logger: the line is dropped when it is muted, and otherwise handed to `print`
 * cleaned.
 *
 * @param {(...args: unknown[]) => unknown} print
 * @param {string} level
 */
function cleanedLogCall(print, level) {
  return (...args) => {
    if (!isMutedFrameworkLog(args, level)) print(...cleanedFrameworkArgs(args));
  };
}

const CLEANED = Symbol("cleanedLogger");

/**
 * A logger that prints through `original`, each line cleaned as the shared logger's are. A logger
 * made from it with `child` is cleaned too. Returns `original` when it is already one.
 *
 * @param {Record<string, unknown>} original
 */
function cleanedLogger(original) {
  if (original?.[CLEANED]) return original;
  const logger = {
    [CLEANED]: true,
    level: original.level,
    clear: () => original.clear?.(),
    child: (bindings) => cleanedLogger(original.child(bindings)),
  };
  for (const level of FRAMEWORK_LOG_LEVELS) {
    if (typeof original[level] === "function") {
      logger[level] = cleanedLogCall(original[level].bind(original), level);
    }
  }
  return logger;
}

/**
 * Replaces the agent runtime's own logger with a cleaned one. The runtime builds it in its
 * constructor (`this.logger = createLogger(...)`, @elizaos/core 1.7.2) as a plain property, and
 * its services and plugins read `runtime.logger` at each call, so this must run after the runtime
 * is built and before it is started. Throws when the logger cannot be replaced, so the oracle
 * never starts an agent whose lines are printed uncleaned.
 *
 * @param {{ logger: Record<string, unknown> } | undefined} runtime
 */
function cleanRuntimeLogger(runtime) {
  if (!runtime || typeof runtime.logger !== "object" || runtime.logger === null) {
    throw new Error("the agent runtime has no logger the oracle can clean");
  }
  const logger = cleanedLogger(runtime.logger);
  try {
    runtime.logger = logger;
  } catch {
    // A frozen runtime throws in strict mode; checked below either way.
  }
  if (runtime.logger !== logger) {
    throw new Error("the agent runtime's logger could not be replaced with a cleaned one");
  }
  return runtime;
}

module.exports = {
  isMutedFrameworkLog,
  cleanedFrameworkArgs,
  cleanedLogCall,
  cleanedLogger,
  cleanRuntimeLogger,
  FRAMEWORK_LOG_LEVELS,
};
