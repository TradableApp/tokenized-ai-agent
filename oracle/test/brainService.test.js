const path = require("node:path");

const { expect } = require("chai");

// BrainService — the oracle's adapter onto the shared Brain. CU-86d3ud1va, part 2.
//
// WHY THIS FILE EXISTS. The provider tests stub the service wholesale
// (`{ brain: { getLatestMacro } }`), so the service's own wiring had ZERO coverage — which is
// exactly how it shipped, briefly, building its own `pg.Pool` with no TLS, no timeouts, and a
// raw Pool passed as `ctx.db` where the Brain's `BrainDatabase = NodePgDatabase` requires a
// drizzle instance. That last one is a runtime failure no provider test could ever see.
//
// WHY IT IS NOW AN ADAPTER. The Brain's connection is a HOST concern, not a plugin one:
// oracle/src/brainContext.js already builds it correctly via
// `bootstrapPostgresFromEnv({ writeEnv: false })` — carrying the mTLS cert params Cloud SQL
// requires under TRUSTED_CLIENT_CERTIFICATE_REQUIRED, wrapping the pool in drizzle, and setting
// connection/query/statement timeouts so a hung query cannot stall an on-chain answer. The
// plugin cannot reuse that helper without dragging oracle/src internals into its bundle, and
// duplicating it is what produced the bug. So the host injects an accessor and the service
// delegates.
//
// `writeEnv: false` is the subtlety worth not rediscovering: plugin-sql owns
// process.env.POSTGRES_URL pointed at the ISOLATED oracle_agent DB, so writing it would repoint
// the agent runtime at the cache DB.

const DIST = path.resolve(__dirname, "../src/elizaos/plugins/plugin-senseai/dist/index.js");

describe("BrainService (host-injected adapter)", () => {
  let plugin;
  let setBrainAccessor;
  let BrainService;

  before(() => {
    const mod = require(DIST);
    plugin = mod.default;
    setBrainAccessor = mod.setBrainAccessor;
    BrainService = (plugin.services || [])[0];
  });

  afterEach(() => {
    setBrainAccessor(null);
  });

  it("exposes the host-injection seam", () => {
    expect(setBrainAccessor, "the host must be able to supply the Brain handles").to.be.a(
      "function",
    );
    expect(BrainService, "the service must still be registered").to.exist;
  });

  it("delegates macro reads to the host's Brain handles", async () => {
    const macroState = { fearGreedClassification: "Greed" };
    setBrainAccessor(async () => ({
      sentimentEngine: { getLatestMacro: async () => macroState },
      brain: {},
      ctx: {},
    }));

    const svc = await BrainService.start({ getSetting: () => undefined });
    expect(await svc.getLatestMacro()).to.deep.equal(macroState);
  });

  it("delegates news reads, passing the Brain's own ctx", async () => {
    // The Brain takes ctx explicitly for news; passing the host's ctx is what keeps the drizzle
    // instance (and its TLS/timeout configuration) in play rather than something reinvented here.
    const ctx = { marker: "host-ctx" };
    let sawCtx = null;
    setBrainAccessor(async () => ({
      sentimentEngine: {},
      ctx,
      brain: {
        getLatestEnrichedNews: async (passedCtx, limit) => {
          sawCtx = passedCtx;
          return [{ title: "n", url: "https://x.test/n", limit }];
        },
      },
    }));

    const svc = await BrainService.start({ getSetting: () => undefined });
    const rows = await svc.getLatestNews(7);

    expect(sawCtx).to.equal(ctx);
    expect(rows[0].limit).to.equal(7);
  });

  it("degrades to null/[] when the host supplies no Brain", async () => {
    // Localnet e2e has no Cloud SQL at all — that must cost the context, not the answer.
    setBrainAccessor(async () => null);
    const svc = await BrainService.start({ getSetting: () => undefined });

    expect(await svc.getLatestMacro()).to.equal(null);
    expect(await svc.getLatestNews()).to.deep.equal([]);
  });

  it("degrades when no accessor was ever injected", async () => {
    const svc = await BrainService.start({ getSetting: () => undefined });
    expect(await svc.getLatestMacro()).to.equal(null);
    expect(await svc.getLatestNews()).to.deep.equal([]);
  });

  it("degrades when the host accessor throws", async () => {
    setBrainAccessor(async () => {
      throw new Error("cache unreachable");
    });
    const svc = await BrainService.start({ getSetting: () => undefined });

    expect(await svc.getLatestMacro()).to.equal(null);
    expect(await svc.getLatestNews()).to.deep.equal([]);
  });

  it("delegates news SEARCH, passing the host's ctx and the caller's options", async () => {
    const ctx = { marker: "host-ctx" };
    let sawCtx = null;
    let sawOpts = null;
    setBrainAccessor(async () => ({
      sentimentEngine: {},
      ctx,
      brain: {
        searchNewsDetails: async (passedCtx, opts) => {
          sawCtx = passedCtx;
          sawOpts = opts;
          return [{ title: "hit", url: "https://x.test/hit", similarity: 0.9 }];
        },
      },
    }));

    const svc = await BrainService.start({ getSetting: () => undefined });
    const opts = { query: "etf", tickers: ["BTC"], embedding: [0.1, 0.2] };
    const rows = await svc.searchNewsDetails(opts);

    expect(sawCtx, "the Brain's ctx must be the host's, not one reinvented here").to.equal(ctx);
    expect(sawOpts, "options must reach the Brain untouched").to.equal(opts);
    expect(rows[0].title).to.equal("hit");
  });

  it("PROPAGATES a search failure instead of degrading to []", async () => {
    // THE BILLING CONTRACT, and the reason this method breaks the pattern of every other read
    // on this service.
    //
    // `getLatestMacro` / `getLatestNews` feed PROVIDERS, where a throw fails composeState for
    // the whole turn — so degrading is right: the answer loses its market context and survives.
    //
    // This one feeds an ACTION, and the action already has its own try/catch that turns a
    // rejection into the graceful "Error accessing market ledger" result carrying
    // isBillable:false. Swallowing here would instead hand the action an EMPTY ARRAY, which is
    // indistinguishable from "we searched and found nothing" — the SUCCESS path, isBillable:true.
    //
    // On this body that mistake is not recoverable: EVMAIAgent.submitAnswer calls
    // aiAgentEscrow.finalizePayment in the SAME transaction, so storing the answer IS charging
    // for it. A Cloud SQL blip would bill the user, on-chain, for our own outage.
    setBrainAccessor(async () => ({
      sentimentEngine: {},
      ctx: {},
      brain: {
        searchNewsDetails: async () => {
          throw new Error("connection refused");
        },
      },
    }));

    const svc = await BrainService.start({ getSetting: () => undefined });

    let threw = null;
    try {
      await svc.searchNewsDetails({ query: "etf" });
    } catch (error) {
      threw = error;
    }

    expect(threw, "a failed search must reach the action, not look like an empty result").to.be.an(
      "error",
    );
    expect(threw.message).to.contain("connection refused");
  });

  it("throws the named error when the host supplies a brain but no ctx", async () => {
    // A half-built handle set — brainContext failing partway through its Postgres bootstrap —
    // used to sail past the guard, because only `brain.searchNewsDetails` was checked. The call
    // then failed deeper in as a driver error about an undefined connection.
    //
    // The billing contract held either way (the action's catch marks it non-billable), so this
    // is purely about which message an operator reads: "Brain unavailable" names the subsystem,
    // a drizzle stack trace does not.
    setBrainAccessor(async () => ({
      sentimentEngine: {},
      ctx: undefined,
      brain: {
        searchNewsDetails: async () => {
          throw new Error("should never be reached — ctx was undefined");
        },
      },
    }));

    const svc = await BrainService.start({ getSetting: () => undefined });

    let threw = null;
    try {
      await svc.searchNewsDetails({ query: "etf" });
    } catch (error) {
      threw = error;
    }

    expect(threw, "a missing ctx must be caught by the guard").to.be.an("error");
    expect(threw.message, "and must name the subsystem, not leak a driver error").to.contain(
      "Brain unavailable",
    );
  });

  it("throws rather than reporting 'no news' when the Brain is unavailable", async () => {
    // Same contract at the other end: no Brain is not evidence that no articles exist. Returning
    // [] here would answer "no significant records found" — a billable non-answer — when the
    // truth is that we never looked. sense-ai-core reaches the identical outcome by a different
    // route: its createBrainContext hands drizzle an undefined db, which throws.
    setBrainAccessor(async () => null);
    const svc = await BrainService.start({ getSetting: () => undefined });

    let threw = null;
    try {
      await svc.searchNewsDetails({ query: "etf" });
    } catch (error) {
      threw = error;
    }

    expect(threw, "an unavailable Brain must not masquerade as an empty ledger").to.be.an("error");
  });

  it("delegates asset-sentiment reads to the host's Brain engine", async () => {
    // The data half of ANALYZE_ASSET_SENTIMENT. Same delegation shape as the macro read above —
    // the engine is the host's, built once by brainContext against the shared cache, not the
    // isolated oracle_agent database plugin-sql points the runtime at.
    let sawArgs = null;
    const metrics = { mvrv_usd_30d: 1.4, _dataTimestamp: 1 };
    setBrainAccessor(async () => ({
      brain: {},
      ctx: {},
      sentimentEngine: {
        getAssetSentiment: async (symbol, forceRefresh) => {
          sawArgs = { symbol, forceRefresh };
          return metrics;
        },
      },
    }));

    const svc = await BrainService.start({ getSetting: () => undefined });

    expect(await svc.getAssetSentiment("BTC")).to.deep.equal(metrics);
    expect(sawArgs.symbol).to.equal("BTC");
    expect(sawArgs.forceRefresh, "core calls this with the default; so must we").to.equal(false);
  });

  it("forwards forceRefresh when the caller asks for it", async () => {
    let sawRefresh = null;
    setBrainAccessor(async () => ({
      brain: {},
      ctx: {},
      sentimentEngine: {
        getAssetSentiment: async (_symbol, forceRefresh) => {
          sawRefresh = forceRefresh;
          return null;
        },
      },
    }));

    const svc = await BrainService.start({ getSetting: () => undefined });
    await svc.getAssetSentiment("BTC", true);

    expect(sawRefresh).to.equal(true);
  });

  it("DEGRADES to null when the Brain is unavailable — the opposite of searchNewsDetails", async () => {
    // WHY THIS ONE MAY DEGRADE WHERE THE NEWS SEARCH MAY NOT. Both feed actions, so the reasoning
    // that makes searchNewsDetails throw looks like it should apply here too. It does not, and
    // the difference is in the ACTION, not the service.
    //
    // getNewsDetails has no per-item counter: an empty array is indistinguishable from "we
    // searched and found nothing", which is its SUCCESS path and bills. analyzeAssetSentiment
    // loops over tickers and sets `isBillable: successfulFetches > 0` — a null for every ticker
    // is already the non-billable outcome, by core's own rule, with no divergence needed.
    //
    // So null here costs the answer its data and nothing else, and it keeps the two bodies on
    // ONE billing rule. Throwing would put them on two.
    setBrainAccessor(async () => null);
    const svc = await BrainService.start({ getSetting: () => undefined });

    expect(await svc.getAssetSentiment("BTC")).to.equal(null);
  });

  it("degrades to null when the engine read fails", async () => {
    setBrainAccessor(async () => ({
      brain: {},
      ctx: {},
      sentimentEngine: {
        getAssetSentiment: async () => {
          throw new Error("connection refused");
        },
      },
    }));

    const svc = await BrainService.start({ getSetting: () => undefined });

    expect(await svc.getAssetSentiment("BTC")).to.equal(null);
  });

  it("owns no database connection of its own", async () => {
    // The regression guard for the bug that prompted this file: if the service ever grows its
    // own pool again it will diverge from brainContext's TLS, drizzle and timeout handling.
    const src = require("node:fs").readFileSync(
      path.resolve(__dirname, "../src/elizaos/plugins/plugin-senseai/src/services/brain.ts"),
      "utf8",
    );
    expect(src, "the pool belongs to the host, not the plugin").to.not.match(/new Pool\(/);
    expect(src, "importing pg here means a second, unconfigured connection").to.not.match(
      /from "pg"|require\("pg"\)/,
    );

    // The source guard alone left the loop open: `pg` stayed DECLARED in the plugin's
    // package.json long after the last import went away, which reads to the next maintainer as
    // permission to build a pool here again — the exact bug this file exists to prevent. A
    // dependency nothing imports is also weight shipped into the TEE image for nothing.
    const pkg = JSON.parse(
      require("node:fs").readFileSync(
        path.resolve(__dirname, "../src/elizaos/plugins/plugin-senseai/package.json"),
        "utf8",
      ),
    );
    expect(
      pkg.dependencies?.pg,
      "the plugin must not declare pg — the host owns the connection",
    ).to.equal(undefined);
  });
});
