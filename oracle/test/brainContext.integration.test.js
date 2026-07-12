const { expect } = require("chai");

// Real-Brain integration test — Phase-2 acceptance (CU-86d3dwme6).
//
// The unit test (brainContext.test.js) mocks the Brain entirely (loadBrain →
// fake), so it only proves getMarketContext's ORCHESTRATION + degradation. The
// Brain's own seam tests exercise the engines/formatters in isolation (bun,
// against the SOURCE). Neither drives the *built* @tradableapp/sense-ai-brain
// dist THROUGH the oracle's getMarketContext.
//
// This test closes that gap: it runs the REAL Brain dist (loadBrain is NOT
// overridden) against a seeded warm cache and asserts the real engines +
// formatters render the exact LLM-facing macro/news context + sources[] the
// oracle injects. It validates that the compiled dist is consumable from the
// Node/CommonJS oracle and produces the expected shape end-to-end.

const brainContext = require("../src/brainContext");
const { clearPostgresEnv, setFullPostgresEnv } = require("./helpers/postgresTestEnv");

// getMarketContext passes NEWS_LIMIT (6) to getLatestEnrichedNews; getLatestMacro
// takes the single newest row (limit 1). Asserting the observed limits below turns
// the stub into a real regression guard against those query shapes changing.
const EXPECTED_MACRO_LIMIT = 1;
const EXPECTED_NEWS_LIMIT = 6;

// Seeded warm cache. Two reads hit ctx.db.select():
//   - getLatestMacro():        select().from(macro).orderBy().limit(1)      — NO .where()
//   - getLatestEnrichedNews(): select().from(news).where(isNotNull).orderBy().limit(6)
// Route each read by whether .where() was called — identity-free, because the
// shared schema is raw TS and cannot be required from Node to compare tables.
// The observed limit for each read is captured on `db.observedLimits` so tests
// can assert the production query still uses the expected limit.
function seededStubDb({ macroRows, newsRows }) {
  const observedLimits = { macro: undefined, news: undefined };
  const makeChain = () => {
    let hasWhere = false;
    const chain = {
      from: () => chain,
      where: () => {
        hasWhere = true;
        return chain;
      },
      orderBy: () => chain,
      limit: (n) => {
        observedLimits[hasWhere ? "news" : "macro"] = n;
        return Promise.resolve(hasWhere ? newsRows : macroRows);
      },
    };
    return chain;
  };
  const db = { select: () => makeChain() };
  db.observedLimits = observedLimits;
  return db;
}

// A stored macro snapshot row (shape per macroSentimentHistoryTable → GlobalMacroData).
const MACRO_ROW = {
  globalFearGreed: { value: 71, classification: "Greed" },
  btcDominance: "54.32",
  ethDominance: "17.01",
  trendingWords: ["etf", "halving"],
  metadata: { moneySupply: 21000, dailyEtfFlow: 125000000 },
  recordedAt: new Date(),
};

// Enriched market_news rows (newest first; both have a TLDR so they survive the
// isNotNull(tldr) filter). First prefers metadata.original_source; second falls
// back to the provider name.
const NEWS_ROWS = [
  {
    title: "BTC breaks range",
    tldr: "Structure shifted on ETF inflows.",
    url: "https://example.com/a",
    provider: "coindesk",
    metadata: { original_source: "CoinDesk" },
    publishedAt: new Date(),
  },
  {
    title: "ETH upgrade ships",
    tldr: "Fees drop post-upgrade.",
    url: "https://example.com/b",
    provider: "cryptopanic",
    metadata: {},
    publishedAt: new Date(Date.now() - 1000),
  },
];

describe("brainContext ↔ real Brain integration (seeded warm cache)", () => {
  // This suite depends on the built Brain dist (git submodule at
  // oracle/packages/sense-ai-brain, prepare:brain). CI checks it out + builds it;
  // a fresh local clone without --recurse-submodules won't have it, and
  // getMarketContext would swallow the import error and return null — surfacing
  // as a misleading "expected null to be an object". Fail loudly + actionably
  // instead. NOT this.skip(): a broken dist in CI must still fail the suite.
  before(async () => {
    try {
      await import("@tradableapp/sense-ai-brain");
    } catch (error) {
      throw new Error(
        "Brain dist not loadable — the @tradableapp/sense-ai-brain submodule is " +
          "missing or unbuilt. Run `git submodule update --init --recursive` then " +
          `\`bun run prepare:brain\` from the repo root. Underlying error: ${error?.message ?? error}`,
      );
    }
  });

  beforeEach(() => {
    clearPostgresEnv();
    brainContext._resetForTests();
  });

  afterEach(() => {
    clearPostgresEnv();
    brainContext._resetForTests();
  });

  it("renders real macro + news context and sources from the seeded cache via the REAL Brain dist", async () => {
    setFullPostgresEnv();
    // loadBrain intentionally NOT overridden → the real dist runs.
    const db = seededStubDb({ macroRows: [MACRO_ROW], newsRows: NEWS_ROWS });
    brainContext._setTestOverrides({ createDb: () => db });

    const result = await brainContext.getMarketContext();

    expect(result).to.be.an("object");
    // Real formatMacroEnvironment block:
    expect(result.contextText).to.include("### MACRO MARKET ENVIRONMENT");
    expect(result.contextText).to.include("Global Fear & Greed: 71/100 (Greed)");
    expect(result.contextText).to.include("BTC Dominance: 54.32%");
    expect(result.contextText).to.include("ETH Dominance: 17.01%");
    // Oracle warm-cache news header + real formatNewsTicker bullets/SIGNAL:
    expect(result.contextText).to.include("### SOVEREIGN MARKET INTELLIGENCE (Warm Cache)");
    expect(result.contextText).to.include("• BTC breaks range (Source: CoinDesk)");
    expect(result.contextText).to.include("SIGNAL: Structure shifted on ETF inflows.");
    // metadata.original_source absent → provider name is the source label:
    expect(result.contextText).to.include("• ETH upgrade ships (Source: cryptopanic)");
    // sources[] carries the answer MessageFile's citations:
    expect(result.sources).to.deep.equal([
      { title: "BTC breaks range", url: "https://example.com/a" },
      { title: "ETH upgrade ships", url: "https://example.com/b" },
    ]);
    // The production queries still request the expected row counts — guards
    // against a dropped/changed limit() silently widening the warm-cache read.
    expect(db.observedLimits.macro).to.equal(EXPECTED_MACRO_LIMIT);
    expect(db.observedLimits.news).to.equal(EXPECTED_NEWS_LIMIT);
  });

  it("omits the macro block but still returns news + sources when the macro cache is empty", async () => {
    setFullPostgresEnv();
    brainContext._setTestOverrides({
      createDb: () => seededStubDb({ macroRows: [], newsRows: NEWS_ROWS }),
    });

    const result = await brainContext.getMarketContext();

    expect(result).to.be.an("object");
    expect(result.contextText).to.not.include("MACRO MARKET ENVIRONMENT");
    expect(result.contextText).to.include("### SOVEREIGN MARKET INTELLIGENCE (Warm Cache)");
    expect(result.sources).to.have.length(2);
  });

  it("returns null when the seeded cache is entirely empty (no macro, no news)", async () => {
    setFullPostgresEnv();
    brainContext._setTestOverrides({
      createDb: () => seededStubDb({ macroRows: [], newsRows: [] }),
    });

    expect(await brainContext.getMarketContext()).to.equal(null);
  });
});
