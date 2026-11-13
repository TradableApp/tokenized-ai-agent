"use strict";

/**
 * The oracle's durable state: where it is on the chain, and which events it still owes a retry.
 *
 * These tables live in the oracle's OWN database (`oracle_agent`), not the shared `senseai` one,
 * and are created by the same plugin-sql migration run that creates the agent tables (see
 * agentSchemaMigrator.js). They replace `oracle-state.json` and `failed-jobs.json`, which sat on
 * the ROFL volume and were lost on every restart and every `--wipe-storage` deploy.
 *
 * Two limits of plugin-sql's dynamic migration shape this file:
 *  - it never records an index's WHERE clause, so a partial index would silently become a full
 *    one — none is used;
 *  - it compares check constraints BY NAME, so editing a check's body never reaches the
 *    database. Change a check by giving it a new name.
 */

const { sql } = require("drizzle-orm");
const {
  bigint,
  check,
  index,
  integer,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} = require("drizzle-orm/pg-core");

// plugin-sql derives a plugin's schema from its name ("oracle-state" → "oracle_state"); the two
// must agree or it warns that the tables are outside the plugin's own schema.
const ORACLE_STATE_PLUGIN_NAME = "oracle-state";
const oracleStateSchema = pgSchema("oracle_state");

/** A failed job is `pending` until it succeeds (row deleted) or runs out of attempts. */
const ORACLE_JOB_STATUSES = Object.freeze(["pending", "exhausted"]);

/**
 * One row per (chain, contract): the last block whose events have all been handed to a handler
 * or to the failed-job queue.
 *
 * Usage: the store's `advanceCursor` only ever moves it forward; `rewindCursor` is the one
 * deliberate exception (a chain reorg).
 */
const oracleCursorTable = oracleStateSchema.table(
  "oracle_cursors",
  {
    chainId: bigint("chain_id", { mode: "number" }).notNull(),
    contractAddress: text("contract_address").notNull(),
    lastProcessedBlock: bigint("last_processed_block", { mode: "number" }).notNull(),
    // Written by the request-counter poll loop; 0 until then.
    lastRequestNumber: bigint("last_request_number", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    primaryKey({ name: "oracle_cursors_pk", columns: [table.chainId, table.contractAddress] }),
    check("oracle_cursors_address_hex", sql`${table.contractAddress} ~ '^0x[0-9a-f]{40}$'`),
    check("oracle_cursors_block_nonneg", sql`${table.lastProcessedBlock} >= 0`),
    check("oracle_cursors_request_nonneg", sql`${table.lastRequestNumber} >= 0`),
  ],
);

/**
 * One row per on-chain event the oracle failed to handle and will retry.
 *
 * Deliberately a POINTER, not a copy: the event's arguments (ciphertext) are not stored. The
 * retry re-reads the transaction receipt, which is the source of truth.
 *
 * Usage: `enqueue` is idempotent on the event's identity; `claimDue` leases due rows by pushing
 * `next_attempt_at` forward, so two oracles cannot both pick up the same job.
 */
const oracleFailedJobTable = oracleStateSchema.table(
  "oracle_failed_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chainId: bigint("chain_id", { mode: "number" }).notNull(),
    contractAddress: text("contract_address").notNull(),
    transactionHash: text("transaction_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    eventName: text("event_name").notNull(),
    blockNumber: bigint("block_number", { mode: "number" }).notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("oracle_failed_jobs_event_uq").on(
      table.chainId,
      table.contractAddress,
      table.transactionHash,
      table.logIndex,
    ),
    // Equality columns first, then the range the claim query scans. Not partial: see file header.
    index("oracle_failed_jobs_due_idx").on(
      table.chainId,
      table.contractAddress,
      table.status,
      table.nextAttemptAt,
    ),
    check("oracle_failed_jobs_address_hex", sql`${table.contractAddress} ~ '^0x[0-9a-f]{40}$'`),
    check("oracle_failed_jobs_tx_hex", sql`${table.transactionHash} ~ '^0x[0-9a-f]{64}$'`),
    check("oracle_failed_jobs_status_known", sql`${table.status} in ('pending', 'exhausted')`),
    check("oracle_failed_jobs_attempts_nonneg", sql`${table.attempts} >= 0`),
    check("oracle_failed_jobs_log_index_nonneg", sql`${table.logIndex} >= 0`),
  ],
);

/** What agentSchemaMigrator registers with plugin-sql's migration service. */
const oracleStatePlugin = Object.freeze({
  name: ORACLE_STATE_PLUGIN_NAME,
  schema: { oracleCursorTable, oracleFailedJobTable },
});

module.exports = {
  ORACLE_JOB_STATUSES,
  ORACLE_STATE_PLUGIN_NAME,
  oracleCursorTable,
  oracleFailedJobTable,
  oracleStatePlugin,
  oracleStateSchema,
};
