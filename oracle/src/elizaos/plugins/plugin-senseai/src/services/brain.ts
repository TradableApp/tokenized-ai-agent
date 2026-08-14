import { elizaLogger, type IAgentRuntime, Service } from "@elizaos/core";
// The Brain's OWN types for every read this service exposes. Typing them here rather than at the
// call sites is what lets the ported files stay literal copies of core's — core reaches the Brain
// directly and gets these types for free, so the oracle's adapter has to supply the same shape or
// the copied call sites would need casts core does not have.
//
// That rationale was written for the search boundary and then not applied to the other two reads:
// `getLatestMacro` and `getLatestNews` returned `unknown`, which forced three `as any` casts into
// the providers — `formatMacroEnvironment(macroState as any)`,
// `(macroState as any).fearGreedClassification`, `formatNewsTicker(latestNews as any)` — where
// core writes all three bare. Nothing about the oracle required them; the adapter was simply
// under-typed. Same lesson as CU-86d403h5a.
import type {
  AssetSentimentMetrics,
  EnrichedNewsRow,
  GlobalMacroData,
  NewsSearchHit,
  NewsSearchOptions,
} from "@tradableapp/sense-ai-brain";

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
 * PROVIDER reads degrade to null/[] rather than throwing: localnet e2e runs with no Cloud SQL at
 * all, and a provider that throws fails composeState for the entire turn.
 *
 * `searchNewsDetails` is the one exception, and the exception is the point — it backs an ACTION
 * whose empty result is a BILLABLE answer, so a swallowed failure would charge the user for our
 * outage. See the method for the full reasoning.
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

  /**
   * Latest global macro row, or null when unavailable.
   *
   * Typed with the Brain's OWN `GlobalMacroData`, not `unknown`. core's provider writes
   * `formatMacroEnvironment(macroState)` and `macroState.fearGreedClassification` bare; an
   * `unknown` return here forced this body to spell the identical lines with `as any`, which is
   * a divergence nothing about the oracle requires — the adapter was simply under-typed. Same
   * lesson as CU-86d403h5a, where casting onto a locally-restated shape hid the real contract.
   */
  async getLatestMacro(): Promise<GlobalMacroData | null> {
    const h = await handles();
    if (!h?.sentimentEngine?.getLatestMacro) return null;
    try {
      return (await h.sentimentEngine.getLatestMacro()) as GlobalMacroData | null;
    } catch (error) {
      elizaLogger.error(`[Brain] Macro read failed: ${String((error as any)?.message ?? error)}`);
      return null;
    }
  }

  /**
   * Per-asset on-chain / social metrics — the data half of ANALYZE_ASSET_SENTIMENT.
   *
   * NO try/catch, because core's adapter has none. core's is a bare delegate:
   *
   *   async getAssetSentiment(symbol, forceRefresh = false) {
   *     return this.engine.getAssetSentiment(symbol, forceRefresh);
   *   }
   *
   * so an engine throw reaches the ACTION's catch — byte-identical on both bodies — and yields
   * `{ success: false, isBillable: false }` with no observation and no synthesis.
   *
   * An earlier revision of this file caught the throw and returned `null`. That looked harmless
   * because all-null is already the non-billable outcome, but it forked the bodies on the paid
   * path: the same outage would have answered `success: true` with "this asset is unsupported or
   * lacks sufficient history" — a factual claim about the asset, made because our system broke —
   * and with a second ticker resolving it would have been BILLABLE where core charges nothing.
   *
   * The distinction that matters: `null` means UNSUPPORTED and is a real reading on both bodies;
   * a THROW means the ledger was unreachable and is not a reading at all. The engine currently
   * blurs the two (it swallows its own cache-read error and falls through to adapters) — that
   * conflation is core's and is tracked upstream as CU-86d40mckm rather than papered over here.
   *
   * Contrast `searchNewsDetails` below, which also propagates. Both adapters simply do what their
   * core counterpart does; neither is expressing a view about billing.
   *
   * `getLatestMacro` and `getLatestNews` still catch, and so still diverge from core's bare
   * delegates. They sit on the PROVIDER path rather than the action path, where a throw reaches
   * `composeState` on every turn instead of one action — a different blast radius that deserves a
   * decision rather than a copy of this fix. Tracked as CU-86d419bz0.
   *
   * @param symbol ticker, e.g. "BTC" — the engine upper-cases and strips `$`
   * @param forceRefresh skip the 23h cache and re-fetch from the adapters
   */
  async getAssetSentiment(
    symbol: string,
    forceRefresh = false,
  ): Promise<AssetSentimentMetrics | null> {
    const h = await handles();
    if (!h?.sentimentEngine?.getAssetSentiment) return null;

    // NO try/catch — core's adapter has none, and adding one here would fork the two bodies on
    // the paid path. See the note above.
    return await h.sentimentEngine.getAssetSentiment(symbol, forceRefresh);
  }

  /** Latest enriched news rows, newest first. [] when unavailable. See getLatestMacro on typing. */
  async getLatestNews(limit = 10): Promise<EnrichedNewsRow[]> {
    const h = await handles();
    if (!h?.brain?.getLatestEnrichedNews) return [];
    try {
      // ctx comes from the host so the drizzle instance — and its TLS and timeout settings —
      // is the one brainContext built, not something reinvented here.
      return (await h.brain.getLatestEnrichedNews(h.ctx, limit)) as EnrichedNewsRow[];
    } catch (error) {
      elizaLogger.error(`[Brain] News read failed: ${String((error as any)?.message ?? error)}`);
      return [];
    }
  }

  /**
   * Searches the enriched-news ledger — the data half of GET_NEWS_DETAILS.
   *
   * THIS ONE THROWS, and that is deliberate: it is the only read on this service that does.
   *
   * The methods above feed PROVIDERS, where a throw fails composeState for the entire turn, so
   * degrading to null/[] is correct — the answer loses its market context and still ships. This
   * one feeds an ACTION, and the action already owns a try/catch that turns a rejection into the
   * graceful "Error accessing market ledger" result carrying `isBillable: false`.
   *
   * Swallowing here would hand that action an EMPTY ARRAY instead, which is indistinguishable
   * from "we searched the ledger and found nothing" — the SUCCESS path, `isBillable: true`. On
   * this body that mistake is not recoverable: `EVMAIAgent.submitAnswer` calls
   * `aiAgentEscrow.finalizePayment` in the SAME transaction, so storing the answer IS charging
   * for it. A Cloud SQL blip would bill the user, on-chain, for our own outage.
   *
   * An unavailable Brain throws for the same reason: "we never looked" is not evidence that no
   * articles exist. sense-ai-core arrives at the identical behaviour by a different route — its
   * `createBrainContext` hands drizzle an undefined `db`, which throws.
   *
   * @param opts forwarded to the Brain verbatim: { query?, tickers?, embedding?, targetTitles? }
   */
  async searchNewsDetails(opts: NewsSearchOptions): Promise<NewsSearchHit[]> {
    const h = await handles();
    // `ctx` is checked alongside the function, not just the function. A host accessor that
    // returned a usable `brain` with a half-built `ctx` — brainContext failing partway through
    // its Postgres bootstrap — would otherwise sail past this guard and fail deeper in, as a
    // driver error about an undefined connection. The billing contract holds either way (the
    // action's catch still marks it non-billable), so this is purely about which message an
    // operator reads at 3am: "Brain unavailable" names the subsystem, a drizzle stack trace does
    // not.
    if (!h?.ctx || !h?.brain?.searchNewsDetails) {
      throw new Error(
        "Brain unavailable — cannot search the news ledger. Refusing to report an empty result " +
          "for a search that never ran.",
      );
    }
    // No try/catch on purpose — see above. The ctx comes from the host so the drizzle instance,
    // its TLS and its timeouts are the ones brainContext built.
    return await h.brain.searchNewsDetails(h.ctx, opts);
  }

  override async stop(): Promise<void> {
    // Nothing to release: the pool belongs to the host, which owns its lifecycle.
  }
}
