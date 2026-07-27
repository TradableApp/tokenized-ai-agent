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
 * @param {{ postgresUrl?: string, expectDatabase?: string, loadSqlPlugin?: () => Promise<any> }} [options]
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
  // schema → run its migrations, so the agent runtime that starts next sees the
  // freshly created tables.
  const adapter = createDatabaseAdapter({ postgresUrl }, SERVER_AGENT_ID);
  await adapter.init();

  // Cache the handle: plugin-sql's getDatabase() is a synchronous getter today, but
  // calling it twice reads as if two databases might be involved, and a future version
  // that lazily built or validated a connection would do that work twice.
  const db = adapter.getDatabase();

  // Assert the adapter really is pointed at the DB we asked for, BEFORE creating any
  // tables. Cheap, and version-independent in a way that inspecting pool internals is
  // not: it asks Postgres itself. Without it, a plugin-sql change that made the
  // connection-manager key url-derived (see the close() note below) could route these
  // migrations — and then the agent's tables — into the shared `senseai` cache with no
  // error at all, which is precisely the collision the separate DB exists to prevent.
  if (options.expectDatabase) {
    const result = await db.execute("select current_database() as db");
    // Explicit about the two driver shapes (top-level array vs `{rows: [...]}`) so the
    // fail-closed path is obvious rather than resting on a `??` short-circuit.
    const rows = Array.isArray(result) ? result : (result?.rows ?? []);
    const actual = rows[0]?.db;
    // FAIL CLOSED on an unreadable answer. Treating a null/empty/reshaped result as
    // "probably fine" would silently disarm this guard — the exact silent-wrong-DB
    // outcome it exists to prevent — and the shape (`.rows[0].db`) depends on the
    // driver, so a plugin-sql/drizzle change is a realistic way for it to go quiet.
    if (!actual) {
      throw new Error(
        `Could not read current_database() to verify the pool is on "${options.expectDatabase}" ` +
          `(no usable value in the result). Refusing to migrate rather than assuming the ` +
          `database is correct — check connectivity and whether @elizaos/plugin-sql's ` +
          `execute() result shape has changed.`,
      );
    }
    if (actual !== options.expectDatabase) {
      throw new Error(
        `plugin-sql connected to Postgres database "${actual}" but "${options.expectDatabase}" was ` +
          `requested. Refusing to migrate: the agent schema would land in the wrong database. ` +
          `Check POSTGRES_URL and whether @elizaos/plugin-sql's connection-manager key ` +
          `(currently the global "default:pg" singleton) has changed.`,
      );
    }
  }

  const migrationService = new DatabaseMigrationService();
  await migrationService.initializeWithDatabase(db);
  migrationService.discoverAndRegisterPluginSchemas([sqlPlugin]);
  await migrationService.runAllPluginMigrations();

  // DO NOT add `await adapter.close()` here — it would break the boot.
  //
  // `createDatabaseAdapter` caches its PostgresConnectionManager in a GLOBAL
  // singleton keyed `"default:pg"` — not by url and not by agentId
  // (@elizaos/plugin-sql/dist/node/index.node.js:21110 sets managerKey = "default"
  // unless ENABLE_DATA_ISOLATION=true; :21124 builds the key; :21128-21142 is the
  // singleton Map, and on a hit the cached manager is returned while
  // `config.postgresUrl` is IGNORED). `PgDatabaseAdapter.close()` is
  // `this.manager.close()` (:15774), i.e. it closes that SHARED manager.
  //
  // Two consequences:
  //  1. Nothing leaks — the ElizaOS runtime reuses this very manager rather than
  //     opening a second pool, so there is no per-boot idle connection to reclaim.
  //  2. Closing it would drop the pool the runtime is about to use, forcing a
  //     reconnect through the isClosed() → recreate path, which re-reads
  //     process.env.POSTGRES_URL and re-opens the clobbering risk that
  //     `writeEnv: false` exists to prevent.
  //
  // Corollary that makes this function load-bearing: because the key is
  // first-caller-wins, running these migrations BEFORE `new ElizaOS()` is what
  // pins the agent runtime to the oracle_agent DB. Revisit if a plugin-sql
  // upgrade makes managerKey url-derived — then the adapters diverge and closing
  // becomes correct.
  return true;
}

module.exports = { runServerLevelMigrations, SERVER_AGENT_ID };
