"use strict";

const { describeError, withoutAddresses, withoutQueryDetail } = require("../errorDescription");

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
 * This covers the plugin's lines only. It is put on the framework's shared logger, which the
 * plugin uses; the agent runtime has a logger of its own that this does not reach, and which is
 * held at warning level instead (frameworkLogLevel.js).
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

const cleanedText = (text) => withoutAddresses(withoutQueryDetail(text));

function cleanedArgument(arg) {
  if (typeof arg === "string") return cleanedText(arg);
  if (arg instanceof Error) return describeError(arg);
  if (arg === null || typeof arg !== "object" || Array.isArray(arg)) return arg;
  // The fields of a structured line, one level down: the plugins put the error's text there.
  return Object.fromEntries(
    Object.entries(arg).map(([key, value]) => [
      key,
      typeof value === "string"
        ? cleanedText(value)
        : value instanceof Error
          ? describeError(value)
          : value,
    ]),
  );
}

/**
 * What the framework's logger was called with, cleaned: the framework and its database plugin
 * print errors themselves, a failed query with its text and its bound values, a peer it could not
 * reach. Text, and the text fields of a structured line, lose a failed query's text and values
 * and every address, configured secret and network peer (`withoutAddresses`); an error object is
 * printed as its description. Other values pass through. A copy; the arguments are not changed.
 *
 * This covers the framework's shared logger only (see the note above); the agent runtime's own
 * logger is not reached, and is held at warning level (frameworkLogLevel.js).
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

module.exports = { isMutedFrameworkLog, cleanedFrameworkArgs, FRAMEWORK_LOG_LEVELS };
