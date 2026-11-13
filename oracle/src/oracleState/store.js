"use strict";

/**
 * Where the oracle keeps its chain cursor and its failed-job queue.
 *
 * One interface, two backends:
 *  - Postgres (`createPostgresStateStore`) — the oracle's own `oracle_agent` database. Survives a
 *    restart and a storage-wiping deploy, which the files never did (tokenized-ai-agent #114).
 *  - files (`createFileStateStore`) — what the oracle always did; used where no Postgres is
 *    configured (localnet, e2e).
 *
 * Both behave the same; `test/oracleStateStore.test.js` runs one suite against each.
 *
 *   loadCursor()                         → block number, or null when nothing is stored
 *   advanceCursor(block)                 → true if stored; false if it would have moved backwards
 *   rewindCursor(block)                  → the ONLY way to lower the cursor (chain reorg)
 *   enqueueFailedJob({...})              → true if queued; false if that event is already there
 *   claimDueJobs({ limit, leaseMs })     → due pending jobs, each leased for `leaseMs`
 *   completeJob(id)                      → the retry worked: forget the job
 *   rescheduleJob(id, { delayMs, error }) → the retry failed: count it, try again later
 *   exhaustJob(id, { error })            → out of attempts: keep the row, never hand it out again
 *   countFailedJobs()                    → { pending, exhausted }
 *
 * Time comes from the injected `now()` (the oracle's clock), not the database's, so both
 * backends agree and tests can move it.
 */

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const { and, asc, eq, inArray, lte, sql } = require("drizzle-orm");

const { oracleCursorTable, oracleFailedJobTable } = require("./schema");

const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const TX_HASH_PATTERN = /^0x[0-9a-f]{64}$/;

/** A block number as a safe non-negative integer; BigInt (ethers) and numeric strings accepted. */
function toBlockNumber(value, what) {
  const n = typeof value === "bigint" || typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0 || value === "") {
    throw new TypeError(
      `${what}: expected a non-negative integer block number, got ${String(value)}`,
    );
  }
  return n;
}

function normalizeAddress(value) {
  const address = typeof value === "string" ? value.toLowerCase() : "";
  if (!ADDRESS_PATTERN.test(address)) {
    throw new TypeError(`oracle state store: "${String(value)}" is not a contract address`);
  }
  return address;
}

/** Validate and normalise what identifies a failed event. Throws TypeError on anything else. */
function normalizeJob(job) {
  const transactionHash =
    typeof job?.transactionHash === "string" ? job.transactionHash.toLowerCase() : "";
  if (!TX_HASH_PATTERN.test(transactionHash)) {
    throw new TypeError(
      `enqueueFailedJob: "${String(job?.transactionHash)}" is not a transaction hash`,
    );
  }
  if (!Number.isSafeInteger(job.logIndex) || job.logIndex < 0) {
    throw new TypeError(
      `enqueueFailedJob: log index must be a non-negative integer, got ${String(job.logIndex)}`,
    );
  }
  if (typeof job.eventName !== "string" || job.eventName.length === 0) {
    throw new TypeError("enqueueFailedJob: event name is required");
  }
  const delayMs = job.delayMs ?? 0;
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new TypeError(
      `enqueueFailedJob: delay must be a non-negative number, got ${String(job.delayMs)}`,
    );
  }
  return {
    transactionHash,
    logIndex: job.logIndex,
    eventName: job.eventName,
    blockNumber: toBlockNumber(job.blockNumber, "enqueueFailedJob"),
    delayMs,
  };
}

function errorText(error) {
  if (error === undefined || error === null) return null;
  // Bounded: an RPC or storage error can carry a whole response body.
  return String(error?.message ?? error).slice(0, 2000);
}

function byChainOrder(a, b) {
  return a.blockNumber - b.blockNumber || a.logIndex - b.logIndex;
}

/**
 * @param {{ db: object, chainId: number|bigint, contractAddress: string, now?: () => Date }} options
 *   `db` is a Drizzle Postgres database (node-postgres in production, PGlite in tests).
 */
function createPostgresStateStore({ db, chainId, contractAddress, now = () => new Date() }) {
  const chain = Number(chainId);
  if (!Number.isSafeInteger(chain) || chain <= 0) {
    throw new TypeError(`oracle state store: "${String(chainId)}" is not a chain id`);
  }
  const address = normalizeAddress(contractAddress);

  const cursors = oracleCursorTable;
  const jobs = oracleFailedJobTable;
  const thisCursor = and(eq(cursors.chainId, chain), eq(cursors.contractAddress, address));
  const theseJobs = and(eq(jobs.chainId, chain), eq(jobs.contractAddress, address));

  async function writeCursor(block, { allowBackwards }) {
    const rows = await db
      .insert(cursors)
      .values({
        chainId: chain,
        contractAddress: address,
        lastProcessedBlock: block,
        updatedAt: now(),
      })
      .onConflictDoUpdate({
        target: [cursors.chainId, cursors.contractAddress],
        set: { lastProcessedBlock: block, updatedAt: now() },
        // The guard is in the statement itself, so two writers cannot race it backwards.
        setWhere: allowBackwards ? undefined : sql`${cursors.lastProcessedBlock} <= ${block}`,
      })
      .returning({ lastProcessedBlock: cursors.lastProcessedBlock });
    // No row back means the WHERE refused the update: the stored cursor is already ahead.
    return rows.length > 0;
  }

  return {
    backend: "postgres",

    async loadCursor() {
      const rows = await db
        .select({ lastProcessedBlock: cursors.lastProcessedBlock })
        .from(cursors)
        .where(thisCursor)
        .limit(1);
      return rows.length > 0 ? Number(rows[0].lastProcessedBlock) : null;
    },

    async advanceCursor(block) {
      return writeCursor(toBlockNumber(block, "advanceCursor"), { allowBackwards: false });
    },

    async rewindCursor(block) {
      await writeCursor(toBlockNumber(block, "rewindCursor"), { allowBackwards: true });
    },

    async enqueueFailedJob(job) {
      const j = normalizeJob(job);
      const at = now();
      const rows = await db
        .insert(jobs)
        .values({
          chainId: chain,
          contractAddress: address,
          transactionHash: j.transactionHash,
          logIndex: j.logIndex,
          eventName: j.eventName,
          blockNumber: j.blockNumber,
          nextAttemptAt: new Date(at.getTime() + j.delayMs),
          createdAt: at,
          updatedAt: at,
        })
        .onConflictDoNothing({
          target: [jobs.chainId, jobs.contractAddress, jobs.transactionHash, jobs.logIndex],
        })
        .returning({ id: jobs.id });
      return rows.length > 0;
    },

    async claimDueJobs({ limit, leaseMs }) {
      const at = now();
      // One statement: pick due rows nobody else holds (SKIP LOCKED) and push their next attempt
      // out by the lease, so a second oracle — or this one's next tick — cannot take them too.
      const due = db
        .select({ id: jobs.id })
        .from(jobs)
        .where(and(theseJobs, eq(jobs.status, "pending"), lte(jobs.nextAttemptAt, at)))
        .orderBy(asc(jobs.nextAttemptAt))
        .limit(limit)
        .for("update", { skipLocked: true });
      const rows = await db
        .update(jobs)
        .set({ nextAttemptAt: new Date(at.getTime() + leaseMs), updatedAt: at })
        .where(inArray(jobs.id, due))
        .returning({
          id: jobs.id,
          transactionHash: jobs.transactionHash,
          logIndex: jobs.logIndex,
          eventName: jobs.eventName,
          blockNumber: jobs.blockNumber,
          attempts: jobs.attempts,
          lastError: jobs.lastError,
        });
      return rows
        .map((row) => ({ ...row, blockNumber: Number(row.blockNumber) }))
        .sort(byChainOrder);
    },

    async completeJob(id) {
      await db.delete(jobs).where(and(theseJobs, eq(jobs.id, id)));
    },

    async rescheduleJob(id, { delayMs, error }) {
      const at = now();
      await db
        .update(jobs)
        .set({
          attempts: sql`${jobs.attempts} + 1`,
          nextAttemptAt: new Date(at.getTime() + delayMs),
          lastError: errorText(error),
          updatedAt: at,
        })
        .where(and(theseJobs, eq(jobs.id, id)));
    },

    async exhaustJob(id, { error }) {
      await db
        .update(jobs)
        .set({
          status: "exhausted",
          attempts: sql`${jobs.attempts} + 1`,
          lastError: errorText(error),
          updatedAt: now(),
        })
        .where(and(theseJobs, eq(jobs.id, id)));
    },

    async countFailedJobs() {
      const rows = await db
        .select({ status: jobs.status, n: sql`count(*)::int` })
        .from(jobs)
        .where(theseJobs)
        .groupBy(jobs.status);
      const counts = { pending: 0, exhausted: 0 };
      for (const row of rows) counts[row.status] = Number(row.n);
      return counts;
    },
  };
}

/**
 * The file backend. One oracle process, one contract: the files carry no chain or contract.
 *
 * @param {{ statePath: string, jobsPath: string, now?: () => Date }} options
 */
function createFileStateStore({ statePath, jobsPath, now = () => new Date() }) {
  // Every job operation is read-modify-write on one file, so they run one at a time.
  let tail = Promise.resolve();
  function exclusive(task) {
    const run = tail.then(task, task);
    tail = run.catch(() => {});
    return run;
  }

  async function readJson(file) {
    try {
      return JSON.parse(await fs.readFile(file, "utf-8"));
    } catch {
      // Absent, empty or half-written: the same as nothing stored. The files only exist once
      // there is something to store, so "missing" is the normal state of a healthy oracle.
      return null;
    }
  }

  async function readJobs() {
    const parsed = await readJson(jobsPath);
    if (!Array.isArray(parsed)) return [];
    // Entries written by an older oracle version have a different shape; they cannot be claimed.
    return parsed.filter(
      (job) => typeof job?.id === "string" && typeof job.transactionHash === "string",
    );
  }

  async function writeJobs(list) {
    await fs.writeFile(jobsPath, JSON.stringify(list, null, 2));
  }

  async function readCursor() {
    const block = (await readJson(statePath))?.lastProcessedBlock;
    // 0 was the old file's way of saying "nothing yet".
    return Number.isSafeInteger(block) && block > 0 ? block : null;
  }

  async function updateJob(id, change) {
    const list = await readJobs();
    const job = list.find((entry) => entry.id === id);
    if (!job) return;
    change(job);
    await writeJobs(list);
  }

  return {
    backend: "file",

    loadCursor: readCursor,

    async advanceCursor(block) {
      const n = toBlockNumber(block, "advanceCursor");
      return exclusive(async () => {
        const current = await readCursor();
        if (current !== null && current > n) return false;
        await fs.writeFile(statePath, JSON.stringify({ lastProcessedBlock: n }));
        return true;
      });
    },

    async rewindCursor(block) {
      const n = toBlockNumber(block, "rewindCursor");
      await exclusive(() => fs.writeFile(statePath, JSON.stringify({ lastProcessedBlock: n })));
    },

    async enqueueFailedJob(job) {
      const j = normalizeJob(job);
      return exclusive(async () => {
        const list = await readJobs();
        const known = list.some(
          (entry) => entry.transactionHash === j.transactionHash && entry.logIndex === j.logIndex,
        );
        if (known) return false;
        list.push({
          id: crypto.randomUUID(),
          transactionHash: j.transactionHash,
          logIndex: j.logIndex,
          eventName: j.eventName,
          blockNumber: j.blockNumber,
          status: "pending",
          attempts: 0,
          nextAttemptAt: now().getTime() + j.delayMs,
          lastError: null,
        });
        await writeJobs(list);
        return true;
      });
    },

    async claimDueJobs({ limit, leaseMs }) {
      return exclusive(async () => {
        const at = now().getTime();
        const list = await readJobs();
        const due = list
          .filter((job) => job.status === "pending" && job.nextAttemptAt <= at)
          .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt)
          .slice(0, limit);
        if (due.length === 0) return [];
        const claimed = due.map(({ status, nextAttemptAt, ...job }) => job);
        for (const job of due) job.nextAttemptAt = at + leaseMs;
        await writeJobs(list);
        return claimed.sort(byChainOrder);
      });
    },

    async completeJob(id) {
      await exclusive(async () => {
        const list = await readJobs();
        const remaining = list.filter((job) => job.id !== id);
        if (remaining.length !== list.length) await writeJobs(remaining);
      });
    },

    async rescheduleJob(id, { delayMs, error }) {
      await exclusive(() =>
        updateJob(id, (job) => {
          job.attempts += 1;
          job.nextAttemptAt = now().getTime() + delayMs;
          job.lastError = errorText(error);
        }),
      );
    },

    async exhaustJob(id, { error }) {
      await exclusive(() =>
        updateJob(id, (job) => {
          job.status = "exhausted";
          job.attempts += 1;
          job.lastError = errorText(error);
        }),
      );
    },

    async countFailedJobs() {
      const counts = { pending: 0, exhausted: 0 };
      for (const job of await readJobs()) {
        if (job.status in counts) counts[job.status] += 1;
      }
      return counts;
    },
  };
}

module.exports = { createFileStateStore, createPostgresStateStore };
