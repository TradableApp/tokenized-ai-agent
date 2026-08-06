import { elizaLogger, type IAgentRuntime, Service } from "@elizaos/core";

/**
 * Owns this body's access to the shared analytical Brain.
 *
 * WHY A SERVICE, and why it does not use `createBrainContext(runtime)` the way sense-ai-core
 * does. Core's `plugin-sql` is wired to the SHARED `senseai` database, so its providers can
 * build a BrainContext straight off the runtime. This oracle deliberately runs an ISOLATED
 * agent database (`oracle_agent` — see wireAgentDb), so a runtime-derived context would query
 * the wrong database and return no warm-cache rows *while looking perfectly healthy*. The
 * connection to the shared cache therefore lives here, and providers reach it the ElizaOS way
 * via `runtime.getService("brain")`.
 *
 * READ-ONLY BY DESIGN. The Social body keeps the cache warm on a schedule; the oracle only
 * reads it, per prompt. No periodic collection runs here — that stays core's job, so the two
 * bodies never double-spend on provider APIs and nothing slow blocks the on-chain answer path.
 *
 * DEGRADES, NEVER THROWS. Localnet e2e has no Cloud SQL at all, and a provider that throws
 * fails `composeState` for the whole turn. Every read returns null/[] when the Brain is
 * unconfigured or the database blips, so the oracle answers without context rather than not at
 * all.
 */
export class BrainService extends Service {
  static serviceType = "brain";

  override capabilityDescription =
    "Read access to the shared SenseAI Brain warm cache (macro + enriched news).";

  /** Brain module namespace, loaded lazily — it ships ESM and this bundle is consumed by CJS. */
  private brain: any = null;
  private ctx: any = null;
  private sentimentEngine: any = null;
  private pool: any = null;

  static async start(runtime: IAgentRuntime): Promise<BrainService> {
    const service = new BrainService(runtime);
    await service.init(runtime);
    return service;
  }

  /** Config presence check — mirrors brainContext.js's isConfigured(). */
  private static isConfigured(get: (k: string) => string | undefined): boolean {
    return Boolean(get("POSTGRES_HOST") && get("POSTGRES_DATABASE") && get("POSTGRES_USER"));
  }

  private async init(runtime: IAgentRuntime): Promise<void> {
    const get = (k: string) => (runtime.getSetting(k) as string | undefined) ?? process.env[k];

    if (!BrainService.isConfigured(get)) {
      // Not an error: localnet e2e runs without Cloud SQL. Stay registered and inert so the
      // providers resolve a service and return empty context rather than blowing up the turn.
      elizaLogger.info("[Brain] Postgres config absent — warm-cache reads disabled.");
      return;
    }

    try {
      const { Pool } = await import("pg");
      const brain = await import("@tradableapp/sense-ai-brain");

      this.pool = new Pool({
        host: get("POSTGRES_HOST"),
        port: Number(get("POSTGRES_PORT") ?? 5432),
        database: get("POSTGRES_DATABASE"),
        user: get("POSTGRES_USER"),
        password: get("POSTGRES_PASSWORD"),
        max: 2,
      });

      // The framework-agnostic seam the Brain expects. `settings` resolves through the runtime
      // first so ROFL-injected secrets are honoured, falling back to the process env.
      this.ctx = {
        db: this.pool,
        settings: { get },
        logger: elizaLogger,
      };
      this.brain = brain;
      this.sentimentEngine = new brain.SentimentEngine(this.ctx);
      elizaLogger.info("[Brain] Warm-cache reads enabled.");
    } catch (error) {
      // Deliberately swallowed: a Brain that fails to load must not stop the oracle answering.
      elizaLogger.error(
        `[Brain] Initialisation failed — continuing without market context: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.brain = null;
      this.sentimentEngine = null;
    }
  }

  /** True when warm-cache reads are available. */
  isReady(): boolean {
    return Boolean(this.brain && this.sentimentEngine);
  }

  /** Latest global macro row, or null when unavailable. */
  async getLatestMacro(): Promise<unknown | null> {
    if (!this.isReady()) return null;
    return this.sentimentEngine.getLatestMacro();
  }

  /** Latest enriched news rows, newest first. [] when unavailable. */
  async getLatestNews(limit = 10): Promise<unknown[]> {
    if (!this.isReady()) return [];
    return this.brain.getLatestEnrichedNews(this.ctx, limit);
  }

  /** The Brain's own formatters, so both bodies render byte-identical context blocks. */
  formatMacro(macroState: unknown): string {
    return this.brain.formatMacroEnvironment(macroState);
  }

  formatNews(rows: unknown[]): string {
    return this.brain.formatNewsTicker(rows);
  }

  override async stop(): Promise<void> {
    if (this.pool) {
      await this.pool.end().catch(() => {});
      this.pool = null;
    }
  }
}
