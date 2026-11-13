const { expect } = require("chai");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { sql } = require("drizzle-orm");

const { createOracleStateDb } = require("./helpers/oracleStateDb");

// The oracle's durable state (tokenized-ai-agent #114). Before this, the chain cursor and the
// failed-job queue were two JSON files on the ROFL volume: a restart or a storage-wiping deploy
// lost both, the oracle resumed from a six-minute lookback, and any older prompt went
// unanswered. The store has two backends behind one interface — Postgres for real deployments
// and files for localnet — so the same behaviour suite runs against both.

const CHAIN_ID = 84532;
const CONTRACT = "0x4a0C7e5807f9174499a8F56F2C69c61b39a4c64D";
const OTHER_CONTRACT = "0x36ec08471f2b995024967204d7542713cfaf5fa4";
const TX_A = `0x${"a".repeat(64)}`;
const TX_B = `0x${"b".repeat(64)}`;
const MINUTE = 60 * 1000;

function loadStore() {
  return require("../src/oracleState/store");
}

function job(overrides = {}) {
  return {
    transactionHash: TX_A,
    logIndex: 3,
    eventName: "PromptSubmitted",
    blockNumber: 100,
    delayMs: 0,
    ...overrides,
  };
}

function behavesLikeAStateStore(setup) {
  let ctx;
  let clock;

  beforeEach(async () => {
    clock = { ms: Date.parse("2026-11-13T00:00:00Z") };
    ctx = await setup(() => new Date(clock.ms));
  });

  afterEach(async () => {
    await ctx.close();
  });

  describe("cursor", () => {
    it("has no cursor before the first advance", async () => {
      expect(await ctx.store.loadCursor()).to.equal(null);
    });

    it("stores and reloads the cursor", async () => {
      expect(await ctx.store.advanceCursor(120)).to.equal(true);

      expect(await ctx.store.loadCursor()).to.equal(120);
    });

    it("refuses to move backwards on advance, without throwing", async () => {
      await ctx.store.advanceCursor(120);

      const moved = await ctx.store.advanceCursor(90);

      expect(moved).to.equal(false);
      expect(await ctx.store.loadCursor()).to.equal(120);
    });

    it("moves backwards only through an explicit rewind", async () => {
      await ctx.store.advanceCursor(120);

      await ctx.store.rewindCursor(80);

      expect(await ctx.store.loadCursor()).to.equal(80);
    });

    it("rejects a block number that is not a non-negative integer", async () => {
      for (const bad of [Number.NaN, -1, 1.5, undefined, "abc"]) {
        let error;
        try {
          await ctx.store.advanceCursor(bad);
        } catch (e) {
          error = e;
        }
        expect(error, `advanceCursor(${String(bad)})`).to.be.instanceOf(TypeError);
      }
      expect(await ctx.store.loadCursor()).to.equal(null);
    });

    it("accepts the BigInt block numbers ethers can hand back", async () => {
      await ctx.store.advanceCursor(150n);

      expect(await ctx.store.loadCursor()).to.equal(150);
    });
  });

  describe("failed jobs", () => {
    it("queues an event once, however often it is enqueued", async () => {
      const first = await ctx.store.enqueueFailedJob(job());
      const second = await ctx.store.enqueueFailedJob(job({ eventName: "BranchRequested" }));

      expect(first).to.equal(true);
      expect(second).to.equal(false);
      expect(await ctx.store.countFailedJobs()).to.deep.equal({ pending: 1, exhausted: 0 });
    });

    it("treats the same transaction hash in different letter case as the same event", async () => {
      await ctx.store.enqueueFailedJob(job());

      const again = await ctx.store.enqueueFailedJob(
        job({ transactionHash: TX_A.toUpperCase().replace("0X", "0x") }),
      );

      expect(again).to.equal(false);
    });

    it("keeps two events of one transaction apart by log index", async () => {
      await ctx.store.enqueueFailedJob(job({ logIndex: 3 }));
      await ctx.store.enqueueFailedJob(job({ logIndex: 4 }));

      expect((await ctx.store.countFailedJobs()).pending).to.equal(2);
    });

    it("hands out only the jobs that are due", async () => {
      await ctx.store.enqueueFailedJob(job({ delayMs: 0 }));
      await ctx.store.enqueueFailedJob(job({ transactionHash: TX_B, delayMs: 5 * MINUTE }));

      const claimed = await ctx.store.claimDueJobs({ limit: 10, leaseMs: MINUTE });

      expect(claimed.map((j) => j.transactionHash)).to.deep.equal([TX_A]);
      expect(claimed[0]).to.include({
        logIndex: 3,
        eventName: "PromptSubmitted",
        blockNumber: 100,
        attempts: 0,
      });
      expect(claimed[0].id).to.be.a("string");
    });

    it("leases a claimed job so a second claim cannot take it too", async () => {
      await ctx.store.enqueueFailedJob(job());

      const first = await ctx.store.claimDueJobs({ limit: 10, leaseMs: MINUTE });
      const second = await ctx.store.claimDueJobs({ limit: 10, leaseMs: MINUTE });

      expect(first).to.have.length(1);
      expect(second).to.have.length(0);
    });

    it("offers a claimed job again once its lease has run out", async () => {
      await ctx.store.enqueueFailedJob(job());
      await ctx.store.claimDueJobs({ limit: 10, leaseMs: MINUTE });

      clock.ms += 2 * MINUTE;
      const again = await ctx.store.claimDueJobs({ limit: 10, leaseMs: MINUTE });

      expect(again).to.have.length(1);
    });

    it("respects the claim limit, oldest due first", async () => {
      await ctx.store.enqueueFailedJob(job({ transactionHash: TX_B, delayMs: 2000 }));
      await ctx.store.enqueueFailedJob(job({ transactionHash: TX_A, delayMs: 1000 }));
      clock.ms += MINUTE;

      const claimed = await ctx.store.claimDueJobs({ limit: 1, leaseMs: MINUTE });

      expect(claimed.map((j) => j.transactionHash)).to.deep.equal([TX_A]);
    });

    it("removes a completed job", async () => {
      await ctx.store.enqueueFailedJob(job());
      const [claimed] = await ctx.store.claimDueJobs({ limit: 10, leaseMs: MINUTE });

      await ctx.store.completeJob(claimed.id);

      expect(await ctx.store.countFailedJobs()).to.deep.equal({ pending: 0, exhausted: 0 });
    });

    it("reschedules a failed attempt, counting it and keeping the error", async () => {
      await ctx.store.enqueueFailedJob(job());
      const [claimed] = await ctx.store.claimDueJobs({ limit: 10, leaseMs: MINUTE });

      await ctx.store.rescheduleJob(claimed.id, {
        delayMs: 10 * MINUTE,
        error: "503 from storage",
      });

      expect(await ctx.store.claimDueJobs({ limit: 10, leaseMs: MINUTE })).to.have.length(0);
      clock.ms += 11 * MINUTE;
      const [retried] = await ctx.store.claimDueJobs({ limit: 10, leaseMs: MINUTE });
      expect(retried.attempts).to.equal(1);
      expect(retried.lastError).to.equal("503 from storage");
    });

    it("keeps an exhausted job on record but never hands it out again", async () => {
      await ctx.store.enqueueFailedJob(job());
      const [claimed] = await ctx.store.claimDueJobs({ limit: 10, leaseMs: MINUTE });

      await ctx.store.exhaustJob(claimed.id, { error: "gave up" });

      clock.ms += 24 * 60 * MINUTE;
      expect(await ctx.store.claimDueJobs({ limit: 10, leaseMs: MINUTE })).to.have.length(0);
      expect(await ctx.store.countFailedJobs()).to.deep.equal({ pending: 0, exhausted: 1 });
    });

    it("does not let a stray completion erase an exhausted job's record", async () => {
      await ctx.store.enqueueFailedJob(job());
      const [claimed] = await ctx.store.claimDueJobs({ limit: 10, leaseMs: MINUTE });
      await ctx.store.exhaustJob(claimed.id, { error: "gave up" });

      await ctx.store.completeJob(claimed.id);

      expect(await ctx.store.countFailedJobs()).to.deep.equal({ pending: 0, exhausted: 1 });
    });

    it("does not let a stray reschedule alter an exhausted job's record", async () => {
      await ctx.store.enqueueFailedJob(job());
      const [claimed] = await ctx.store.claimDueJobs({ limit: 10, leaseMs: MINUTE });
      await ctx.store.exhaustJob(claimed.id, { error: "gave up" });

      await ctx.store.rescheduleJob(claimed.id, { delayMs: 0, error: "stray" });
      await ctx.store.exhaustJob(claimed.id, { error: "stray again" });

      const [record] = await ctx.store.listExhaustedJobs();
      expect(record).to.include({ attempts: 1, lastError: "gave up" });
    });

    it("does not queue an exhausted event again if the scan meets it a second time", async () => {
      await ctx.store.enqueueFailedJob(job());
      const [claimed] = await ctx.store.claimDueJobs({ limit: 10, leaseMs: MINUTE });
      await ctx.store.exhaustJob(claimed.id, { error: "gave up" });

      const again = await ctx.store.enqueueFailedJob(job());

      expect(again).to.equal(false);
      expect(await ctx.store.countFailedJobs()).to.deep.equal({ pending: 0, exhausted: 1 });
    });

    it("rejects a job that does not identify an on-chain event", async () => {
      for (const bad of [
        { transactionHash: "0x1234" },
        { transactionHash: undefined },
        { logIndex: -1 },
        { logIndex: undefined },
        { eventName: "" },
        { blockNumber: Number.NaN },
      ]) {
        let error;
        try {
          await ctx.store.enqueueFailedJob(job(bad));
        } catch (e) {
          error = e;
        }
        expect(error, JSON.stringify(bad)).to.be.instanceOf(TypeError);
      }
      expect((await ctx.store.countFailedJobs()).pending).to.equal(0);
    });
  });
}

describe("oracle state store", () => {
  describe("Postgres backend", () => {
    behavesLikeAStateStore(async (now) => {
      const { createPostgresStateStore } = loadStore();
      const { db, close } = await createOracleStateDb();
      const store = createPostgresStateStore({
        db,
        chainId: CHAIN_ID,
        contractAddress: CONTRACT,
        now,
      });
      return { store, db, close };
    });

    describe("isolation and database guarantees", () => {
      let db;
      let close;

      beforeEach(async () => {
        ({ db, close } = await createOracleStateDb());
      });

      afterEach(async () => {
        await close();
      });

      it("keeps a separate cursor and queue per contract", async () => {
        const { createPostgresStateStore } = loadStore();
        const one = createPostgresStateStore({ db, chainId: CHAIN_ID, contractAddress: CONTRACT });
        const two = createPostgresStateStore({
          db,
          chainId: CHAIN_ID,
          contractAddress: OTHER_CONTRACT,
        });

        await one.advanceCursor(500);
        await one.enqueueFailedJob(job());

        expect(await two.loadCursor()).to.equal(null);
        expect(await two.claimDueJobs({ limit: 10, leaseMs: MINUTE })).to.have.length(0);
        expect(await two.enqueueFailedJob(job())).to.equal(true);
      });

      it("stores the contract address in lower case whatever case it was given in", async () => {
        const { createPostgresStateStore } = loadStore();
        const mixed = createPostgresStateStore({
          db,
          chainId: CHAIN_ID,
          contractAddress: CONTRACT,
        });
        const lower = createPostgresStateStore({
          db,
          chainId: CHAIN_ID,
          contractAddress: CONTRACT.toLowerCase(),
        });

        await mixed.advanceCursor(77);

        expect(await lower.loadCursor()).to.equal(77);
      });

      it("refuses a contract address that is not an address", () => {
        const { createPostgresStateStore } = loadStore();

        expect(() =>
          createPostgresStateStore({ db, chainId: CHAIN_ID, contractAddress: "0xabc" }),
        ).to.throw(TypeError);
      });

      it("has the database itself refuse a status outside the known list", async () => {
        let error;
        try {
          await db.execute(sql`
            insert into oracle_state.oracle_failed_jobs
              (chain_id, contract_address, transaction_hash, log_index, event_name, block_number, status, next_attempt_at)
            values (${CHAIN_ID}, ${CONTRACT.toLowerCase()}, ${TX_A}, 0, 'PromptSubmitted', 1, 'processing', now())`);
        } catch (e) {
          error = e;
        }

        expect(String(error?.cause?.message ?? error?.message)).to.include(
          "oracle_failed_jobs_status_known",
        );
      });

      it("has the database itself refuse a mixed-case address", async () => {
        let error;
        try {
          await db.execute(sql`
            insert into oracle_state.oracle_cursors (chain_id, contract_address, last_processed_block)
            values (${CHAIN_ID}, ${CONTRACT}, 1)`);
        } catch (e) {
          error = e;
        }

        expect(String(error?.cause?.message ?? error?.message)).to.include(
          "oracle_cursors_address_hex",
        );
      });

      it("the status list in code is the one the database enforces", () => {
        const { ORACLE_JOB_STATUSES } = require("../src/oracleState/schema");

        expect([...ORACLE_JOB_STATUSES]).to.deep.equal(["pending", "exhausted"]);
      });
    });
  });

  describe("file backend", () => {
    behavesLikeAStateStore(async (now) => {
      const { createFileStateStore } = loadStore();
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-state-"));
      const store = createFileStateStore({
        statePath: path.join(dir, "oracle-state.json"),
        jobsPath: path.join(dir, "failed-jobs.json"),
        now,
      });
      return { store, close: () => fs.rm(dir, { recursive: true, force: true }) };
    });

    it("reads a cursor file written by the previous oracle version", async () => {
      const { createFileStateStore } = loadStore();
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-state-"));
      await fs.writeFile(
        path.join(dir, "oracle-state.json"),
        JSON.stringify({ lastProcessedBlock: 4242 }),
      );
      const store = createFileStateStore({
        statePath: path.join(dir, "oracle-state.json"),
        jobsPath: path.join(dir, "failed-jobs.json"),
      });

      expect(await store.loadCursor()).to.equal(4242);
      await fs.rm(dir, { recursive: true, force: true });
    });

    it("treats a missing or corrupt file as empty rather than failing", async () => {
      const { createFileStateStore } = loadStore();
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-state-"));
      await fs.writeFile(path.join(dir, "oracle-state.json"), "");
      await fs.writeFile(path.join(dir, "failed-jobs.json"), "{}");
      const store = createFileStateStore({
        statePath: path.join(dir, "oracle-state.json"),
        jobsPath: path.join(dir, "failed-jobs.json"),
      });

      expect(await store.loadCursor()).to.equal(null);
      expect(await store.countFailedJobs()).to.deep.equal({ pending: 0, exhausted: 0 });
      await fs.rm(dir, { recursive: true, force: true });
    });
  });
});
