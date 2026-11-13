const { expect } = require("chai");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { createOracleStateDb } = require("./helpers/oracleStateDb");
const { createStateStore, resolveResumeCursor } = require("../src/oracleState/runtime");

// Start-up decisions for the oracle's durable state (tokenized-ai-agent #114): which backend to
// use, and where to resume. The failure this guards against is the one seen on the 2026-11-11
// run day — a restarted oracle found no state, looked back six minutes, and would have skipped
// any prompt older than that.

const CHAIN_ID = 84532;
const CONTRACT = "0x4a0c7e5807f9174499a8f56f2c69c61b39a4c64d";

async function tempPaths() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-runtime-"));
  return {
    dir,
    statePath: path.join(dir, "oracle-state.json"),
    jobsPath: path.join(dir, "failed-jobs.json"),
  };
}

describe("oracle state runtime", () => {
  let paths;
  let closeDb = async () => {};

  beforeEach(async () => {
    paths = await tempPaths();
  });

  afterEach(async () => {
    await closeDb();
    closeDb = async () => {};
    await fs.rm(paths.dir, { recursive: true, force: true });
  });

  describe("createStateStore", () => {
    it("uses the files when no Postgres url is configured", () => {
      const { store } = createStateStore({
        postgresUrl: null,
        chainId: CHAIN_ID,
        contractAddress: CONTRACT,
        ...paths,
      });

      expect(store.backend).to.equal("file");
    });

    it("treats a blank Postgres url as not configured", () => {
      const { store } = createStateStore({
        postgresUrl: "   ",
        chainId: CHAIN_ID,
        contractAddress: CONTRACT,
        ...paths,
      });

      expect(store.backend).to.equal("file");
    });

    it("uses Postgres on the given url", async () => {
      const { db, close } = await createOracleStateDb();
      closeDb = close;
      const seenUrls = [];

      const { store } = createStateStore({
        postgresUrl: "postgresql://oracle@db/oracle_agent",
        chainId: CHAIN_ID,
        contractAddress: CONTRACT,
        ...paths,
        createDb: (url) => {
          seenUrls.push(url);
          return db;
        },
      });

      expect(store.backend).to.equal("postgres");
      expect(seenUrls).to.deep.equal(["postgresql://oracle@db/oracle_agent"]);
      await store.advanceCursor(10);
      expect(await store.loadCursor()).to.equal(10);
    });
  });

  describe("resolveResumeCursor", () => {
    it("resumes from the stored cursor", async () => {
      const { store } = createStateStore({
        chainId: CHAIN_ID,
        contractAddress: CONTRACT,
        ...paths,
      });
      await store.advanceCursor(900);

      expect(await resolveResumeCursor({ store })).to.deep.equal({ cursor: 900, source: "store" });
    });

    it("reports no cursor on a first ever start", async () => {
      const { store } = createStateStore({
        chainId: CHAIN_ID,
        contractAddress: CONTRACT,
        ...paths,
      });

      expect(await resolveResumeCursor({ store })).to.deep.equal({ cursor: null, source: "none" });
    });

    it("does not take a cursor from the previous version's state file", async () => {
      // That file's cursor is already past whatever sat in the old failed-jobs file, which this
      // store cannot read; resuming from it would skip those events for good. A lookback at
      // least meets the recent ones again.
      const { db, close } = await createOracleStateDb();
      closeDb = close;
      await fs.writeFile(paths.statePath, JSON.stringify({ lastProcessedBlock: 4242 }));
      const { store } = createStateStore({
        postgresUrl: "postgresql://oracle@db/oracle_agent",
        chainId: CHAIN_ID,
        contractAddress: CONTRACT,
        ...paths,
        createDb: () => db,
      });

      expect(await resolveResumeCursor({ store })).to.deep.equal({ cursor: null, source: "none" });
    });

    it("keeps trying a store that fails at first, and resumes once it answers", async () => {
      // A database restart or a slow first connection at boot must not cost a lookback: falling
      // back overwrites the real cursor with the head on the next save, and the gap is gone.
      const waits = [];
      let calls = 0;
      const store = {
        loadCursor: async () => {
          calls += 1;
          if (calls < 3) throw new Error("connection refused");
          return 777;
        },
      };

      const resume = await resolveResumeCursor({
        store,
        retryDelaysMs: [1000, 2000, 4000],
        sleep: async (ms) => waits.push(ms),
      });

      expect(resume).to.deep.equal({ cursor: 777, source: "store" });
      expect(waits).to.deep.equal([1000, 2000]);
    });

    it("falls back to no cursor and reports it once every attempt has failed", async () => {
      const failure = new Error('relation "oracle_state.oracle_cursors" does not exist');
      const reported = [];
      const waits = [];
      let calls = 0;
      const store = {
        loadCursor: async () => {
          calls += 1;
          throw failure;
        },
      };

      const resume = await resolveResumeCursor({
        store,
        retryDelaysMs: [1000, 2000],
        sleep: async (ms) => waits.push(ms),
        onUnavailable: (error) => reported.push(error),
      });

      expect(resume).to.deep.equal({ cursor: null, source: "unavailable" });
      expect(calls).to.equal(3);
      expect(waits).to.deep.equal([1000, 2000]);
      expect(reported).to.deep.equal([failure]);
    });
  });
});
