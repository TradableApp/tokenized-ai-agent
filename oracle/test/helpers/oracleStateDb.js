"use strict";

/**
 * A throwaway in-memory Postgres (PGlite) holding the oracle-state tables, created the way
 * production creates them: by plugin-sql's own migration service, not by hand-written DDL. A
 * test that passes here therefore also proves the migration builds what the store relies on.
 */
async function createOracleStateDb() {
  const { PGlite } = require("@electric-sql/pglite");
  const { drizzle } = require("drizzle-orm/pglite");
  const { DatabaseMigrationService } = await import("@elizaos/plugin-sql");
  const { oracleStatePlugin } = require("../../src/oracleState/schema");

  const client = new PGlite();
  const db = drizzle(client);

  const migrationService = new DatabaseMigrationService();
  await migrationService.initializeWithDatabase(db);
  migrationService.discoverAndRegisterPluginSchemas([oracleStatePlugin]);
  await migrationService.runAllPluginMigrations();

  return { db, close: () => client.close() };
}

module.exports = { createOracleStateDb };
