const { expect } = require("chai");

const { validateConfig, ConfigError } = require("../src/startupConfig");

// Startup config validation — CU-86d3z0r81, harness port 1.5.
//
// THE FAILURES THIS EXISTS FOR, both observed on base-testnet:
//
//   1. AI_AGENT_CONTRACT_ADDRESS left at the `0xYour…Here` placeholder. ethers does NOT fail
//      fast on this — `new ethers.Contract(addr, abi, provider)` constructs fine and defers
//      resolution, so the first call surfaces as "contract runner does not support name
//      resolution". That message names no variable, points at no file, and reads like an
//      ethers/provider bug rather than a config typo.
//
//   2. AUTONOMYS_API_KEY / IRYS_PAYMENT_PRIVATE_KEY are read lazily INSIDE the storage layer,
//      at upload time. So a missing credential does not fail at boot — it fails after the
//      prompt has been decrypted, answered, and CHARGED FOR on-chain, leaving the user with a
//      debited escrow and no MessageFile. That is the expensive shape of this bug.
//
// Both are boot-time-knowable. The rule here is: refuse to start, and name the variable.

/** Minimum env for a valid Base testnet oracle with mock storage. */
function baseEnv(overrides = {}) {
  return {
    // "baseSepolia", not "base-testnet" — the latter is the ENV FILE naming convention
    // (.env.oracle.base-testnet), while NETWORK_NAME carries the RPC_URL_MAP key. The deployed
    // compose files use NETWORK_NAME=baseSepolia and NETWORK_NAME=base. This fixture had the
    // wrong one until the allowlist check caught it.
    NETWORK_NAME: "baseSepolia",
    PRIVATE_KEY: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    AI_AGENT_CONTRACT_ADDRESS: "0x4a0C7e5807f9174499a8F56F2C69c61b39a4c64D",
    USE_MOCK_STORAGE: "true",
    ...overrides,
  };
}

describe("startup config validation", () => {
  it("accepts a complete configuration", () => {
    expect(() => validateConfig(baseEnv())).to.not.throw();
  });

  it("names the variable that is missing", () => {
    // The whole point. "Cannot read properties of undefined" tells an operator nothing.
    try {
      validateConfig(baseEnv({ AI_AGENT_CONTRACT_ADDRESS: undefined }));
      expect.fail("expected a ConfigError");
    } catch (err) {
      expect(err).to.be.instanceOf(ConfigError);
      expect(err.message).to.include("AI_AGENT_CONTRACT_ADDRESS");
    }
  });

  it("reports EVERY problem at once, not one per restart", () => {
    // A guard that surfaces one variable at a time turns a five-variable misconfiguration into
    // five deploy cycles. In a TEE, each of those is an image build, an on-chain update and a
    // restart — so batching is not a nicety.
    try {
      validateConfig({ USE_MOCK_STORAGE: "true" });
      expect.fail("expected a ConfigError");
    } catch (err) {
      expect(err.message).to.include("NETWORK_NAME");
      expect(err.message).to.include("PRIVATE_KEY");
      expect(err.message).to.include("AI_AGENT_CONTRACT_ADDRESS");
    }
  });

  it("rejects the placeholder contract address", () => {
    // THE ENS BUG. ethers constructs a Contract with this happily and fails asynchronously
    // later with "contract runner does not support name resolution" — a message that names
    // neither the variable nor the value. Anything that is not a well-formed address is
    // treated by ethers as an ENS name, which is why the error looks so unrelated.
    try {
      validateConfig(baseEnv({ AI_AGENT_CONTRACT_ADDRESS: "0xYourAIAgentAddressHere" }));
      expect.fail("expected a ConfigError");
    } catch (err) {
      expect(err.message).to.include("AI_AGENT_CONTRACT_ADDRESS");
      expect(err.message.toLowerCase()).to.match(/placeholder|not a valid address/);
    }
  });

  it("accepts every key shape ethers itself accepts", () => {
    // CAUGHT ONE STEP BEFORE A TEE OUTAGE. The deployed .env.oracle.base-testnet carries the key
    // WITHOUT a 0x prefix, and ethers accepts that form — but the first version of this guard
    // demanded the prefix, so it would have refused to boot a configuration that works.
    //
    // Asserted against ethers directly rather than against an assumption about ethers, because
    // the assumption is what failed. The rule is "validate exactly what the consumer accepts",
    // and here that means looser, not stricter — a guard that blocks a valid config is an outage
    // of its own making.
    const { ethers } = require("ethers");
    const bare = "65de179c59e589cd6238" + "0".repeat(36) + "d28bf6ee";

    for (const key of [bare, `0x${bare}`]) {
      expect(() => new ethers.Wallet(key), `ethers should accept ${key.slice(0, 6)}…`).to.not.throw();
      expect(
        () => validateConfig(baseEnv({ PRIVATE_KEY: key })),
        `guard must accept what ethers accepts: ${key.slice(0, 6)}…`,
      ).to.not.throw();
    }
  });

  it("rejects a malformed private key", () => {
    // Same class as the address check, and the reason the guard is invoked from index.js BEFORE
    // aiAgentOracle is required: that module constructs an ethers Wallet at module scope, so a
    // bad key throws during `require` — earlier than any guard inside start() could name it.
    for (const bad of ["0xabc", "not-a-key", "0x" + "z".repeat(64)]) {
      try {
        validateConfig(baseEnv({ PRIVATE_KEY: bad }));
        expect.fail(`expected a ConfigError for ${bad}`);
      } catch (err) {
        expect(err.message).to.include("PRIVATE_KEY");
      }
    }
  });

  it("says PLACEHOLDER, not 'bad format', for a copied example key", () => {
    // The actual value in .env.oracle.example. "is not a 32-byte hex key" describes the symptom
    // and hides the cause — an operator reads it as a formatting problem and goes looking for
    // the wrong thing. Same treatment the address placeholder already got.
    try {
      validateConfig(baseEnv({ PRIVATE_KEY: "your_funding_wallet_private_key_here" }));
      expect.fail("expected a ConfigError");
    } catch (err) {
      expect(err.message).to.include("PRIVATE_KEY");
      expect(err.message).to.match(/placeholder/i);
      expect(err.message).to.not.match(/not a 32-byte hex/i);
    }
  });

  it("rejects an unsupported NETWORK_NAME rather than failing downstream", () => {
    // Same class as the placeholder address: accepted here, rejected somewhere else.
    // contractUtility does throw a readable error for it, but one at a time and at module load,
    // so it costs a restart per typo instead of joining the single report.
    try {
      validateConfig(baseEnv({ NETWORK_NAME: "base-mainnett" }));
      expect.fail("expected a ConfigError");
    } catch (err) {
      expect(err.message).to.include("NETWORK_NAME");
      expect(err.message).to.include("baseSepolia");
    }
  });

  it("accepts every network contractUtility can actually run against", () => {
    // Imported, not restated — if a network is added to RPC_URL_MAP this follows automatically
    // instead of the guard rejecting a network the oracle supports.
    const { SUPPORTED_NETWORKS } = require("../src/contractUtility");
    for (const name of SUPPORTED_NETWORKS) {
      expect(() => validateConfig(baseEnv({ NETWORK_NAME: name })), name).to.not.throw();
    }
  });

  it("rejects a key or address padded with whitespace", () => {
    // contractUtility passes process.env STRAIGHT into new ethers.Wallet(...) and
    // new ethers.Contract(...) with no trim of its own, so validating a trimmed COPY would
    // approve bytes the consumer then rejects — reproducing the opaque ethers error this guard
    // exists to replace. A leading space from a compose-file quoting mistake is the usual shape.
    for (const env of [
      baseEnv({ PRIVATE_KEY: ` 0x${"1".repeat(64)}` }),
      baseEnv({ AI_AGENT_CONTRACT_ADDRESS: " 0x4a0C7e5807f9174499a8F56F2C69c61b39a4c64D" }),
    ]) {
      expect(() => validateConfig(env)).to.throw(ConfigError);
    }
  });

  it("rejects a malformed contract address", () => {
    try {
      validateConfig(baseEnv({ AI_AGENT_CONTRACT_ADDRESS: "0x1234" }));
      expect.fail("expected a ConfigError");
    } catch (err) {
      expect(err.message).to.include("AI_AGENT_CONTRACT_ADDRESS");
    }
  });

  it("requires BOTH credentials when STORAGE_PROVIDER is unset", () => {
    // storage.js branches exactly two ways: "irys" means Irys only, and ANYTHING ELSE —
    // including unset — initialises Irys AND Autonomys, so both credentials are needed. Unset is
    // the NORMAL case: .env.oracle.example ships STORAGE_PROVIDER= empty, because both are
    // initialised so old Arweave data stays readable while new writes go to Autonomys.
    //
    // The first version of this guard invented a provider→credential map and demanded only the
    // matching one, so a deployment with NO storage credentials at all started cleanly — the
    // exact failure this module exists to prevent.
    try {
      validateConfig(baseEnv({ USE_MOCK_STORAGE: undefined }));
      expect.fail("expected a ConfigError");
    } catch (err) {
      expect(err.message).to.include("IRYS_PAYMENT_PRIVATE_KEY");
      expect(err.message).to.include("AUTONOMYS_API_KEY");
    }
  });

  it("requires both credentials for an unrecognised provider rather than rejecting it", () => {
    // A typo'd or future provider falls into storage.js's else branch and gets BOTH providers,
    // so the safe reading is "needs both" — not "reject the value". Rejecting would make the
    // guard fail a deployment that storage.js would have handled.
    try {
      validateConfig(baseEnv({ USE_MOCK_STORAGE: undefined, STORAGE_PROVIDER: "autonmyos" }));
      expect.fail("expected a ConfigError");
    } catch (err) {
      expect(err.message).to.include("IRYS_PAYMENT_PRIVATE_KEY");
      expect(err.message).to.include("AUTONOMYS_API_KEY");
      expect(err.message).to.not.match(/not a recognised value/i);
    }
  });

  it("names AUTONOMYS_API_KEY specifically when it is the one missing", () => {
    // Read lazily at upload time today, so its absence currently surfaces only AFTER the user
    // has paid and the answer has been generated. The Irys key is supplied here so the report
    // isolates the genuinely missing one.
    try {
      validateConfig(
        baseEnv({
          USE_MOCK_STORAGE: undefined,
          STORAGE_PROVIDER: "",
          IRYS_PAYMENT_PRIVATE_KEY: "0xabc",
        }),
      );
      expect.fail("expected a ConfigError");
    } catch (err) {
      expect(err.message).to.include("AUTONOMYS_API_KEY");
      expect(err.message).to.not.include("IRYS_PAYMENT_PRIVATE_KEY");
    }
  });

  it("rejects storage credentials left at their example-file placeholder", () => {
    // isBlank alone waved these through: .env.oracle.example ships
    // IRYS_PAYMENT_PRIVATE_KEY=your_funding_wallet_private_key_here and
    // AUTONOMYS_API_KEY=your_actual_api_key_from_ai3_storage, both non-empty. Copying the example
    // without filling it in is the likeliest route to a bad credential in production, and since
    // these are read at upload time it lands as an auth failure AFTER the user has paid.
    try {
      validateConfig(
        baseEnv({
          USE_MOCK_STORAGE: undefined,
          STORAGE_PROVIDER: "irys",
          IRYS_PAYMENT_PRIVATE_KEY: "your_funding_wallet_private_key_here",
        }),
      );
      expect.fail("expected a ConfigError");
    } catch (err) {
      expect(err.message).to.include("IRYS_PAYMENT_PRIVATE_KEY");
      expect(err.message).to.match(/placeholder/i);
    }
  });

  it("requires IRYS_PAYMENT_PRIVATE_KEY when Irys is the storage provider", () => {
    try {
      validateConfig(baseEnv({ USE_MOCK_STORAGE: undefined, STORAGE_PROVIDER: "irys" }));
      expect.fail("expected a ConfigError");
    } catch (err) {
      expect(err.message).to.include("IRYS_PAYMENT_PRIVATE_KEY");
    }
  });

  it("does not demand the Autonomys key from an Irys-only deployment", () => {
    // The one narrowing storage.js actually makes. Demanding a credential the deployment will
    // never use would make the guard the thing blocking a correct config — the failure mode
    // that gets guards deleted.
    //
    // This test previously asserted the mirror image — that STORAGE_PROVIDER=autonomys needs
    // only AUTONOMYS_API_KEY — which encoded the invented taxonomy rather than storage.js. There
    // is no "autonomys" branch: that value falls through to Irys AND Autonomys, so it needs both.
    expect(() =>
      validateConfig(
        baseEnv({
          USE_MOCK_STORAGE: undefined,
          STORAGE_PROVIDER: "irys",
          IRYS_PAYMENT_PRIVATE_KEY: "0xabc",
        }),
      ),
    ).to.not.throw();
  });

  it("skips storage credentials in LOCAL_IPFS mode", () => {
    // storage.js has TWO early returns before any credential is touched — USE_MOCK_STORAGE and
    // USE_LOCAL_IPFS (`const USE_LOCAL_IPFS = !!LOCAL_IPFS_API_URL`). Demanding an Irys key here
    // would make the guard refuse a configuration storage.js handles perfectly well, which is
    // the failure mode that gets guards deleted.
    expect(() =>
      validateConfig(
        baseEnv({
          USE_MOCK_STORAGE: undefined,
          LOCAL_IPFS_API_URL: "http://127.0.0.1:5001",
        }),
      ),
    ).to.not.throw();
  });

  it("rejects a bare placeholder credential with no separator", () => {
    // The pattern required [_-] after the keyword, so `changeme` and `xxx` — plausible values in
    // a future example file — read as real credentials.
    for (const value of ["changeme", "xxx", "TODO"]) {
      try {
        validateConfig(
          baseEnv({
            USE_MOCK_STORAGE: undefined,
            STORAGE_PROVIDER: "irys",
            IRYS_PAYMENT_PRIVATE_KEY: value,
          }),
        );
        expect.fail(`expected a ConfigError for ${value}`);
      } catch (err) {
        expect(err.message).to.match(/placeholder/i);
      }
    }
  });

  it("skips storage credentials entirely under mock storage", () => {
    // Localnet e2e runs with USE_MOCK_STORAGE=true and no credentials at all.
    expect(() =>
      validateConfig(baseEnv({ STORAGE_PROVIDER: "autonomys", USE_MOCK_STORAGE: "true" })),
    ).to.not.throw();
  });

  it("treats a whitespace-only value as missing", () => {
    // A quoted empty string in a compose file is the common shape of this mistake.
    try {
      validateConfig(baseEnv({ PRIVATE_KEY: "   " }));
      expect.fail("expected a ConfigError");
    } catch (err) {
      expect(err.message).to.include("PRIVATE_KEY");
    }
  });
});
