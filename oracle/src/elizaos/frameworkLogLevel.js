"use strict";

/**
 * The agent framework's log level, held at warning inside the oracle.
 *
 * The agent runtime the oracle starts builds a logger of its own (`createLogger` in the
 * runtime's constructor, @elizaos/core 1.7.2), which writes to the console directly. It is not
 * the framework's shared logger, which the oracle wraps and cleans (mutedFrameworkLogs.js), and
 * the runtime offers no option to hand it one. Its information and debug lines, and those of the
 * plugins that log through it, can carry a query's text, its bound values and a peer. Every
 * logger the framework builds takes its level from `LOG_LEVEL`, read once when the framework is
 * loaded, so the oracle sets it before that: warnings and errors are still printed (those that
 * pass through the shared logger cleaned), nothing below them is. The shared logger is held at
 * the same level, since the setting is one for the whole framework.
 *
 * A level the operator set that is at least as strict is kept; a looser or unknown one (the
 * framework reads a level it does not know as information) is replaced.
 */

// The framework's levels at warning or above (LOG_LEVEL_PRIORITY in @elizaos/core). The
// framework lower-cases the setting and reads it otherwise as written.
const AT_LEAST_WARN = new Set(["warn", "error", "fatal", "alert"]);
const HELD_LEVEL = "warn";

/**
 * @param {string | undefined} level The `LOG_LEVEL` the operator set, if any.
 * @returns {string} That level when it is warning or stricter, otherwise "warn".
 */
function heldFrameworkLogLevel(level) {
  return typeof level === "string" && AT_LEAST_WARN.has(level.toLowerCase()) ? level : HELD_LEVEL;
}

/**
 * Sets `LOG_LEVEL` in `env` to the held level. Must run before @elizaos/core is first loaded.
 * @param {Record<string, string | undefined>} [env]
 */
function holdFrameworkLogLevel(env = process.env) {
  env.LOG_LEVEL = heldFrameworkLogLevel(env.LOG_LEVEL);
}

module.exports = { heldFrameworkLogLevel, holdFrameworkLogLevel };
