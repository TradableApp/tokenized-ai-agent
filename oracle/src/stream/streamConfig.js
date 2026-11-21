/**
 * The live reasoning stream server's settings: their defaults, what each may be, and the one
 * reader that turns the environment into the server's configuration.
 *
 * Every setting is optional; the defaults live here so no deployment needs a new line in its
 * environment. A set value that cannot work stops start-up (through `validateConfig` in
 * startupConfig.js), naming the setting and never repeating the value: a value pasted into the
 * wrong setting can be a secret, and a machine's logs are kept.
 */

const STREAM_SETTING_DEFAULTS = Object.freeze({
  /** `false` runs no server; frames are still built and the stored record is unchanged. */
  STREAM_ENABLED: true,
  /** Not used by any service of the localnet harness. Published by every compose file. */
  STREAM_PORT: 8787,
  /** How long a finished answer's frames are kept, for a second device that finds it late. */
  STREAM_GRACE_MS: 120000,
  STREAM_HEARTBEAT_MS: 15000,
  STREAM_MAX_CONN_MS: 240000,
  STREAM_MAX_CONN_PER_ANSWER: 4,
  STREAM_MAX_CONN_TOTAL: 200,
});

/**
 * The origins a browser may read the stream from, by NETWORK_NAME, when STREAM_ALLOWED_ORIGINS
 * is not set: the dApp's local dev server, the sandbox hosting site, and production. A network
 * not listed here (the Sapphire ones) gets none: the server still runs, and no browser can read
 * it until the setting names an origin.
 */
const DEFAULT_ALLOWED_ORIGINS = Object.freeze({
  "base-localnet": Object.freeze(["http://localhost:3002", "http://127.0.0.1:3002"]),
  baseSepolia: Object.freeze([
    "https://sense-ai-app-garrick.web.app",
    "https://sense-ai-app-garrick.firebaseapp.com",
  ]),
  base: Object.freeze(["https://senseai.tradable.app", "https://sense-ai-app.web.app"]),
});

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** The longest timer a setting may ask for: one day, well inside what setTimeout can hold. */
const MAX_SETTING_MS = 24 * 60 * 60 * 1000;
const MAX_CONNECTIONS = 10000;
const MAX_PORT = 65535;

const isBlank = (value) => typeof value !== "string" || !value.trim();

/**
 * A whole number from `min` to `max`, or null with a problem recorded (by name, not value).
 */
function readWhole(env, name, { min, max, unit }, problems) {
  if (isBlank(env[name])) return STREAM_SETTING_DEFAULTS[name];
  const raw = env[name].trim();
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (Number.isSafeInteger(value) && value >= min && value <= max) return value;
  problems.push(`${name} is not a whole number${unit ? ` of ${unit}` : ""} from ${min} to ${max}`);
  return null;
}

/** Whether an allow-list entry is exactly an origin: scheme and host (and port), nothing more. */
function isExactOrigin(entry) {
  let url;
  try {
    url = new URL(entry);
  } catch {
    return false;
  }
  if (url.origin !== entry) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

function readOrigins(env, problems) {
  if (isBlank(env.STREAM_ALLOWED_ORIGINS)) {
    const network = typeof env.NETWORK_NAME === "string" ? env.NETWORK_NAME.trim() : "";
    return [...(DEFAULT_ALLOWED_ORIGINS[network] ?? [])];
  }
  const entries = env.STREAM_ALLOWED_ORIGINS.split(",").map((entry) => entry.trim());
  const bad = entries
    .map((entry, index) => (isExactOrigin(entry) ? null : index + 1))
    .filter((position) => position !== null);
  if (bad.length > 0) {
    problems.push(
      `STREAM_ALLOWED_ORIGINS entry ${bad.join(", ")} is not an exact origin: a comma list of ` +
        "https://host[:port] (http:// only for localhost, 127.0.0.1 or [::1]), with no path, " +
        "no trailing slash and no user",
    );
    return null;
  }
  return entries;
}

function readEnabled(env, problems) {
  if (isBlank(env.STREAM_ENABLED)) return STREAM_SETTING_DEFAULTS.STREAM_ENABLED;
  const raw = env.STREAM_ENABLED.trim();
  if (raw === "true") return true;
  if (raw === "false") return false;
  problems.push('STREAM_ENABLED is neither "true" nor "false"');
  return null;
}

/**
 * Reads the settings. Returns the configuration and the problems found; a problem names its
 * setting and never its value. When the stream is switched off nothing else is read.
 */
function parseStreamConfig(env = process.env) {
  const problems = [];
  const enabled = readEnabled(env, problems);
  if (enabled !== true) return { config: { enabled: false }, problems };

  const ms = { min: 1, max: MAX_SETTING_MS, unit: "milliseconds" };
  const config = {
    enabled: true,
    port: readWhole(env, "STREAM_PORT", { min: 1, max: MAX_PORT }, problems),
    allowedOrigins: readOrigins(env, problems),
    graceMs: readWhole(env, "STREAM_GRACE_MS", ms, problems),
    heartbeatMs: readWhole(env, "STREAM_HEARTBEAT_MS", ms, problems),
    maxConnMs: readWhole(env, "STREAM_MAX_CONN_MS", ms, problems),
    maxConnPerAnswer: readWhole(
      env,
      "STREAM_MAX_CONN_PER_ANSWER",
      { min: 1, max: MAX_CONNECTIONS },
      problems,
    ),
    maxConnTotal: readWhole(
      env,
      "STREAM_MAX_CONN_TOTAL",
      { min: 1, max: MAX_CONNECTIONS },
      problems,
    ),
  };
  if (
    config.heartbeatMs !== null &&
    config.maxConnMs !== null &&
    config.heartbeatMs >= config.maxConnMs
  ) {
    problems.push(
      "STREAM_HEARTBEAT_MS is not shorter than STREAM_MAX_CONN_MS: a connection would end " +
        "before its first heartbeat",
    );
  }
  if (
    config.maxConnPerAnswer !== null &&
    config.maxConnTotal !== null &&
    config.maxConnPerAnswer > config.maxConnTotal
  ) {
    problems.push("STREAM_MAX_CONN_PER_ANSWER is above STREAM_MAX_CONN_TOTAL");
  }
  return { config, problems };
}

/** The problems with the stream settings, for startupConfig.js's single report. */
function streamConfigProblems(env = process.env) {
  return parseStreamConfig(env).problems;
}

/** The configuration; throws, naming every bad setting, when there is a problem. */
function readStreamConfig(env = process.env) {
  const { config, problems } = parseStreamConfig(env);
  if (problems.length > 0) {
    throw new Error(`The stream settings cannot be used: ${problems.join("; ")}.`);
  }
  return config;
}

module.exports = {
  STREAM_SETTING_DEFAULTS,
  DEFAULT_ALLOWED_ORIGINS,
  streamConfigProblems,
  readStreamConfig,
};
