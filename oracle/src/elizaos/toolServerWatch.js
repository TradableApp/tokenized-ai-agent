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
 * - wraps the service's tool call. A call the server could not do is thrown, so the framework
 *   treats it as failed. Every call is counted and printed with its server, tool and outcome.
 * - alerts when calls keep failing or keep being refused while the server looks connected (a key
 *   that stopped working, a provider outage), and when a server that was fine no longer is.
 * - looks at the servers every minute, after every failed call, and for the heartbeat, which it
 *   gives the servers' state and the counts.
 *
 * NOTHING A TOOL OR THE MODEL WROTE IS PRINTED, THROWN OR ALERTED. A call's arguments are written
 * by the model from the user's prompt, and a tool's error text can repeat them. What is printed is
 * a server's name from the oracle's own list, a tool's name when the server offers a tool of that
 * name, and an outcome this module words.
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

// How often the watch looks at the servers by itself. With a server down the framework stops
// offering its tools, so no call fails, and the heartbeat can be off or far away.
const CHECK_EVERY_MS = 60 * 1000;

// No more than one alert about calls in this long. A provider that fails, answers once and fails
// again would otherwise alert every few calls.
const ALERT_EVERY_MS = 10 * 60 * 1000;

// This many failed calls in a row, or this many among the last few, is not a bad moment. The
// second rule is for a rate limit that lets some calls through.
const FAILURE_STREAK_TO_ALERT = 5;
const RECENT_CALLS = 20;
const RECENT_FAILURES_TO_ALERT = 10;

// One refusal is the model's mistake. This many in a row, with no call answered between, is a
// key of the wrong kind or an endpoint that has gone.
const REFUSAL_STREAK_TO_ALERT = 10;

// Statuses that say the request was wrong, not the server. The model is given these results, as
// it always was, and can tell the user the coin was not found.
const REQUEST_WAS_WRONG = new Set([400, 404, 422]);

// How the tool server words not reaching its provider. These carry no status.
const NO_CONNECTION = new Set(["Connection error.", "Request timed out.", "Request was aborted."]);

// The codes of what the framework's client throws. A thrown call is told apart by these alone.
const THROWN = new Map([
  [-32001, { outcome: "timed out", isRefusal: false }],
  [-32000, { outcome: "connection closed", isRefusal: false }],
  [-32602, { outcome: "invalid request", isRefusal: true }],
]);
const NO_ANSWER = { outcome: "no answer", isRefusal: false };

// Why a run was thrown away. Only the first says the tools are at fault.
const REJECTED_RUN_KINDS = ["toolError", "noTool", "unreadable"];

/** A tool call failed. The message is worded here and carries nothing the tool or model wrote. */
class ToolCallFailedError extends Error {
  constructor(message) {
    super(message);
    this.name = "ToolCallFailedError";
  }
}

function firstText(result) {
  const first = Array.isArray(result?.content) ? result.content[0] : null;

  return typeof first?.text === "string" ? first.text : "";
}

/**
 * What a result flagged as an error says about the call. The text is read for a leading HTTP
 * status and compared with a few fixed sentences; none of it is kept.
 *
 * @returns {{ kind: "refused" | "failed" | "unclear", outcome: string }}
 */
function readErrorResult(result) {
  const text = firstText(result);
  const match = /^\s*(\d{3})\b/.exec(text);

  if (match) {
    const status = Number(match[1]);

    return {
      kind: REQUEST_WAS_WRONG.has(status) ? "refused" : "failed",
      outcome: `status ${status}`,
    };
  }
  if (NO_CONNECTION.has(text.trim())) return { kind: "failed", outcome: "no connection" };

  // No status and not a connection fault: most often a filter of the model's own that the server
  // could not run. Nothing says the server is at fault.
  return { kind: "unclear", outcome: "an error with no status" };
}

/**
 * @param {object} options
 * @param {Record<string, string[]>} options.expectedTools For each server the oracle relies on,
 *   the tools it must offer.
 * @param {(subject: string, message: string) => Promise<unknown>} options.alert
 * @param {{ log: Function, warn: Function, error: Function }} [options.log]
 * @param {{ lateAfterMs?: number, confirmLossAfterMs?: number, checkEveryMs?: number,
 *   alertEveryMs?: number }} [options.timing]
 */
function createToolServerWatch({ expectedTools, alert, log = console, timing = {} }) {
  const lateAfterMs = timing.lateAfterMs ?? SERVICE_LATE_AFTER_MS;
  const confirmLossAfterMs = timing.confirmLossAfterMs ?? CONFIRM_LOSS_AFTER_MS;
  const checkEveryMs = timing.checkEveryMs ?? CHECK_EVERY_MS;
  const alertEveryMs = timing.alertEveryMs ?? ALERT_EVERY_MS;
  const serverNames = Object.keys(expectedTools);

  const calls = { ok: 0, failed: 0, refused: 0, unclear: 0 };
  const rejectedRuns = Object.fromEntries(REJECTED_RUN_KINDS.map((kind) => [kind, 0]));
  let failuresInARow = 0;
  let refusalsInARow = 0;
  // Whether each of the last few calls failed, oldest first.
  const recentCalls = [];
  let isSaidToBeFailing = false;
  let lastCallAlertAt = -Infinity;

  // For each server an alert is out for, what the alert said was wrong. One alert per problem:
  // the heartbeat shows the rest.
  const reportedDown = new Map();
  // The servers being looked at again before an alert.
  const confirming = new Set();
  const wrapped = new WeakSet();
  let service = null;
  // Until the start-up report has run, an unconnected server is "not yet", not "lost".
  let hasReported = false;
  let checkTimer = null;

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

  function offeredBy(server) {
    return Array.isArray(server?.tools) ? server.tools.map((tool) => tool?.name) : [];
  }

  /** The tools the agent was shown for a server when the service started, or null if unknown. */
  function toolsShownToAgent(name) {
    try {
      const shown = service?.getProviderData?.()?.data?.mcp;
      if (!shown || typeof shown !== "object") return null;

      // A server the framework left out was not there when its service started.
      return new Set(Object.keys(shown[name]?.tools ?? {}));
    } catch {
      // Unknown, and treated as unknown: no restart is asked for on a guess.
      return null;
    }
  }

  /** What is wrong with one server, as a sentence this module words, or null. */
  function problemWith(name, servers) {
    if (!service) return `${name}: the tool service did not start`;
    if (servers === null) return `${name}: the tool service is not answering`;
    const server = servers.find((candidate) => candidate?.name === name);
    if (!server) return `${name}: not started`;
    if (server.status !== CONNECTED) {
      // The framework leaves a server that failed to connect at "connecting".
      return `${name}: not connected (status: ${String(server.status)})`;
    }

    const offered = new Set(offeredBy(server));
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
    const server = servers?.find((candidate) => candidate?.name === name);
    const status = servers === null ? "unknown" : "absent";

    return {
      status: typeof server?.status === "string" ? server.status : status,
      tools: offeredBy(server).length,
      // "connected" alone can be a server the agent was never shown.
      usable: problemWith(name, servers) === null,
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

  function alertLost(name, problem) {
    reportedDown.set(name, problem);
    void sendAlert(
      "CRITICAL: Market-data tool server lost",
      `A market-data tool server is not working (${problem}). ` +
        "Answers are being written without live market data until this is fixed.",
    );
  }

  function confirmLoss(name) {
    confirming.delete(name);
    const problem = problemWith(name, listedServers());
    if (problem && !reportedDown.has(name)) alertLost(name, problem);
  }

  /**
   * Looks at every server, and deals with what changed since the last look.
   *
   * A server that was fine and now is not is looked at once more, a little later, before an
   * alert. A server an alert is out for is alerted again only when what is wrong with it has
   * changed, and is said to be back, at warning level so that it is seen where the alert was,
   * when nothing is.
   */
  function check() {
    if (!hasReported) return;
    const servers = listedServers();

    for (const name of serverNames) {
      const problem = problemWith(name, servers);

      if (!problem) {
        if (reportedDown.delete(name)) {
          log.warn(`[ToolServer] ${name} connected again, ${stateOf(name, servers).tools} tools`);
        }
      } else if (reportedDown.has(name)) {
        if (reportedDown.get(name) !== problem) alertLost(name, problem);
      } else if (!confirming.has(name)) {
        confirming.add(name);
        const timer = setTimeout(() => confirmLoss(name), confirmLossAfterMs);
        // A pending second look must not keep the process alive.
        timer.unref?.();
      }
    }
  }

  function alertAboutCalls(subject, message) {
    if (Date.now() - lastCallAlertAt < alertEveryMs) return;
    lastCallAlertAt = Date.now();
    isSaidToBeFailing = true;
    void sendAlert(subject, `${message} Answers are being written without live market data.`);
  }

  function remember(hasFailed) {
    recentCalls.push(hasFailed);
    if (recentCalls.length > RECENT_CALLS) recentCalls.shift();
  }

  function countFailure(label, outcome) {
    calls.failed += 1;
    failuresInARow += 1;
    remember(true);
    log.warn(`[ToolServer] ${label} failed: ${outcome}`);

    const recentFailures = recentCalls.filter(Boolean).length;
    const advice = "If the server is connected, look at its API key and at the provider.";
    if (failuresInARow >= FAILURE_STREAK_TO_ALERT) {
      alertAboutCalls(
        "CRITICAL: Market-data tool calls are failing",
        `The last ${failuresInARow} market-data tool calls failed (latest: ${label}, ${outcome}). ${advice}`,
      );
    } else if (recentFailures >= RECENT_FAILURES_TO_ALERT) {
      alertAboutCalls(
        "CRITICAL: Market-data tool calls are failing",
        `${recentFailures} of the last ${recentCalls.length} market-data tool calls failed ` +
          `(latest: ${label}, ${outcome}). ${advice}`,
      );
    }
    // A failed call can be the first sign of a lost server.
    check();
  }

  function countRefusal(label, outcome) {
    calls.refused += 1;
    // The server answered: it is reachable. Whether its key is right is another matter.
    failuresInARow = 0;
    refusalsInARow += 1;
    remember(false);
    log.log(`[ToolServer] ${label} refused the request: ${outcome}`);

    if (refusalsInARow >= REFUSAL_STREAK_TO_ALERT) {
      alertAboutCalls(
        "CRITICAL: Market-data tool calls are all being refused",
        `The last ${refusalsInARow} market-data tool calls were refused and none was answered ` +
          `(latest: ${label}, ${outcome}). Look at the kind of API key and at the server's version.`,
      );
    }
  }

  function countSuccess(label) {
    calls.ok += 1;
    failuresInARow = 0;
    refusalsInARow = 0;
    remember(false);
    if (isSaidToBeFailing) {
      isSaidToBeFailing = false;
      log.warn(`[ToolServer] ${label} ok: calls are working again`);
    } else {
      log.log(`[ToolServer] ${label} ok`);
    }
  }

  /**
   * How a call is named in what the watch says. The model picks the tool, and the framework
   * lets it name anything; only a name the server offers is printed.
   */
  function labelOf(serverName, toolName) {
    const server = listedServers()?.find((candidate) => candidate?.name === serverName);
    const isKnownServer = serverNames.includes(serverName);
    const isOffered = offeredBy(server).includes(toolName);

    return `${isKnownServer ? serverName : "other"}/${isOffered ? toolName : "other"}`;
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
      const label = labelOf(serverName, toolName);
      let result;
      try {
        result = await callTool.call(mcpService, serverName, toolName, args);
      } catch (error) {
        // The error is not passed on: its text is the framework's or the server's, and the
        // framework prints whatever it is given. Its code says enough.
        const { outcome, isRefusal } = THROWN.get(error?.code) ?? NO_ANSWER;
        if (isRefusal) countRefusal(label, outcome);
        else countFailure(label, outcome);
        throw new ToolCallFailedError(`${label} failed: ${outcome}`);
      }

      if (!result?.isError) {
        countSuccess(label);

        return result;
      }

      const { kind, outcome } = readErrorResult(result);
      if (kind === "failed") {
        countFailure(label, outcome);
        throw new ToolCallFailedError(`${label} failed: ${outcome}`);
      }

      if (kind === "refused") {
        countRefusal(label, outcome);
      } else {
        calls.unclear += 1;
        log.log(`[ToolServer] ${label} returned ${outcome}`);
      }

      return result;
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
   * Run again, it alerts only for what has changed since.
   *
   * @returns {Promise<string[]>} The problems found, one sentence each; empty when there are none.
   */
  async function reportAtStartup() {
    hasReported = true;
    const servers = listedServers();
    const problems = [];
    let hasNews = false;

    for (const name of serverNames) {
      const problem = problemWith(name, servers);
      if (problem) {
        problems.push(problem);
        if (reportedDown.get(name) !== problem) hasNews = true;
        reportedDown.set(name, problem);
      } else {
        const line = `[ToolServer] ${name} connected, ${stateOf(name, servers).tools} tools`;
        // After an alert, the good news goes where the alert was seen.
        if (reportedDown.delete(name)) log.warn(line);
        else log.log(line);
      }
    }

    if (hasNews) {
      await sendAlert(
        "CRITICAL: Market-data tool server unavailable",
        `The oracle is running without its market-data tools (${problems.join("; ")}). ` +
          "Answers are being written without live market data until this is fixed.",
      );
    }

    return problems;
  }

  function startLooking() {
    if (checkTimer) return;
    checkTimer = setInterval(check, checkEveryMs);
    checkTimer.unref?.();
  }

  /** Stops the watch's own looking. Counts and state are kept. */
  function stop() {
    clearInterval(checkTimer);
    checkTimer = null;
  }

  /**
   * Follows the agent's tool service from start-up: attaches to it when it has started, however
   * long that takes, reports, and goes on looking at the servers. Nothing here holds the
   * oracle's start-up; the caller does not wait for the promise.
   *
   * The framework starts an agent's services in the background, and its tool service counts as
   * started only after it has tried every server. So the wait can be long. A service that is
   * late is reported as missing, and is attached to and reported again when it arrives.
   *
   * @param {object | null | undefined} runtime The agent's runtime.
   * @returns {Promise<void>} Settles when the service has started or failed to, and never
   *   rejects. It stays pending for a service the framework never starts and never gives up
   *   on; the report for a late service is what says so.
   */
  function follow(runtime) {
    startLooking();

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

  /**
   * Counts a run thrown away because a tool step failed and nothing answered without it.
   *
   * @param {string} [kind] Why: one of REJECTED_RUN_KINDS. Anything else counts as a tool error.
   */
  function countRejectedRun(kind) {
    rejectedRuns[REJECTED_RUN_KINDS.includes(kind) ? kind : "toolError"] += 1;
  }

  /**
   * The servers' state and the counts, for the heartbeat. Never throws.
   *
   * @returns {{
   *   servers: Record<string, { status: string, tools: number, usable: boolean }>,
   *   calls: { ok: number, failed: number, refused: number, unclear: number },
   *   rejectedRuns: { toolError: number, noTool: number, unreadable: number },
   * }}
   */
  function observe() {
    check();
    const servers = listedServers();
    const state = {};
    for (const name of serverNames) state[name] = stateOf(name, servers);

    return { servers: state, calls: { ...calls }, rejectedRuns: { ...rejectedRuns } };
  }

  return { attach, follow, stop, reportAtStartup, observe, countRejectedRun };
}

module.exports = { createToolServerWatch, ToolCallFailedError };
