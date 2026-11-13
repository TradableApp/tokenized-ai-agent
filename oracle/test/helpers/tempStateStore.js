"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createFileStateStore } = require("../../src/oracleState/store");

/**
 * A real file-backed oracle state store in a fresh temp directory.
 *
 * Tests assert through the store (`loadCursor`, `countFailedJobs`, `claimDueJobs`) instead of
 * on fs stub calls, and nothing is ever written to `oracle/oracle-state.json` or
 * `oracle/failed-jobs.json` — both are gitignored, so a stray write would go unnoticed and leak
 * a cursor into the next run's start-up tests.
 *
 * Synchronous on purpose: `setupOracleTestEnv` is synchronous and so are its callers' hooks.
 *
 * @param {{ now?: () => Date }} [options] an injectable clock for backoff assertions
 */
function createTempStateStore({ now } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-state-test-"));
  const statePath = path.join(dir, "oracle-state.json");
  const jobsPath = path.join(dir, "failed-jobs.json");
  const store = createFileStateStore({ statePath, jobsPath, ...(now ? { now } : {}) });
  return {
    store,
    dir,
    statePath,
    jobsPath,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** A well-formed transaction hash, distinct per seed: the store rejects anything else. */
function txHash(seed) {
  return `0x${crypto.createHash("sha256").update(String(seed)).digest("hex")}`;
}

/**
 * Bring a pending job to `attempts` failed attempts through the store's own API, the way the
 * retry loop would have, leaving it due now.
 */
async function failJobAttempts(store, attempts) {
  for (let i = 0; i < attempts; i++) {
    const [job] = await store.claimDueJobs({ limit: 1, leaseMs: 0 });
    if (!job) throw new Error(`failJobAttempts: no due job to fail (attempt ${i + 1})`);
    await store.rescheduleJob(job.id, { delayMs: 0, error: new Error("seeded failure") });
  }
}

module.exports = { createTempStateStore, txHash, failJobAttempts };
