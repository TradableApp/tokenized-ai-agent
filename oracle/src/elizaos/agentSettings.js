"use strict";

/**
 * What the agent framework may copy out of the oracle's environment, and the cleaning of what it
 * has stored.
 *
 * When an agent is added, the framework copies environment variables into the character's
 * settings, and when the agent starts it writes the character, settings included, to the agent
 * database. That database is outside the enclave. With no list set the framework copies every
 * variable, so the list below is set before the agent is added, and it holds names of settings
 * only: model names and the framework's own tuning values. Nothing the oracle must keep to itself
 * belongs in it. The plugins that need a credential read it from the environment themselves.
 *
 * The framework's plugins read their settings through the runtime and never from the
 * environment, so two things the list keeps out still have to reach them: the address of the
 * agent database, and the tool servers with what each is started with. Both are handed to the
 * runtime as its own settings, which it keeps in memory and does not store. See
 * agentForFramework.
 *
 * What an earlier build stored is still in the database, and the framework merges it back in on
 * every start, so every stored agent is cleaned after the agent has started.
 */

// Read by the framework or the model plugin through the agent's settings. A test refuses any
// name here that looks like a credential or the address of a service.
const AGENT_ENV_ALLOW_LIST = Object.freeze([
  "SMALL_MODEL",
  "LARGE_MODEL",
  "IMAGE_MODEL",
  "TEXT_EMBEDDING_MODEL",
  "GOOGLE_SMALL_MODEL",
  "GOOGLE_LARGE_MODEL",
  "GOOGLE_IMAGE_MODEL",
  "GOOGLE_EMBEDDING_MODEL",
  "EMBEDDING_DIMENSION",
  "USE_MULTI_STEP",
  "MAX_MULTISTEP_ITERATIONS",
  "MULTISTEP_PARSE_RETRIES",
  "MULTISTEP_SUMMARY_PARSE_RETRIES",
  "PROVIDERS_TOTAL_TIMEOUT_MS",
  "BOOTSTRAP_DEFLLMOFF",
  "BOOTSTRAP_KEEP_RESP",
  "ALWAYS_RESPOND_CHANNELS",
  "ALWAYS_RESPOND_SOURCES",
  "SHOULD_RESPOND_BYPASS_SOURCES",
  "SHOULD_RESPOND_BYPASS_TYPES",
]);

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The settings with every stored secret that is not allowed removed, and with the stored tool
 * servers removed whole. A stored tool-server block is put back into the running character on the
 * next start and used ahead of the one the oracle built, so what is stored would choose the
 * command the oracle runs. Returns new objects; what it is given is not changed.
 *
 * @param {object|null|undefined} settings the agent row's settings
 * @param {readonly string[]} allowList names that may stay under `secrets`
 * @param {readonly string[]} [keepSettings] the setting names the character defines itself.
 *   When given, a stored setting under any other name is removed: the framework reads a stored
 *   setting ahead of the one the oracle hands the runtime.
 * @returns {{ settings: object, removedSecrets: number, removedToolServers: number, removedSettings: number }}
 */
function withoutSecrets(settings, allowList, keepSettings) {
  const source = isPlainObject(settings) ? settings : {};
  const allowed = new Set(allowList);
  let removedSecrets = 0;
  let removedToolServers = 0;
  let removedSettings = 0;
  const { mcp, ...others } = source;
  const kept = keepSettings ? new Set(keepSettings) : null;
  const cleaned = {};
  for (const [name, value] of Object.entries(others)) {
    if (!kept || kept.has(name)) cleaned[name] = value;
    else removedSettings += 1;
  }

  if ("secrets" in source) {
    const stored = isPlainObject(source.secrets) ? source.secrets : {};
    const keptSecrets = {};
    for (const [name, value] of Object.entries(stored)) {
      if (allowed.has(name)) keptSecrets[name] = value;
      else removedSecrets += 1;
    }
    cleaned.secrets = keptSecrets;
  }

  // The empty block this build stores is harmless and is put back as it was.
  if (isPlainObject(mcp) && Object.keys(mcp).length === 0) {
    cleaned.mcp = {};
  } else if ("mcp" in source) {
    const servers = isPlainObject(mcp?.servers) ? Object.keys(mcp.servers).length : 0;
    removedToolServers = Math.max(servers, 1);
  }

  return { settings: cleaned, removedSecrets, removedToolServers, removedSettings };
}

// What the database plugin reads through the runtime.
const DATABASE_SETTINGS = Object.freeze(["POSTGRES_URL", "PGLITE_DATA_DIR"]);

/**
 * One agent as the framework is given it: the character without its tool servers, and the
 * settings the runtime keeps in memory only. The character is what the framework stores.
 *
 * @param {{ character: object, env?: Record<string, string|undefined> }} options
 * @returns {{ character: object, settings: object }}
 */
function agentForFramework({ character, env = {} }) {
  const { mcp, ...ownSettings } = isPlainObject(character.settings) ? character.settings : {};
  // An empty block and not a name left out. On a start the framework puts the stored settings
  // under the character's own, and the tool plugin looks in the character before the runtime's
  // settings: a name left out would let a stored block through. An empty block replaces it in
  // the running character, and the tool plugin passes over a block that names no servers. It
  // cannot be null: the framework refuses a character with a null setting.
  const storedSettings = { ...ownSettings, mcp: {} };
  const settings = {};
  if (mcp !== undefined && mcp !== null) settings.mcp = mcp;
  for (const name of DATABASE_SETTINGS) {
    const value = env[name];
    if (typeof value === "string" && value.trim() !== "") settings[name] = value;
  }
  return { character: { ...character, settings: storedSettings }, settings };
}

/**
 * Cleans the stored settings of every agent in the database. Writes only the rows something was
 * removed from.
 *
 * @param {{
 *   query: (text: string, values?: unknown[]) => Promise<{ rows: object[] }>,
 *   allowList?: readonly string[],
 *   keepSettings?: readonly string[],
 * }} options
 * @returns {Promise<{ agents: number, removedSecrets: number, removedToolServers: number, removedSettings: number }>}
 */
async function scrubStoredAgentSettings({ query, allowList = AGENT_ENV_ALLOW_LIST, keepSettings }) {
  const read = await query("SELECT id, settings FROM agents");
  const total = {
    agents: read.rows.length,
    removedSecrets: 0,
    removedToolServers: 0,
    removedSettings: 0,
  };

  for (const row of read.rows) {
    const { settings, removedSecrets, removedToolServers, removedSettings } = withoutSecrets(
      row.settings,
      allowList,
      keepSettings,
    );
    if (removedSecrets + removedToolServers + removedSettings === 0) continue;
    await query("UPDATE agents SET settings = $2::jsonb WHERE id = $1", [
      row.id,
      JSON.stringify(settings),
    ]);
    total.removedSecrets += removedSecrets;
    total.removedToolServers += removedToolServers;
    total.removedSettings += removedSettings;
  }
  return total;
}

// One short-lived connection: this runs once, after the agent has started.
const SCRUB_QUERY_TIMEOUT_MS = 10 * 1000;

/**
 * Cleans the stored settings in the agent's Postgres database, over a connection of its own.
 *
 * @param {{ postgresUrl: string, keepSettings?: readonly string[] }} options
 */
async function scrubAgentSettingsInPostgres({ postgresUrl, keepSettings }) {
  // Lazy, as in oracleState/runtime: a run with no database never loads pg.
  const { Client } = require("pg");
  const client = new Client({
    connectionString: postgresUrl,
    connectionTimeoutMillis: SCRUB_QUERY_TIMEOUT_MS,
    query_timeout: SCRUB_QUERY_TIMEOUT_MS,
    statement_timeout: SCRUB_QUERY_TIMEOUT_MS,
  });
  // A connection that drops while idle raises an event, and an event nobody listens for stops
  // the process. The query in flight still fails and is reported by the caller.
  client.on("error", () => {});
  await client.connect();
  try {
    return await scrubStoredAgentSettings({
      query: (text, values) => client.query(text, values),
      keepSettings,
    });
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * The clean at start-up, with what it reports. A failure does not stop the oracle: answers do
 * not depend on it. It is alerted, because until it succeeds a stored row may hold values that
 * belong only inside the enclave. Of a failure only its kind is reported: a database error can
 * carry the address it was connecting to.
 *
 * @param {{
 *   scrub: () => Promise<{ agents: number, removedSecrets: number, removedToolServers: number }>,
 *   alert: (subject: string, message: string) => Promise<unknown>,
 *   log?: (line: string) => void,
 * }} options
 */
async function cleanStoredAgentSettings({ scrub, alert, log = console.log }) {
  let subject;
  let message;
  try {
    const { agents, removedSecrets, removedToolServers, removedSettings = 0 } = await scrub();
    const removed =
      `${removedSecrets} stored value(s), ${removedToolServers} stored tool server(s) and ` +
      `${removedSettings} other stored setting(s)`;
    log(`[ElizaOS] Stored agent settings cleaned: ${agents} agent(s), ${removed} removed.`);
    if (removedSecrets + removedToolServers + removedSettings === 0) return;
    subject = "CRITICAL: Stored agent settings held values that were removed";
    message =
      `${removed} were removed from the agent database at start-up. An earlier build stores ` +
      "values there, and nothing else should write to it. Treat every secret an earlier build " +
      "was given as exposed to the agent database and rotate it.";
  } catch (error) {
    const kind = String(error?.code ?? error?.name ?? "Error");
    log(`[ElizaOS] Could not clean the stored agent settings (${kind}).`);
    subject = "CRITICAL: Stored agent settings could not be cleaned";
    message =
      `The agent's stored settings were not cleaned at start-up (${kind}). The oracle is ` +
      "answering. A stored row may still hold values from an earlier build.";
  }
  try {
    await alert(subject, message);
  } catch {
    log("[ElizaOS] The alert about the stored agent settings could not be sent.");
  }
}

module.exports = {
  AGENT_ENV_ALLOW_LIST,
  agentForFramework,
  withoutSecrets,
  scrubStoredAgentSettings,
  scrubAgentSettingsInPostgres,
  cleanStoredAgentSettings,
};
