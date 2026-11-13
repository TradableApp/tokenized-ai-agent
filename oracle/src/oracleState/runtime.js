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
 * @returns {{ store: object }}
 */
function createStateStore({
  postgresUrl,
  chainId,
  contractAddress,
  statePath,
  jobsPath,
  createDb = defaultCreateDb,
}) {
  if (!postgresUrl || !postgresUrl.trim()) {
    return { store: createFileStateStore({ statePath, jobsPath }) };
  }
  return {
    store: createPostgresStateStore({ db: createDb(postgresUrl), chainId, contractAddress }),
  };
}

// A database restart or a slow first connection at boot is common and short. About a minute of
// patience is cheap next to what falling back costs (see resolveResumeCursor).
const RESUME_RETRY_DELAYS_MS = [2000, 4000, 8000, 16000, 30000];

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The block the oracle last finished, or null when it has to fall back to a recent-block lookback.
 *
 * Never throws: a database that cannot be read at start-up must not stop the oracle from
 * answering new prompts. But it does not give up quickly either. Falling back is not free — the
 * oracle then saves the chain head over the cursor it could not read, and whatever lay between
 * that cursor and the lookback window is skipped for good — so the read is retried first, and a
 * fallback is reported through `onUnavailable` so the caller can alert.
 *
 * A cursor file left by an older oracle version is deliberately NOT used: its cursor is past
 * whatever sat in that version's failed-jobs file, which this store cannot read.
 *
 * @param {{
 *   store: object, onUnavailable?: (error: Error) => any,
 *   retryDelaysMs?: number[], sleep?: (ms: number) => Promise<any>,
 * }} options
 * @returns {Promise<{ cursor: number|null, source: "store"|"none"|"unavailable" }>}
 */
async function resolveResumeCursor({
  store,
  onUnavailable = () => {},
  retryDelaysMs = RESUME_RETRY_DELAYS_MS,
  sleep = defaultSleep,
}) {
  let lastError;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
    try {
      const stored = await store.loadCursor();
      return stored === null
        ? { cursor: null, source: "none" }
        : { cursor: stored, source: "store" };
    } catch (error) {
      lastError = error;
      if (attempt < retryDelaysMs.length) {
        console.warn(
          `[OracleState] Could not read the stored cursor (attempt ${attempt + 1}): ${error.message}. Retrying in ${retryDelaysMs[attempt]} ms.`,
        );
        await sleep(retryDelaysMs[attempt]);
      }
    }
  }

  await onUnavailable(lastError);
  return { cursor: null, source: "unavailable" };
}

module.exports = { createStateStore, resolveResumeCursor };
