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
 * The watch:
 *
 * - follows the service from the moment the agent starts, however long the service takes, and
 *   says what it connected to. It alerts when a server or a tool the oracle relies on is missing.
 *   The oracle still starts: only some answers need these tools.
 * - wraps the service's tool call. A result flagged as an error because the server could not do
 *   its job is thrown, so the framework treats the call as failed. Every call is counted and
 *   printed with its server, tool and outcome.
 * - alerts when calls keep failing while the server looks connected (a key that stopped working,
 *   a provider outage), and when a server that was fine no longer is.
 * - gives the heartbeat the servers' state and the counts.
 *
 * NOTHING A TOOL OR THE MODEL WROTE IS PRINTED, THROWN OR ALERTED. A call's arguments are written
 * by the model from the user's prompt, and a tool's error text can repeat them. What is printed is
 * the server's and tool's names, which come from a fixed list, and an outcome this module words.
 */

const { describeError } = require("../errorDescription");

const CONNECTED = "connected";

// The framework's name for its MCP service.
const TOOL_SERVICE = "mcp";

// The service counts as started only once it has tried every server, and it gives a server a
// minute to connect and as long again to list its tools. Past this it is reported as late; the
// watch keeps waiting for it all the same.
const SERVICE_LATE_AFTER_MS = 3 * 60 * 1000;

// A server that looks wrong is looked at again after this before anyone is alerted: the
// framework drops and re-makes a connection in a couple of seconds, and that is not a loss.
const CONFIRM_LOSS_AFTER_MS = 30 * 1000;

// This many failed calls in a row, with none answered between, is not a bad moment.
const FAILURE_STREAK_TO_ALERT = 5;

// Statuses that say the request was wrong, not the server. The model is given these results, as
// it always was, and can tell the user the coin was not found.
const REQUEST_WAS_WRONG = new Set([400, 404, 422]);

/** A tool call failed. The message is worded here and carries nothing the tool or model wrote. */
class ToolCallFailedError extends Error {
  constructor(message) {
    super(message);
    this.name = "ToolCallFailedError";
  }
}

/** The HTTP status a tool's error text begins with, or null. Nothing else of the text is used. */
function statusOf(result) {
  const first = Array.isArray(result?.content) ? result.content[0] : null;
  const match = typeof first?.text === "string" ? /^\s*(\d{3})\b/.exec(first.text) : null;

  return match ? Number(match[1]) : null;
}

/**
 * @param {object} options
 * @param {Record<string, string[]>} options.expectedTools For each server the oracle relies on,
 *   the tools it must offer.
 * @param {(subject: string, message: string) => Promise<unknown>} options.alert
 * @param {{ log: Function, warn: Function, error: Function }} [options.log]
 * @param {{ lateAfterMs?: number, confirmLossAfterMs?: number }} [options.timing]
 */
function createToolServerWatch({ expectedTools, alert, log = console, timing = {} }) {
  const lateAfterMs = timing.lateAfterMs ?? SERVICE_LATE_AFTER_MS;
  const confirmLossAfterMs = timing.confirmLossAfterMs ?? CONFIRM_LOSS_AFTER_MS;
  const serverNames = Object.keys(expectedTools);
  const calls = { ok: 0, failed: 0, refused: 0 };
  // Runs thrown away because a tool step failed and nothing answered without it.
  let rejectedRuns = 0;
  let failuresInARow = 0;
  let isStreakAlerted = false;
  // The servers an alert is out for. One alert per loss: the heartbeat shows the rest.
  const reportedDown = new Set();
  // The servers being looked at again before an alert.
  const confirming = new Set();
  const wrapped = new WeakSet();
  let service = null;
  // Until the start-up report has run, an unconnected server is "not yet", not "lost".
  let hasReported = false;

  function listedServers() {
    if (!service || typeof service.getServers !== "function") return null;
    try {
      const servers = service.getServers();

      return Array.isArray(servers) ? servers : null;
    } catch {
      // Not the same as "no servers": the caller reports null as the service not answering.
      return null;
    }
  }

  /** The tools the agent was shown for a server when the service started, or null if unknown. */
  function toolsShownToAgent(name) {
    try {
      const shown = service?.getProviderData?.()?.data?.mcp?.[name]?.tools;

      return shown && typeof shown === "object" ? new Set(Object.keys(shown)) : null;
    } catch {
      // Unknown, and treated as unknown: no restart is asked for on a guess.
      return null;
    }
  }

  /** What is wrong with one server, as a sentence this module words, or null. */
  function problemWith(name, servers) {
    if (servers === null) return `${name}: the tool service is not answering`;
    const server = servers.find((candidate) => candidate?.name === name);
    if (!server) return `${name}: not started`;
    if (server.status !== CONNECTED) {
      // The framework leaves a server that failed to connect at "connecting".
      return `${name}: not connected (status: ${String(server.status)})`;
    }

    const offered = new Set((server.tools || []).map((tool) => tool?.name));
    const missing = expectedTools[name].filter((tool) => !offered.has(tool));
    if (missing.length > 0) return `${name}: does not offer ${missing.join(", ")}`;

    // The framework tells the agent which tools exist once, when its service starts. A server
    // that connected only later is connected, and the agent still cannot use it.
    const shown = toolsShownToAgent(name);
    const unseen = shown ? expectedTools[name].filter((tool) => !shown.has(tool)) : [];

    return unseen.length > 0
      ? `${name}: connected, but the agent was started without its tools; restart the oracle`
      : null;
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

  function confirmLoss(name) {
    confirming.delete(name);
    const problem = problemWith(name, listedServers());
    if (!problem || reportedDown.has(name)) return;

    reportedDown.add(name);
    void sendAlert(
      "CRITICAL: Market-data tool server lost",
      `A market-data tool server stopped working (${problem}). ` +
        "Answers are being written without live market data until it is back.",
    );
  }

  /**
   * Looks at every server, and deals with what changed since the last look.
   *
   * A server that was fine and now is not is looked at once more, a little later, before an
   * alert. A server an alert is out for that is fine again is said to be back, at warning level
   * so that it is seen where the alert was.
   */
  function check() {
    if (!hasReported) return;
    const servers = listedServers();

    for (const name of serverNames) {
      const problem = problemWith(name, servers);

      if (!problem && reportedDown.delete(name)) {
        log.warn(`[ToolServer] ${name} connected again, ${stateOf(name, servers).tools} tools`);
      } else if (problem && !reportedDown.has(name) && !confirming.has(name)) {
        confirming.add(name);
        const timer = setTimeout(() => confirmLoss(name), confirmLossAfterMs);
        // A pending second look must not keep the process alive.
        timer.unref?.();
      }
    }
  }

  function countFailure(serverName, toolName, outcome) {
    calls.failed += 1;
    failuresInARow += 1;
    log.warn(`[ToolServer] ${serverName}/${toolName} failed: ${outcome}`);

    if (failuresInARow >= FAILURE_STREAK_TO_ALERT && !isStreakAlerted) {
      isStreakAlerted = true;
      void sendAlert(
        "CRITICAL: Market-data tool calls are failing",
        `The last ${failuresInARow} market-data tool calls failed (latest: ` +
          `${serverName}/${toolName}, ${outcome}). If the server is connected, look at its API ` +
          "key and at the provider. Answers are being written without live market data.",
      );
    }
    // A failed call is the first sign of a lost server; the next heartbeat can be far off.
    check();
  }

  /** The server answered, with data or with a refusal: it is reachable and its key is taken. */
  function endFailureStreak(serverName, toolName) {
    if (isStreakAlerted) {
      log.warn(`[ToolServer] ${serverName}/${toolName} answered: calls are working again`);
    }
    failuresInARow = 0;
    isStreakAlerted = false;
  }

  /**
   * Starts watching a service. Handing it nothing, or a service already watched, changes nothing.
   *
   * @param {{ getServers: Function, callTool: Function } | null | undefined} mcpService
   */
  function attach(mcpService) {
    if (!mcpService || typeof mcpService.callTool !== "function") return;
    service = mcpService;
    if (wrapped.has(mcpService)) return;

    const callTool = mcpService.callTool;
    const watchedCallTool = async function watchedCallTool(serverName, toolName, args) {
      let result;
      try {
        result = await callTool.call(mcpService, serverName, toolName, args);
      } catch {
        // The error is not passed on: its text is the framework's or the server's, and the
        // framework prints whatever it is given.
        countFailure(serverName, toolName, "no answer");
        throw new ToolCallFailedError(`${serverName}/${toolName} failed: no answer`);
      }

      if (!result?.isError) {
        calls.ok += 1;
        endFailureStreak(serverName, toolName);
        log.log(`[ToolServer] ${serverName}/${toolName} ok`);

        return result;
      }

      const status = statusOf(result);
      if (REQUEST_WAS_WRONG.has(status)) {
        calls.refused += 1;
        endFailureStreak(serverName, toolName);
        log.log(`[ToolServer] ${serverName}/${toolName} refused the request: status ${status}`);

        return result;
      }

      const outcome = status === null ? "tool error" : `status ${status}`;
      countFailure(serverName, toolName, outcome);
      throw new ToolCallFailedError(`${serverName}/${toolName} failed: ${outcome}`);
    };

    try {
      mcpService.callTool = watchedCallTool;
      wrapped.add(mcpService);
    } catch (error) {
      // Not a reason to stop the oracle. Said loudly, because without the wrap a tool's error
      // reaches the model as data and nothing is counted.
      log.error(`[ToolServer] could not watch tool calls: ${describeError(error)}`);
    }
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
      const problem = service
        ? problemWith(name, servers)
        : `${name}: the tool service did not start`;
      if (problem) {
        problems.push(problem);
        reportedDown.add(name);
      } else {
        reportedDown.delete(name);
        log.log(`[ToolServer] ${name} connected, ${stateOf(name, servers).tools} tools`);
      }
    }

    if (problems.length > 0) {
      await sendAlert(
        "CRITICAL: Market-data tool server unavailable",
        `The oracle is running without its market-data tools (${problems.join("; ")}). ` +
          "Answers are being written without live market data until this is fixed.",
      );
    }

    return problems;
  }

  /**
   * Follows the agent's tool service from start-up: attaches to it when it has started, however
   * long that takes, and reports. Nothing here holds the oracle's start-up; the caller does not
   * wait for the promise.
   *
   * The framework starts an agent's services in the background, and its tool service counts as
   * started only after it has tried every server. So the wait can be long. A service that is
   * late is reported as missing, and is attached to and reported again when it arrives.
   *
   * @param {object | null | undefined} runtime The agent's runtime.
   * @returns {Promise<void>} Settles when the service has started or failed to. Never rejects.
   */
  function follow(runtime) {
    if (typeof runtime?.getServiceLoadPromise !== "function") {
      attach(runtime?.getService?.(TOOL_SERVICE));

      return reportAtStartup().then(() => undefined);
    }

    let isLate = false;
    const lateTimer = setTimeout(() => {
      isLate = true;
      void reportAtStartup();
    }, lateAfterMs);
    lateTimer.unref?.();

    return Promise.resolve()
      .then(() => runtime.getServiceLoadPromise(TOOL_SERVICE))
      .then(
        (started) => {
          attach(started);
          if (isLate) log.warn("[ToolServer] the tool service started late; watching it now");
        },
        (error) => {
          log.error(`[ToolServer] the tool service failed to start: ${describeError(error)}`);
        },
      )
      .then(() => {
        clearTimeout(lateTimer);

        return reportAtStartup();
      })
      .then(() => undefined);
  }

  /** Counts a run thrown away because a tool step failed and nothing answered without it. */
  function countRejectedRun() {
    rejectedRuns += 1;
  }

  /**
   * The servers' state and the counts, for the heartbeat. Never throws.
   *
   * @returns {{
   *   servers: Record<string, { status: string, tools: number }>,
   *   calls: { ok: number, failed: number, refused: number },
   *   rejectedRuns: number,
   * }}
   */
  function observe() {
    const servers = listedServers();
    const state = {};
    for (const name of serverNames) state[name] = stateOf(name, servers);
    check();

    return { servers: state, calls: { ...calls }, rejectedRuns };
  }

  return { attach, follow, reportAtStartup, observe, countRejectedRun };
}

module.exports = { createToolServerWatch, ToolCallFailedError };
