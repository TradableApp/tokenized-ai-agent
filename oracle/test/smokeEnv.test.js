const { expect } = require("chai");

// SMOKE_ENV default tables for the Base-testnet smoke (CU-14ym9bvdmjr). The same script has to
// serve base-mainnet later, so defaults live in a table keyed by environment and every explicit
// SMOKE_* variable wins over the table. Mainnet has no committed addresses yet: the table names
// what is REQUIRED and the resolver fails by variable name, never by value.

const { SMOKE_ENVS, resolveSmokeConfig } = require("../scripts/smoke/env.js");

const KEY_A = `0x${"11".repeat(32)}`;
const KEY_B = `0x${"22".repeat(32)}`;
const KEY_C = `0x${"33".repeat(32)}`;
const ORACLE_PUB = `04${"ab".repeat(64)}`;

describe("smoke: SMOKE_ENV tables", () => {
  it("base-testnet carries today's defaults", () => {
    const t = SMOKE_ENVS["base-testnet"];
    expect(t.rpcUrl).to.equal("https://sepolia.base.org");
    expect(t.chainId).to.equal(84532);
    expect(t.escrow).to.equal("0x36ec08471F2b995024967204D7542713cFaf5Fa4");
    expect(t.agent).to.equal("0x4a0C7e5807f9174499a8F56F2C69c61b39a4c64D");
    expect(t.token).to.equal("0xD77FF82e661C3838a59ea78bbF31F8c4c2BD8A80");
    expect(t.oraclePublicKey).to.match(/^0x04[0-9a-f]{128}$/);
  });

  it("base-mainnet carries the RPC and chain id only — addresses are required, not guessed", () => {
    const t = SMOKE_ENVS["base-mainnet"];
    expect(t.rpcUrl).to.equal("https://mainnet.base.org");
    expect(t.chainId).to.equal(8453);
    expect(t.escrow).to.equal(undefined);
    expect(t.agent).to.equal(undefined);
    expect(t.token).to.equal(undefined);
    expect(t.oraclePublicKey).to.equal(undefined);
  });
});

describe("smoke: resolveSmokeConfig", () => {
  it("defaults to base-testnet and fills every address from the table", () => {
    const c = resolveSmokeConfig({ SMOKE_PRIVATE_KEY: KEY_A });
    expect(c.envName).to.equal("base-testnet");
    expect(c.chainId).to.equal(84532);
    expect(c.escrow).to.equal(SMOKE_ENVS["base-testnet"].escrow);
    expect(c.oraclePublicKey).to.equal(SMOKE_ENVS["base-testnet"].oraclePublicKey);
    expect(c.privateKeys).to.deep.equal([KEY_A]);
    expect(c.burst).to.equal(1);
    expect(c.injection).to.equal(false);
    expect(c.prompt).to.equal("What is the latest news on Bitcoin?");
    expect(c.asset).to.equal("Bitcoin");
    expect(c.metricsFile).to.equal("smoke-metrics.json");
  });

  it("explicit SMOKE_* values win over the table", () => {
    const c = resolveSmokeConfig({
      SMOKE_PRIVATE_KEY: KEY_A,
      SMOKE_RPC_URL: "https://rpc.example/v2/k",
      SMOKE_CHAIN_ID: "84532",
      SMOKE_ESCROW_ADDRESS: "0x0000000000000000000000000000000000000001",
      SMOKE_ORACLE_PUBLIC_KEY: ORACLE_PUB,
      SMOKE_METRICS_FILE: "/tmp/run/smoke-metrics.json",
    });
    expect(c.rpcUrl).to.equal("https://rpc.example/v2/k");
    expect(c.escrow).to.equal("0x0000000000000000000000000000000000000001");
    expect(c.oraclePublicKey).to.equal(ORACLE_PUB);
    expect(c.metricsFile).to.equal("/tmp/run/smoke-metrics.json");
  });

  it("base-mainnet fails once, naming every missing variable and never echoing a value", () => {
    expect(() =>
      resolveSmokeConfig({ SMOKE_ENV: "base-mainnet", SMOKE_PRIVATE_KEY: KEY_A, SMOKE_RPC_URL: "https://rpc.example/v2/SECRET" }),
    ).to.throw((err) => {
      expect(err.message).to.include("SMOKE_ESCROW_ADDRESS");
      expect(err.message).to.include("SMOKE_AGENT_ADDRESS");
      expect(err.message).to.include("SMOKE_TOKEN_ADDRESS");
      expect(err.message).to.include("SMOKE_ORACLE_PUBLIC_KEY");
      expect(err.message).not.to.include("SECRET");
      expect(err.message).not.to.include(KEY_A);
      return true;
    });
  });

  it("rejects an unknown SMOKE_ENV by name and lists the known ones", () => {
    expect(() => resolveSmokeConfig({ SMOKE_ENV: "base-goerli", SMOKE_PRIVATE_KEY: KEY_A })).to.throw(/base-goerli.*base-testnet.*base-mainnet/s);
  });

  it("keeps the three-state SMOKE_ASSET rule: set-but-empty disables, custom prompt without asset means none", () => {
    expect(resolveSmokeConfig({ SMOKE_PRIVATE_KEY: KEY_A, SMOKE_ASSET: "" }).asset).to.equal(undefined);
    expect(resolveSmokeConfig({ SMOKE_PRIVATE_KEY: KEY_A, SMOKE_PROMPT: "Tell me about Solana" }).asset).to.equal(undefined);
    expect(resolveSmokeConfig({ SMOKE_PRIVATE_KEY: KEY_A, SMOKE_PROMPT: "Tell me about Solana", SMOKE_ASSET: "Solana" }).asset).to.equal("Solana");
  });

  describe("burst", () => {
    it("SMOKE_BURST=N needs N keys in SMOKE_PRIVATE_KEYS, one account per prompt", () => {
      const c = resolveSmokeConfig({ SMOKE_BURST: "3", SMOKE_PRIVATE_KEYS: `${KEY_A},${KEY_B}, ${KEY_C}` });
      expect(c.burst).to.equal(3);
      expect(c.privateKeys).to.deep.equal([KEY_A, KEY_B, KEY_C]);
    });

    it("fewer keys than the burst size fails by count, not by key", () => {
      expect(() => resolveSmokeConfig({ SMOKE_BURST: "3", SMOKE_PRIVATE_KEYS: `${KEY_A},${KEY_B}` })).to.throw((err) => {
        expect(err.message).to.match(/SMOKE_BURST=3.*2 key/s);
        expect(err.message).not.to.include(KEY_A.slice(2, 20));
        return true;
      });
    });

    it("SMOKE_PRIVATE_KEYS alone (no burst) means a single prompt from the first key", () => {
      const c = resolveSmokeConfig({ SMOKE_PRIVATE_KEYS: `${KEY_A},${KEY_B}` });
      expect(c.burst).to.equal(1);
      expect(c.privateKeys).to.deep.equal([KEY_A, KEY_B]);
    });

    it("rejects a non-integer or zero burst and a missing key", () => {
      expect(() => resolveSmokeConfig({ SMOKE_BURST: "0", SMOKE_PRIVATE_KEY: KEY_A })).to.throw(/SMOKE_BURST/);
      expect(() => resolveSmokeConfig({ SMOKE_BURST: "two", SMOKE_PRIVATE_KEY: KEY_A })).to.throw(/SMOKE_BURST/);
      expect(() => resolveSmokeConfig({})).to.throw(/SMOKE_PRIVATE_KEY/);
    });
  });

  it("SMOKE_INJECTION=1 (or true) switches the injection prompt on", () => {
    expect(resolveSmokeConfig({ SMOKE_PRIVATE_KEY: KEY_A, SMOKE_INJECTION: "1" }).injection).to.equal(true);
    expect(resolveSmokeConfig({ SMOKE_PRIVATE_KEY: KEY_A, SMOKE_INJECTION: "true" }).injection).to.equal(true);
    expect(resolveSmokeConfig({ SMOKE_PRIVATE_KEY: KEY_A, SMOKE_INJECTION: "0" }).injection).to.equal(false);
  });
});
