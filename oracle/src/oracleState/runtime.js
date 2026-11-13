"use strict";

/**
 * Choosing the oracle's state store at start-up, and reading the resume point from it.
 *
 * Kept out of aiAgentOracle.js so both decisions can be tested without booting the oracle.
 */

const { createFileStateStore, createPostgresStateStore } = require("./store");

// Short: this pool serves a cursor write every few seconds and the retry tick. A hung query must
// not stall the poll loop behind it.
const STATE_QUERY_TIMEOUT_MS = 10 * 1000;
const STATE_POOL_SIZE = 2;

function defaultCreateDb(connectionString) {
  // Lazy requires, as in brainContext: localnet/e2e runs never load pg.
  const { Pool } = require("pg");
  const { drizzle } = require("drizzle-orm/node-postgres");
  const pool = new Pool({
    connectionString,
    max: STATE_POOL_SIZE,
    connectionTimeoutMillis: STATE_QUERY_TIMEOUT_MS,
    query_timeout: STATE_QUERY_TIMEOUT_MS,
    statement_timeout: STATE_QUERY_TIMEOUT_MS,
  });
  // An idle client that errors (database restart, network drop) emits on the pool; without a
  // listener that is an unhandled 'error' event and the process dies.
  pool.on("error", (error) => {
    console.error("[OracleState] idle Postgres client error:", error.message);
  });
  return drizzle(pool);
}

/**
 * Postgres when the oracle has its own agent database, the files otherwise.
 *
 * `postgresUrl` is the SAME url the schema migration ran against (see initializeEliza), so the
 * tables this store uses are the ones that migration just created.
 *
 * @param {{
 *   postgresUrl?: string|null, chainId: number|bigint, contractAddress: string,
 *   statePath: string, jobsPath: string, createDb?: (url: string) => object,
 * }} options
 * @returns {{ store: object, legacyFileStore: object|null }} `legacyFileStore` is set only on
 *   Postgres: the files an older oracle version may have left on the volume.
 */
function createStateStore({
  postgresUrl,
  chainId,
  contractAddress,
  statePath,
  jobsPath,
  createDb = defaultCreateDb,
}) {
  const fileStore = createFileStateStore({ statePath, jobsPath });
  if (!postgresUrl || !postgresUrl.trim()) {
    return { store: fileStore, legacyFileStore: null };
  }
  const store = createPostgresStateStore({ db: createDb(postgresUrl), chainId, contractAddress });
  return { store, legacyFileStore: fileStore };
}

/**
 * The block the oracle last finished, or null when it has to fall back to a recent-block lookback.
 *
 * Never throws: a database that cannot be read at start-up must not stop the oracle from
 * answering new prompts. It is reported through `onUnavailable` so the caller can alert — a
 * lookback after a long outage can skip prompts, and someone has to know.
 *
 * @param {{ store: object, legacyFileStore?: object|null, onUnavailable?: (error: Error) => any }} options
 * @returns {Promise<{ cursor: number|null, source: "store"|"legacy-file"|"none"|"unavailable" }>}
 */
async function resolveResumeCursor({ store, legacyFileStore = null, onUnavailable = () => {} }) {
  let stored;
  try {
    stored = await store.loadCursor();
  } catch (error) {
    await onUnavailable(error);
    return { cursor: null, source: "unavailable" };
  }
  if (stored !== null) {
    return { cursor: stored, source: "store" };
  }

  // First boot on Postgres: carry over the cursor file the previous version wrote, if the volume
  // still has it, so the deploy that introduces the database does not itself cause a lookback.
  if (legacyFileStore) {
    const legacy = await legacyFileStore.loadCursor().catch(() => null);
    if (legacy !== null) {
      return { cursor: legacy, source: "legacy-file" };
    }
  }
  return { cursor: null, source: "none" };
}

module.exports = { createStateStore, resolveResumeCursor };
