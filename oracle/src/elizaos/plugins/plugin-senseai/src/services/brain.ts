import { elizaLogger, type IAgentRuntime, Service } from "@elizaos/core";

/**
 * The oracle's adapter onto the shared Brain.
 *
 * IT OWNS NO CONNECTION, DELIBERATELY. An earlier version built its own `pg.Pool` here, and that
 * was wrong three ways at once — no TLS, no timeouts, and a raw Pool handed to the Brain as
 * `ctx.db` where `BrainDatabase = NodePgDatabase` requires a drizzle instance, which is a
 * runtime failure rather than a style difference.
 *
 * The Brain's connection is a HOST concern. `oracle/src/brainContext.js` already builds it
 * correctly: `bootstrapPostgresFromEnv({ writeEnv: false })` produces a URL carrying the mTLS
 * cert parameters Cloud SQL requires under TRUSTED_CLIENT_CERTIFICATE_REQUIRED, wraps the pool
 * in drizzle, and sets connection/query/statement timeouts so a hung query cannot stall an
 * on-chain answer. `writeEnv: false` matters too: plugin-sql owns `process.env.POSTGRES_URL`
 * pointed at the ISOLATED `oracle_agent` database, so writing it would repoint the agent runtime
 * at the cache.
 *
 * The plugin cannot reuse that helper without pulling `oracle/src` internals into its bundle,
 * and duplicating it is what produced the bug. So the host injects an accessor via
 * `setBrainAccessor` and this service simply delegates — which also keeps sense-ai-core's
 * arrangement intact, where the runtime's own database IS the shared cache.
 *
 * Providers still resolve it the ElizaOS way, `runtime.getService("brain")`; only the plumbing
 * behind it differs between bodies.
 *
 * Every read degrades to null/[] rather than throwing: localnet e2e runs with no Cloud SQL at
 * all, and a provider that throws fails composeState for the entire turn.
 */

/** Returns the host's live Brain handles, or null when the Brain is unavailable. */
export type BrainAccessor = () => Promise<{
  brain: any;
  ctx: any;
  sentimentEngine: any;
} | null>;

let accessor: BrainAccessor | null = null;

/**
 * Host injection point. Called once at oracle start-up with a getter for the Brain handles;
 * pass `null` to clear (tests).
 */
export function setBrainAccessor(next: BrainAccessor | null): void {
  accessor = next;
}

/** Resolves the handles, absorbing any failure — never throws into a provider. */
async function handles() {
  if (!accessor) return null;
  try {
    return await accessor();
  } catch (error) {
    elizaLogger.error(
      `[Brain] Handles unavailable, answering without market context: ${String(
        (error as any)?.message ?? error,
      )}`,
    );
    return null;
  }
}

export class BrainService extends Service {
  static serviceType = "brain";

  override capabilityDescription =
    "Read access to the shared SenseAI Brain warm cache (macro + enriched news).";

  static async start(runtime: IAgentRuntime): Promise<BrainService> {
    return new BrainService(runtime);
  }

  /** True when the host has a live Brain to read from. */
  async isReady(): Promise<boolean> {
    return (await handles()) !== null;
  }

  /** Latest global macro row, or null when unavailable. */
  async getLatestMacro(): Promise<unknown | null> {
    const h = await handles();
    if (!h?.sentimentEngine?.getLatestMacro) return null;
    try {
      return await h.sentimentEngine.getLatestMacro();
    } catch (error) {
      elizaLogger.error(`[Brain] Macro read failed: ${String((error as any)?.message ?? error)}`);
      return null;
    }
  }

  /** Latest enriched news rows, newest first. [] when unavailable. */
  async getLatestNews(limit = 10): Promise<unknown[]> {
    const h = await handles();
    if (!h?.brain?.getLatestEnrichedNews) return [];
    try {
      // ctx comes from the host so the drizzle instance — and its TLS and timeout settings —
      // is the one brainContext built, not something reinvented here.
      return await h.brain.getLatestEnrichedNews(h.ctx, limit);
    } catch (error) {
      elizaLogger.error(`[Brain] News read failed: ${String((error as any)?.message ?? error)}`);
      return [];
    }
  }

  override async stop(): Promise<void> {
    // Nothing to release: the pool belongs to the host, which owns its lifecycle.
  }
}
