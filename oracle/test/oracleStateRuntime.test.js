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
      const { store, legacyFileStore } = createStateStore({
        postgresUrl: null,
        chainId: CHAIN_ID,
        contractAddress: CONTRACT,
        ...paths,
      });

      expect(store.backend).to.equal("file");
      expect(legacyFileStore).to.equal(null);
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

    it("uses Postgres on the given url and keeps the files as the legacy source", async () => {
      const { db, close } = await createOracleStateDb();
      closeDb = close;
      const seenUrls = [];

      const { store, legacyFileStore } = createStateStore({
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
      expect(legacyFileStore.backend).to.equal("file");
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

    it("carries over the previous version's cursor file on the first Postgres start", async () => {
      const { db, close } = await createOracleStateDb();
      closeDb = close;
      await fs.writeFile(paths.statePath, JSON.stringify({ lastProcessedBlock: 4242 }));
      const { store, legacyFileStore } = createStateStore({
        postgresUrl: "postgresql://oracle@db/oracle_agent",
        chainId: CHAIN_ID,
        contractAddress: CONTRACT,
        ...paths,
        createDb: () => db,
      });

      const resume = await resolveResumeCursor({ store, legacyFileStore });

      expect(resume).to.deep.equal({ cursor: 4242, source: "legacy-file" });
    });

    it("prefers the database over a stale cursor file", async () => {
      const { db, close } = await createOracleStateDb();
      closeDb = close;
      await fs.writeFile(paths.statePath, JSON.stringify({ lastProcessedBlock: 10 }));
      const { store, legacyFileStore } = createStateStore({
        postgresUrl: "postgresql://oracle@db/oracle_agent",
        chainId: CHAIN_ID,
        contractAddress: CONTRACT,
        ...paths,
        createDb: () => db,
      });
      await store.advanceCursor(5000);

      const resume = await resolveResumeCursor({ store, legacyFileStore });

      expect(resume).to.deep.equal({ cursor: 5000, source: "store" });
    });

    it("falls back to no cursor and reports it when the store cannot be read", async () => {
      const failure = new Error('relation "oracle_state.oracle_cursors" does not exist');
      const reported = [];
      const store = {
        loadCursor: async () => {
          throw failure;
        },
      };

      const resume = await resolveResumeCursor({
        store,
        legacyFileStore: { loadCursor: async () => 77 },
        onUnavailable: (error) => reported.push(error),
      });

      // NOT the legacy file: the database may hold a newer cursor we simply cannot see, and a
      // stale file would send the oracle back over blocks it has already answered.
      expect(resume).to.deep.equal({ cursor: null, source: "unavailable" });
      expect(reported).to.deep.equal([failure]);
    });
  });
});
