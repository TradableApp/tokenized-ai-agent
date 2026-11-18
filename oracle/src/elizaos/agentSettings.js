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
 * Two things still reach the stored row and are removed after the agent has started: values
 * written by an earlier build, which the framework merges back in on every start, and what each
 * tool server is started with, which the character has to carry in memory for the tool plugin.
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
 * The settings with every stored secret that is not allowed removed, and with each tool
 * server's start-up environment removed. Returns new objects; what it is given is not changed.
 *
 * @param {object|null|undefined} settings the agent row's settings
 * @param {readonly string[]} allowList names that may stay under `secrets`
 * @returns {{ settings: object, removedSecrets: number, removedToolEnv: number }}
 */
function withoutSecrets(settings, allowList) {
  const source = isPlainObject(settings) ? settings : {};
  const allowed = new Set(allowList);
  let removedSecrets = 0;
  let removedToolEnv = 0;
  const cleaned = { ...source };

  if ("secrets" in source) {
    const stored = isPlainObject(source.secrets) ? source.secrets : {};
    const kept = {};
    for (const [name, value] of Object.entries(stored)) {
      if (allowed.has(name)) kept[name] = value;
      else removedSecrets += 1;
    }
    cleaned.secrets = kept;
  }

  const servers = source.mcp?.servers;
  if (isPlainObject(servers)) {
    const cleanedServers = {};
    for (const [name, server] of Object.entries(servers)) {
      if (isPlainObject(server) && "env" in server) {
        const { env: _env, ...rest } = server;
        cleanedServers[name] = rest;
        removedToolEnv += 1;
      } else {
        cleanedServers[name] = server;
      }
    }
    cleaned.mcp = { ...source.mcp, servers: cleanedServers };
  }

  return { settings: cleaned, removedSecrets, removedToolEnv };
}

/**
 * Cleans the stored settings of one agent. Writes only when something was removed.
 *
 * @param {{
 *   query: (text: string, values: unknown[]) => Promise<{ rows: object[] }>,
 *   agentId: string,
 *   allowList?: readonly string[],
 * }} options
 * @returns {Promise<{ found: boolean, removedSecrets: number, removedToolEnv: number }>}
 */
async function scrubStoredAgentSettings({ query, agentId, allowList = AGENT_ENV_ALLOW_LIST }) {
  const read = await query("SELECT settings FROM agents WHERE id = $1", [agentId]);
  if (read.rows.length === 0) {
    return { found: false, removedSecrets: 0, removedToolEnv: 0 };
  }

  const { settings, removedSecrets, removedToolEnv } = withoutSecrets(
    read.rows[0].settings,
    allowList,
  );
  if (removedSecrets > 0 || removedToolEnv > 0) {
    await query("UPDATE agents SET settings = $2::jsonb WHERE id = $1", [
      agentId,
      JSON.stringify(settings),
    ]);
  }
  return { found: true, removedSecrets, removedToolEnv };
}

// One short-lived connection: this runs once, after the agent has started.
const SCRUB_QUERY_TIMEOUT_MS = 10 * 1000;

/**
 * Cleans the stored settings in the agent's Postgres database, over a connection of its own.
 *
 * @param {{ postgresUrl: string, agentId: string }} options
 */
async function scrubAgentSettingsInPostgres({ postgresUrl, agentId }) {
  // Lazy, as in oracleState/runtime: a run with no database never loads pg.
  const { Client } = require("pg");
  const client = new Client({
    connectionString: postgresUrl,
    connectionTimeoutMillis: SCRUB_QUERY_TIMEOUT_MS,
    query_timeout: SCRUB_QUERY_TIMEOUT_MS,
    statement_timeout: SCRUB_QUERY_TIMEOUT_MS,
  });
  await client.connect();
  try {
    return await scrubStoredAgentSettings({
      query: (text, values) => client.query(text, values),
      agentId,
    });
  } finally {
    await client.end();
  }
}

module.exports = {
  AGENT_ENV_ALLOW_LIST,
  withoutSecrets,
  scrubStoredAgentSettings,
  scrubAgentSettingsInPostgres,
};
