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
    NETWORK_NAME: "base-testnet",
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

  it("rejects a malformed contract address", () => {
    try {
      validateConfig(baseEnv({ AI_AGENT_CONTRACT_ADDRESS: "0x1234" }));
      expect.fail("expected a ConfigError");
    } catch (err) {
      expect(err.message).to.include("AI_AGENT_CONTRACT_ADDRESS");
    }
  });

  it("requires AUTONOMYS_API_KEY when Autonomys is the storage provider", () => {
    // Read lazily at upload time today, so its absence currently surfaces only AFTER the user
    // has paid and the answer has been generated.
    try {
      validateConfig(
        baseEnv({ USE_MOCK_STORAGE: undefined, STORAGE_PROVIDER: "autonomys" }),
      );
      expect.fail("expected a ConfigError");
    } catch (err) {
      expect(err.message).to.include("AUTONOMYS_API_KEY");
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

  it("does not demand storage credentials that the chosen provider never uses", () => {
    // Demanding an Irys key from an Autonomys deployment would make the guard the thing that
    // blocks a correct config — the failure mode that gets guards deleted.
    expect(() =>
      validateConfig(
        baseEnv({
          USE_MOCK_STORAGE: undefined,
          STORAGE_PROVIDER: "autonomys",
          AUTONOMYS_API_KEY: "key-123",
        }),
      ),
    ).to.not.throw();
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
