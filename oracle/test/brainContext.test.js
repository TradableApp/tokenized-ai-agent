const { expect } = require("chai");

// Oracle-side Brain wiring — Phase 2 of the Oracle Brain migration
// (CU-86d3dwme6). The oracle READS the shared warm cache per prompt (the
// Social body keeps it warm); it never fetches from providers inline in the
// TEE, and it degrades to null (no context) rather than failing the answer
// path when Postgres/config is absent — localnet e2e has no Cloud SQL.

const brainContext = require("../src/brainContext");

function clearPostgresEnv() {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("POSTGRES_") || key === "BRAIN_CONTEXT_ENABLED") delete process.env[key];
  }
}

describe("brainContext (oracle Brain wiring)", () => {
  beforeEach(() => {
    clearPostgresEnv();
    brainContext._resetForTests();
  });

  afterEach(() => {
    clearPostgresEnv();
    brainContext._resetForTests();
  });

  it("returns null when Postgres config is absent (localnet / e2e mode)", async () => {
    const result = await brainContext.getMarketContext();
    expect(result).to.equal(null);
  });

  it("returns null when explicitly disabled even if config is present", async () => {
    process.env.POSTGRES_HOST = "10.0.0.5";
    process.env.BRAIN_CONTEXT_ENABLED = "false";
    const result = await brainContext.getMarketContext();
    expect(result).to.equal(null);
  });

  it("builds contextText and sources from the warm cache via the Brain", async () => {
    process.env.POSTGRES_HOST = "10.0.0.5";
    process.env.POSTGRES_PORT = "5432";
    process.env.POSTGRES_DATABASE = "senseai";
    process.env.POSTGRES_USER = "senseai";
    process.env.POSTGRES_PASSWORD = "pw";

    brainContext._setTestOverrides({
      createDb: () => ({}),
      loadBrain: async () => ({
        SentimentEngine: class {
          async getLatestMacro() {
            return { fearGreedIndex: 71, fearGreedClassification: "Greed" };
          }
        },
        getLatestEnrichedNews: async () => [
          { title: "BTC breaks range", tldr: "Structure shifted.", url: "https://example.com/a" },
          { title: "ETH upgrade ships", tldr: "Fees drop.", url: "https://example.com/b" },
        ],
        formatMacroEnvironment: () => "### MACRO MARKET ENVIRONMENT\n- Global Fear & Greed: 71/100 (Greed)",
        formatNewsTicker: (rows) => rows.map((r) => `• ${r.title}`).join("\n"),
      }),
    });

    const result = await brainContext.getMarketContext();

    expect(result).to.be.an("object");
    expect(result.contextText).to.include("MACRO MARKET ENVIRONMENT");
    expect(result.contextText).to.include("BTC breaks range");
    expect(result.sources).to.deep.equal([
      { title: "BTC breaks range", url: "https://example.com/a" },
      { title: "ETH upgrade ships", url: "https://example.com/b" },
    ]);
  });

  it("degrades to null when the warm-cache read throws (DB blip must not fail the answer)", async () => {
    process.env.POSTGRES_HOST = "10.0.0.5";
    process.env.POSTGRES_PORT = "5432";
    process.env.POSTGRES_DATABASE = "senseai";
    process.env.POSTGRES_USER = "senseai";
    process.env.POSTGRES_PASSWORD = "pw";

    brainContext._setTestOverrides({
      createDb: () => ({}),
      loadBrain: async () => {
        throw new Error("connection refused");
      },
    });

    const result = await brainContext.getMarketContext();
    expect(result).to.equal(null);
  });
});
