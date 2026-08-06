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
  });
});
