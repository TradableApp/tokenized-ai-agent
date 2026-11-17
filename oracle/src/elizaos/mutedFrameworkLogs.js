"use strict";

/**
 * The framework's log lines the oracle does not print.
 *
 * The MCP plugin prints, at info level, each tool's documentation and the arguments the model
 * chose for a call. The documentation is pages long. The arguments are written by the model from
 * the user's prompt, and the oracle's logs are read outside the TEE. The tool server watch prints
 * its own line for each call, with the server, the tool and the outcome only.
 */
const MUTED_LOGS = [
  "# Response Schema",
  "$defs:",
  "When using this tool, always use the",
  "This endpoint allows you to query",
  "ref:",
  "jq_filter",
  "coingecko_mcp_local",
  // The model's choice of tool, with the arguments it wrote.
  "[SELECTED] Tool Selection result",
];

/**
 * @param {unknown[]} args What the framework's logger was called with.
 * @returns {boolean} Whether the line is one the oracle does not print.
 */
function isMutedFrameworkLog(args) {
  const line = args
    .map((arg) => (typeof arg === "object" ? JSON.stringify(arg) : String(arg)))
    .join(" ");

  return MUTED_LOGS.some((term) => line.includes(term));
}

module.exports = { isMutedFrameworkLog };
