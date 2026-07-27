const { expect } = require("chai");

// The oracle boots ElizaOS via the programmatic API (new ElizaOS()/addAgents/
// startAgents), which — unlike `elizaos start` (AgentServer.initialize) — never
// runs plugin-sql's server-level schema migration. On a fresh dedicated DB
// (oracle_agent) the runtime's first `ensureAgentExists()` then fails with
// `relation "agents" does not exist` (42P01). This module replicates that step.
const { runServerLevelMigrations, SERVER_AGENT_ID } = require("../src/agentSchemaMigrator");

// Fake @elizaos/plugin-sql: records the call sequence so we can assert ordering
// without a live Postgres. Mirrors the real API surface the migrator drives.
function makeFakePlugin() {
  const calls = [];
  const fakeDb = { __db: true };
  const adapter = {
    init: async () => calls.push(["adapter.init"]),
    getDatabase: () => {
      calls.push(["adapter.getDatabase"]);
      return fakeDb;
    },
  };
  const migrationServiceInstance = {
    initializeWithDatabase: async (db) => calls.push(["initializeWithDatabase", db]),
    discoverAndRegisterPluginSchemas: (plugins) =>
      calls.push(["discoverAndRegisterPluginSchemas", plugins]),
    runAllPluginMigrations: async () => calls.push(["runAllPluginMigrations"]),
  };
  const sqlPlugin = { name: "@elizaos/plugin-sql", schema: {} };
  const mod = {
    default: sqlPlugin,
    createDatabaseAdapter: (config, agentId) => {
      calls.push(["createDatabaseAdapter", config, agentId]);
      return adapter;
    },
    DatabaseMigrationService: function () {
      calls.push(["new DatabaseMigrationService"]);
      return migrationServiceInstance;
    },
  };
  return { calls, mod, sqlPlugin, fakeDb };
}

describe("agentSchemaMigrator", () => {
  it("no-ops (returns false, loads nothing) when postgresUrl is absent — PGLite/localnet", async () => {
    let loaded = false;
    const result = await runServerLevelMigrations({
      postgresUrl: "",
      loadSqlPlugin: async () => {
        loaded = true;
        return {};
      },
    });
    expect(result).to.equal(false);
    expect(loaded).to.equal(false);
  });

  it("runs plugin-sql's server-level migration sequence against the postgres url", async () => {
    const { calls, mod, sqlPlugin, fakeDb } = makeFakePlugin();
    const url = "postgresql://u:p@h:5432/oracle_agent?sslmode=verify-ca";

    const result = await runServerLevelMigrations({
      postgresUrl: url,
      loadSqlPlugin: async () => mod,
    });

    expect(result).to.equal(true);
    // adapter built with the url + the reserved server agent id (matches core)
    expect(calls.find((c) => c[0] === "createDatabaseAdapter")).to.deep.equal([
      "createDatabaseAdapter",
      { postgresUrl: url },
      SERVER_AGENT_ID,
    ]);
    // the core schema (agents, …) is registered from sqlPlugin's default export
    expect(calls.find((c) => c[0] === "discoverAndRegisterPluginSchemas")[1]).to.deep.equal([
      sqlPlugin,
    ]);
    // migrations run against the adapter's own db handle
    expect(calls.find((c) => c[0] === "initializeWithDatabase")[1]).to.equal(fakeDb);
    // strict ordering: init → initializeWithDatabase → register → runAll
    const names = calls.map((c) => c[0]);
    expect(names.indexOf("adapter.init")).to.be.lessThan(names.indexOf("initializeWithDatabase"));
    expect(names.indexOf("initializeWithDatabase")).to.be.lessThan(
      names.indexOf("discoverAndRegisterPluginSchemas"),
    );
    expect(names.indexOf("discoverAndRegisterPluginSchemas")).to.be.lessThan(
      names.indexOf("runAllPluginMigrations"),
    );
  });

  it("propagates a migration failure (fatal — the boot must not proceed on an empty schema)", async () => {
    const { mod } = makeFakePlugin();
    mod.DatabaseMigrationService = function () {
      return {
        initializeWithDatabase: async () => {},
        discoverAndRegisterPluginSchemas: () => {},
        runAllPluginMigrations: async () => {
          throw new Error("migrate boom");
        },
      };
    };

    let threw = null;
    try {
      await runServerLevelMigrations({
        postgresUrl: "postgresql://x/y",
        loadSqlPlugin: async () => mod,
      });
    } catch (e) {
      threw = e;
    }
    expect(threw).to.be.an("error");
    expect(threw.message).to.match(/migrate boom/);
  });
  it("refuses to migrate when the pool landed on a DIFFERENT database than expected", async () => {
    const { mod } = makeFakePlugin();
    mod.createDatabaseAdapter = () => ({
      init: async () => {},
      getDatabase: () => ({ execute: async () => ({ rows: [{ db: "senseai" }] }) }),
    });

    let threw = null;
    try {
      await runServerLevelMigrations({
        postgresUrl: "postgresql://x/y",
        expectDatabase: "oracle_agent",
        loadSqlPlugin: async () => mod,
      });
    } catch (e) {
      threw = e;
    }
    expect(threw).to.be.an("error");
    expect(threw.message).to.match(/"senseai".*"oracle_agent"|wrong database/s);
  });

  it("proceeds when current_database() matches the expected agent DB", async () => {
    const { mod, calls } = makeFakePlugin();
    mod.createDatabaseAdapter = (config, agentId) => {
      calls.push(["createDatabaseAdapter", config, agentId]);
      return {
        init: async () => {},
        getDatabase: () => ({ execute: async () => ({ rows: [{ db: "oracle_agent" }] }) }),
      };
    };

    const result = await runServerLevelMigrations({
      postgresUrl: "postgresql://x/y",
      expectDatabase: "oracle_agent",
      loadSqlPlugin: async () => mod,
    });

    expect(result).to.equal(true);
    expect(calls.map((c) => c[0])).to.include("runAllPluginMigrations");
  });
});
