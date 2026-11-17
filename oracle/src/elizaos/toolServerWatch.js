"use strict";

/**
 * A watch over the tool servers the agent uses through the framework's MCP service.
 *
 * The service connects to a server, lists its tools and calls them, and reports none of it in a
 * way the oracle can act on: a server that is down is a warning line, a tool that answers with an
 * error is handed to the model as if it were data, and nothing reaches an alert or the heartbeat.
 * An answer written without market data looks like any other answer, so a fault here is found by
 * a user or not at all.
 *
 * The watch does three things:
 *
 * - at start-up it says what is connected, and alerts when a server or a tool the oracle relies
 *   on is missing. The oracle still starts: only some answers need these tools.
 * - it wraps the service's tool call. A result flagged as an error is thrown, so the framework
 *   treats the call as failed. Every call is counted and printed with its server, tool and
 *   outcome, never with its arguments, which the model writes from the user's prompt.
 * - it gives the heartbeat the servers' state and the call counts, and alerts once when a server
 *   that was connected no longer is.
 */

const { describeError, withoutAddresses } = require("../errorDescription");

// Enough to tell a rate limit from a bad key; an error body can run to pages.
const MAX_ERROR_TEXT = 200;

const CONNECTED = "connected";

/** A tool answered, and its answer was an error. */
class ToolCallFailedError extends Error {
  constructor(message) {
    super(message);
    this.name = "ToolCallFailedError";
  }
}

function shortened(text) {
  const clean = withoutAddresses(String(text)).replace(/\s+/g, " ").trim();

  return clean.length > MAX_ERROR_TEXT ? `${clean.slice(0, MAX_ERROR_TEXT)}…` : clean;
}

function textOf(result) {
  const parts = Array.isArray(result?.content) ? result.content : [];
  const text = parts
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join(" ");

  return text || "no error text";
}

/**
 * @param {object} options
 * @param {Record<string, string[]>} options.expectedTools For each server the oracle relies on,
 *   the tools it must offer.
 * @param {(subject: string, message: string) => Promise<unknown>} options.alert
 * @param {{ log: Function, warn: Function, error: Function }} [options.log]
 */
function createToolServerWatch({ expectedTools, alert, log = console }) {
  const serverNames = Object.keys(expectedTools);
  const calls = { ok: 0, failed: 0 };
  // The servers an alert is out for. One alert per loss: the heartbeat shows the rest.
  const reportedDown = new Set();
  let service = null;
  // Until the start-up report has run, an unconnected server is "not yet", not "lost".
  let hasReported = false;

  function listedServers() {
    if (!service || typeof service.getServers !== "function") return null;
    try {
      const servers = service.getServers();

      return Array.isArray(servers) ? servers : null;
    } catch {
      return null;
    }
  }

  /** What is wrong with one server, as a sentence, or null when it is as expected. */
  function problemWith(name, servers) {
    if (servers === null) return `${name}: the tool service is not running`;
    const server = servers.find((candidate) => candidate?.name === name);
    if (!server) return `${name}: not started`;
    if (server.status !== CONNECTED) return `${name}: ${server.status || "not connected"}`;

    const offered = new Set((server.tools || []).map((tool) => tool?.name));
    const missing = expectedTools[name].filter((tool) => !offered.has(tool));

    return missing.length > 0 ? `${name}: does not offer ${missing.join(", ")}` : null;
  }

  function stateOf(name, servers) {
    if (servers === null) return { status: "unknown", tools: 0 };
    const server = servers.find((candidate) => candidate?.name === name);
    if (!server) return { status: "absent", tools: 0 };

    return {
      status: typeof server.status === "string" ? server.status : "unknown",
      tools: Array.isArray(server.tools) ? server.tools.length : 0,
    };
  }

  async function sendAlert(subject, message) {
    try {
      await alert(subject, message);
    } catch (error) {
      // The alert is how this would be seen; if it cannot be sent, the log is all that is left.
      log.error(
        `[ToolServer] ${message} (and the alert could not be sent: ${describeError(error)})`,
      );
    }
  }

  function recordFailure(serverName, toolName, reason) {
    calls.failed += 1;
    log.warn(`[ToolServer] ${serverName}/${toolName} failed: ${reason}`);
  }

  /**
   * Starts watching a service. Attaching the same service again changes nothing.
   *
   * @param {{ getServers: Function, callTool: Function } | null | undefined} mcpService
   */
  function attach(mcpService) {
    if (!mcpService || typeof mcpService.callTool !== "function") {
      service = null;
      return;
    }
    if (service === mcpService) return;
    service = mcpService;

    const callTool = mcpService.callTool;
    mcpService.callTool = async function watchedCallTool(serverName, toolName, args) {
      let result;
      try {
        result = await callTool.call(mcpService, serverName, toolName, args);
      } catch (error) {
        recordFailure(serverName, toolName, shortened(describeError(error)));
        throw error;
      }

      if (result?.isError) {
        const reason = shortened(textOf(result));
        recordFailure(serverName, toolName, reason);
        throw new ToolCallFailedError(`${serverName}/${toolName} returned an error: ${reason}`);
      }

      calls.ok += 1;
      log.log(`[ToolServer] ${serverName}/${toolName} ok`);

      return result;
    };
  }

  /**
   * Says what is connected, and alerts when something the oracle relies on is missing.
   *
   * @returns {Promise<string[]>} The problems found, one sentence each; empty when there are none.
   */
  async function reportAtStartup() {
    hasReported = true;
    const servers = listedServers();
    const problems = [];

    for (const name of serverNames) {
      const problem = problemWith(name, servers);
      if (problem) {
        problems.push(problem);
        reportedDown.add(name);
      } else {
        log.log(`[ToolServer] ${name} connected, ${stateOf(name, servers).tools} tools`);
      }
    }

    if (problems.length > 0) {
      await sendAlert(
        "CRITICAL: Market-data tool server unavailable",
        `The oracle started without its market-data tools (${problems.join("; ")}). ` +
          "Answers are being written without live market data until this is fixed.",
      );
    }

    return problems;
  }

  /**
   * The servers' state and the call counts, for the heartbeat. Never throws.
   *
   * Also where a loss is noticed: a server that was as expected and no longer is raises one
   * alert, and a line is printed when it is back.
   *
   * @returns {{ servers: Record<string, { status: string, tools: number }>, calls: { ok: number, failed: number } }}
   */
  function observe() {
    const servers = listedServers();
    const state = {};

    for (const name of serverNames) {
      state[name] = stateOf(name, servers);

      if (!hasReported) continue;

      const problem = problemWith(name, servers);
      if (problem && !reportedDown.has(name)) {
        reportedDown.add(name);
        // Not awaited: the heartbeat must not wait on an alert channel.
        void sendAlert(
          "CRITICAL: Market-data tool server lost",
          `A market-data tool server stopped working (${problem}). ` +
            "Answers are being written without live market data until it is back.",
        );
      } else if (!problem && reportedDown.has(name)) {
        reportedDown.delete(name);
        log.log(`[ToolServer] ${name} connected again, ${state[name].tools} tools`);
      }
    }

    return { servers: state, calls: { ...calls } };
  }

  return { attach, reportAtStartup, observe };
}

// The framework's name for its MCP service.
const TOOL_SERVICE = "mcp";

// The service counts as started once it has tried every server, and a server that never answers
// is given up on well inside this.
const SERVICE_START_TIMEOUT_MS = 60 * 1000;

/**
 * The framework's tool service, once it has started, or null.
 *
 * The framework starts an agent's services in the background, so asking for one straight after
 * the agent starts can find nothing yet. This waits for it, and gives up after a while so that a
 * service which never starts is reported and does not hold the oracle's start-up.
 *
 * @param {object | null | undefined} runtime The agent's runtime.
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<object | null>}
 */
async function startedToolService(runtime, { timeoutMs = SERVICE_START_TIMEOUT_MS } = {}) {
  if (typeof runtime?.getServiceLoadPromise !== "function") {
    return runtime?.getService?.(TOOL_SERVICE) ?? null;
  }

  let timer;
  const gaveUp = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    const started = Promise.resolve(runtime.getServiceLoadPromise(TOOL_SERVICE)).catch(() => null);

    return (await Promise.race([started, gaveUp])) ?? null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { createToolServerWatch, startedToolService, ToolCallFailedError };
