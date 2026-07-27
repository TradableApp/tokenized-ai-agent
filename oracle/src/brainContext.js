/**
 * Oracle-side Brain wiring — Phase 2 of the Oracle Brain migration
 * (CU-86d3dwme6). Reads the shared warm cache (Cloud SQL Postgres, kept warm
 * by the Social body) via `@tradableapp/sense-ai-brain` and renders the same
 * macro + news context blocks the Social body injects, plus the source list
 * for the answer MessageFile's `sources[]`.
 *
 * Design constraints (see .claude/PRPs/plans/oracle-brain-migration.md):
 * - READ-ONLY, per prompt: never fetch from data providers inline in the TEE.
 * - Degrade to null: a missing config (localnet e2e has no Cloud SQL) or a DB
 *   blip must suppress the context, never fail the answer path.
 * - No `ctx.ai`: the oracle omits the AI capability — enrichment belongs to
 *   the Social body.
 */
const { bootstrapPostgresFromEnv, isPostgresConfigured } = require("./postgresBootstrap");

const NEWS_LIMIT = 6;
const QUERY_TIMEOUT_MS = 3000;

// Lazy singleton — the pool/engine survive across prompts. The IN-FLIGHT
// promise is memoized (not just the resolved value): prompts run through a
// p-queue with concurrency 5, and without this, concurrent first prompts
// would each build their own pg Pool and orphan all but the last.
let initPromise = null; // Promise<{ brain, ctx, sentimentEngine } | "disabled">
let overrides = {};

function _setTestOverrides(next) {
  overrides = next || {};
}

function _resetForTests() {
  initPromise = null;
  overrides = {};
}

function isConfigured() {
  if (process.env.BRAIN_CONTEXT_ENABLED === "false") return false;
  // Base keys AND certs both count as "configured" (see isPostgresConfigured) —
  // otherwise every prompt would retry the bootstrap and fail noisily until the
  // env is complete. Shared with the agent-DB wiring so the two can't drift.
  return isPostgresConfigured();
}

async function defaultLoadBrain() {
  return import("@tradableapp/sense-ai-brain");
}

function defaultCreateDb() {
  // The Brain cache lives in the shared `senseai` DB. Build ITS url explicitly and
  // with `writeEnv: false` — plugin-sql owns process.env.POSTGRES_URL, pointed at the
  // oracle's separate `oracle_agent` DB, so we must neither read NOR write that
  // shared var here (writing it would repoint the agent runtime at the cache DB the
  // next time plugin-sql's global pool is recreated).
  const cacheUrl = bootstrapPostgresFromEnv({
    database: process.env.POSTGRES_DATABASE,
    writeEnv: false,
  });
  // Lazy requires so localnet/e2e runs (no Brain context) never load pg.
  const { Pool } = require("pg");
  const { drizzle } = require("drizzle-orm/node-postgres");
  const pool = new Pool({
    connectionString: cacheUrl,
    max: 3,
    connectionTimeoutMillis: QUERY_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
    statement_timeout: QUERY_TIMEOUT_MS,
  });
  return drizzle(pool);
}

function init() {
  if (!initPromise) {
    initPromise = doInit().catch((error) => {
      // A failed init may be a fixable config problem — allow the next prompt
      // to retry. (Post-init read failures do NOT reset — see getMarketContext.)
      initPromise = null;
      throw error;
    });
  }
  return initPromise;
}

async function doInit() {
  if (!isConfigured()) {
    console.log(
      "[BrainContext] Postgres config absent or BRAIN_CONTEXT_ENABLED=false — market context disabled.",
    );
    return "disabled";
  }

  const loadBrain = overrides.loadBrain ?? defaultLoadBrain;
  const createDb = overrides.createDb ?? defaultCreateDb;

  const brain = await loadBrain();
  const ctx = {
    db: createDb(),
    settings: { get: (key) => process.env[key] },
    logger: {
      debug: (msg, ...args) => console.debug(msg, ...args),
      info: (msg, ...args) => console.log(msg, ...args),
      warn: (msg, ...args) => console.warn(msg, ...args),
      error: (msg, ...args) => console.error(msg, ...args),
    },
    // No `ai` — Oracle-body mode: the Brain skips enrichment and we only read.
  };

  return {
    brain,
    ctx,
    sentimentEngine: new brain.SentimentEngine(ctx),
  };
}

/**
 * Reads the warm cache and renders the LLM-facing market context.
 * @returns {Promise<{contextText: string, sources: Array<{title: string, url: string}>} | null>}
 */
async function getMarketContext() {
  try {
    const state = await init();
    if (state === "disabled") return null;

    const { brain, ctx, sentimentEngine } = state;

    const [macro, news] = await Promise.all([
      sentimentEngine.getLatestMacro(),
      brain.getLatestEnrichedNews(ctx, NEWS_LIMIT),
    ]);

    const blocks = [];
    if (macro) {
      blocks.push(brain.formatMacroEnvironment(macro));
    }
    if (news.length > 0) {
      blocks.push(
        `### SOVEREIGN MARKET INTELLIGENCE (Warm Cache)\n${brain.formatNewsTicker(news)}`,
      );
    }

    if (blocks.length === 0) return null;

    return {
      contextText: blocks.join("\n\n"),
      sources: news.filter((n) => n.title && n.url).map((n) => ({ title: n.title, url: n.url })),
    };
  } catch (error) {
    // Never fail the answer path over context — log and answer without it.
    // The initialized client is kept: a transient read/format failure must not
    // orphan a live pg Pool (init failures reset themselves in init()).
    console.error(`[BrainContext] Market context unavailable: ${String(error?.message ?? error)}`);
    return null;
  }
}

module.exports = { getMarketContext, _setTestOverrides, _resetForTests };
