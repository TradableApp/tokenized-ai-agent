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

  it("returns null when base keys are set but no cert source is configured", async () => {
    process.env.POSTGRES_HOST = "10.0.0.5";
    process.env.POSTGRES_PORT = "5432";
    process.env.POSTGRES_DATABASE = "senseai";
    process.env.POSTGRES_USER = "senseai";
    process.env.POSTGRES_PASSWORD = "pw";
    let brainLoads = 0;
    brainContext._setTestOverrides({
      createDb: () => ({}),
      loadBrain: async () => {
        brainLoads++;
        throw new Error("must not be reached");
      },
    });

    const result = await brainContext.getMarketContext();
    expect(result).to.equal(null);
    expect(brainLoads).to.equal(0);
  });

  it("concurrent calls share ONE initialization (no pg Pool leak under p-queue concurrency)", async () => {
    setFullEnv();
    let dbCreations = 0;
    brainContext._setTestOverrides({
      createDb: () => {
        dbCreations++;
        return {};
      },
      loadBrain: async () => {
        await new Promise((r) => setTimeout(r, 20));
        return {
          SentimentEngine: class {
            async getLatestMacro() {
              return null;
            }
          },
          getLatestEnrichedNews: async () => [],
          formatMacroEnvironment: () => "",
          formatNewsTicker: () => "",
        };
      },
    });

    await Promise.all([
      brainContext.getMarketContext(),
      brainContext.getMarketContext(),
      brainContext.getMarketContext(),
    ]);
    expect(dbCreations).to.equal(1);
  });

  it("a transient read failure returns null WITHOUT tearing down the initialized client", async () => {
    setFullEnv();
    let dbCreations = 0;
    let reads = 0;
    brainContext._setTestOverrides({
      createDb: () => {
        dbCreations++;
        return {};
      },
      loadBrain: async () => ({
        SentimentEngine: class {
          async getLatestMacro() {
            reads++;
            if (reads === 1) throw new Error("transient blip");
            return { fearGreedIndex: 50, fearGreedClassification: "Neutral" };
          }
        },
        getLatestEnrichedNews: async () => [],
        formatMacroEnvironment: () => "### MACRO MARKET ENVIRONMENT",
        formatNewsTicker: () => "",
      }),
    });

    expect(await brainContext.getMarketContext()).to.equal(null);
    const second = await brainContext.getMarketContext();
    expect(second).to.be.an("object");
    expect(dbCreations).to.equal(1);
  });

  it("builds contextText and sources from the warm cache via the Brain", async () => {
    setFullEnv();

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
    setFullEnv();

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
