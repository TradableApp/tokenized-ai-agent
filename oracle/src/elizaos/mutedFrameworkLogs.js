"use strict";

/**
 * The lines of the framework's MCP plugin that the oracle does not print.
 *
 * The plugin prints each tool's documentation, the arguments the model chose for a call, the
 * model's reasoning, and the prompt it builds from a tool's output. The documentation is pages
 * long. The rest is written by the model from the user's prompt, or holds what a tool returned,
 * and the oracle's logs are read outside the TEE. The tool server watch prints its own line for
 * each call, with the server, the tool and the outcome only.
 *
 * This covers the plugin's lines only. It is put on the framework's shared logger, which the
 * plugin uses; the agent runtime has a logger of its own that this does not reach.
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
 * @param {"info" | "log" | "warn" | "error"} level
 * @returns {boolean} Whether the line is one the oracle does not print.
 */
function isMutedFrameworkLog(args, level) {
  const line = args.map(written).join(" ");
  if (MUTED_AT_ANY_LEVEL.some((term) => line.includes(term))) return true;

  const isInformation = level === "info" || level === "log";

  return isInformation && MUTED_AT_INFO.some((term) => line.includes(term));
}

module.exports = { isMutedFrameworkLog };
