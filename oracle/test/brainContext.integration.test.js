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

function clearPostgresEnv() {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("POSTGRES_") || key === "BRAIN_CONTEXT_ENABLED") delete process.env[key];
  }
}

function setFullEnv() {
  process.env.POSTGRES_HOST = "10.0.0.5";
  process.env.POSTGRES_PORT = "5432";
  process.env.POSTGRES_DATABASE = "senseai";
  process.env.POSTGRES_USER = "senseai";
  process.env.POSTGRES_PASSWORD = "pw";
  process.env.POSTGRES_CLIENT_CERT = "-----BEGIN CERTIFICATE-----";
  process.env.POSTGRES_CLIENT_KEY = "-----BEGIN PRIVATE KEY-----";
  process.env.POSTGRES_SERVER_CA_CERT = "-----BEGIN CERTIFICATE-----";
}

// Seeded warm cache. Two reads hit ctx.db.select():
//   - getLatestMacro():        select().from(macro).orderBy().limit(1)      — NO .where()
//   - getLatestEnrichedNews(): select().from(news).where(isNotNull).orderBy().limit(6)
// Route each read by whether .where() was called — identity-free, because the
// shared schema is raw TS and cannot be required from Node to compare tables.
function seededStubDb({ macroRows, newsRows }) {
  const makeChain = () => {
    let hasWhere = false;
    const chain = {
      from: () => chain,
      where: () => {
        hasWhere = true;
        return chain;
      },
      orderBy: () => chain,
      limit: () => Promise.resolve(hasWhere ? newsRows : macroRows),
    };
    return chain;
  };
  return { select: () => makeChain() };
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
  beforeEach(() => {
    clearPostgresEnv();
    brainContext._resetForTests();
  });

  afterEach(() => {
    clearPostgresEnv();
    brainContext._resetForTests();
  });

  it("renders real macro + news context and sources from the seeded cache via the REAL Brain dist", async () => {
    setFullEnv();
    // loadBrain intentionally NOT overridden → the real dist runs.
    brainContext._setTestOverrides({
      createDb: () => seededStubDb({ macroRows: [MACRO_ROW], newsRows: NEWS_ROWS }),
    });

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
  });

  it("omits the macro block but still returns news + sources when the macro cache is empty", async () => {
    setFullEnv();
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
    setFullEnv();
    brainContext._setTestOverrides({
      createDb: () => seededStubDb({ macroRows: [], newsRows: [] }),
    });

    expect(await brainContext.getMarketContext()).to.equal(null);
  });
});
