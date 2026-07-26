/**
 * Runs @elizaos/plugin-sql's server-level schema migration against the oracle's
 * Postgres database BEFORE the ElizaOS runtime initializes — Phase 4 of the
 * Oracle Brain migration (CU-86d3dwme6).
 *
 * The oracle boots ElizaOS via the programmatic API (`new ElizaOS()` →
 * `addAgents` → `startAgents`). That path — unlike the `elizaos start` CLI, which
 * runs through `AgentServer.initialize()` — never performs the server-level
 * migration that creates the core schema (`agents`, `memories`, …). On the shared
 * `senseai` DB core got away with it because the tables already existed; on the
 * oracle's fresh dedicated `oracle_agent` DB the runtime's very first
 * `ensureAgentExists()` query fails with `relation "agents" does not exist`
 * (Postgres 42P01) — and it runs BEFORE the agent-level migration, so the agent
 * never recovers. This replicates exactly what `AgentServer.initialize()` does:
 * create an adapter, register plugin-sql's schema, and run its migrations.
 *
 * No-op when `postgresUrl` is absent (localnet/e2e → plugin-sql's PGLite
 * fallback), so it only affects the Postgres-backed deployments.
 */

// The reserved "server" agent id core uses to bootstrap the schema before any
// real agent exists (@elizaos/server AgentServer.initialize).
const SERVER_AGENT_ID = "00000000-0000-0000-0000-000000000000";

function defaultLoadSqlPlugin() {
  // Dynamic import: @elizaos/plugin-sql ships as ESM; the oracle is CommonJS.
  return import("@elizaos/plugin-sql");
}

/**
 * @param {{ postgresUrl?: string, loadSqlPlugin?: () => Promise<any> }} [options]
 * @returns {Promise<boolean>} true when migrations ran, false when skipped (no Postgres)
 */
async function runServerLevelMigrations(options = {}) {
  const postgresUrl = options.postgresUrl;
  if (!postgresUrl || !postgresUrl.trim()) {
    return false;
  }

  const loadSqlPlugin = options.loadSqlPlugin ?? defaultLoadSqlPlugin;
  const {
    DatabaseMigrationService,
    createDatabaseAdapter,
    default: sqlPlugin,
  } = await loadSqlPlugin();

  // Same sequence as AgentServer.initialize(): adapter → init → register the core
  // schema → run its migrations. The adapter shares plugin-sql's connection so the
  // agent runtime that starts next sees the freshly created tables.
  const adapter = createDatabaseAdapter({ postgresUrl }, SERVER_AGENT_ID);
  await adapter.init();

  const migrationService = new DatabaseMigrationService();
  await migrationService.initializeWithDatabase(adapter.getDatabase());
  migrationService.discoverAndRegisterPluginSchemas([sqlPlugin]);
  await migrationService.runAllPluginMigrations();

  return true;
}

module.exports = { runServerLevelMigrations, SERVER_AGENT_ID };
