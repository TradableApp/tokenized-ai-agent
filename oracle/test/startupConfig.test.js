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
    AI_AGENT_CONTRACT_ADDRESS: "0x4a0C7e5807f9174499a8F56F2C69c61b39a4c64D",
    USE_MOCK_STORAGE: "true",
    // Postgres is part of a complete configuration now — the agent runtime has no working
    // fallback. Kept in the shared fixture rather than added per-test so every existing case
    // keeps testing the thing it was written to test.
    POSTGRES_AGENT_DATABASE: "oracle_agent",
    POSTGRES_HOST: "10.0.0.5",
    POSTGRES_PORT: "5432",
    POSTGRES_DATABASE: "senseai",
    POSTGRES_USER: "senseai",
    POSTGRES_PASSWORD: "not-a-real-password",
    POSTGRES_CLIENT_CERT_PATH: "/certs/client.crt",
    POSTGRES_CLIENT_KEY_PATH: "/certs/client.key",
    POSTGRES_SERVER_CA_CERT_PATH: "/certs/ca.crt",
    COINGECKO_API_KEY: "not-a-real-key",
    ...overrides,
  };
}

/**
 * The same, on a local network. Only there does the oracle take its key from PRIVATE_KEY, so
 * every check of that variable's shape runs against this.
 */
function localEnv(overrides = {}) {
  return baseEnv({
    NETWORK_NAME: "base-localnet",
    PRIVATE_KEY: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    ...overrides,
  });
}

describe("startup config validation", () => {
  it("accepts a complete configuration", () => {
    expect(() => validateConfig(baseEnv())).to.not.throw();
  });

  // ADR-0001 chose managed Postgres and rejected PGLite as brittle; without this guard that
  // decision was never enforced, and the cost of missing it is paid ~30s into the boot on
  // `relation "agents" does not exist`, nowhere near the variable at fault.
  it("refuses a configuration with no POSTGRES_AGENT_DATABASE", () => {
    try {
      validateConfig(baseEnv({ POSTGRES_AGENT_DATABASE: undefined, POSTGRES_URL: undefined }));
      expect.fail("expected a ConfigError");
    } catch (err) {
      expect(err.name).to.equal("ConfigError");
      expect(err.message).to.match(/POSTGRES_AGENT_DATABASE/);
    }
  });

  // initializeEliza still implements the legacy path: given POSTGRES_URL it migrates against
  // that url and derives its expectDatabase guard from the url's own path. Rejecting it here
  // would leave a guard contradicting a branch the same change documents as supported. The
  // invariant is that SOME Postgres is named — PGLite is the thing that must be impossible.
  // Every individual POSTGRES_* key is stripped, not just the agent DB name: with baseEnv's
  // host/user/password still present the assertion passes even if the branch wrongly demanded
  // them, so it would prove nothing about the path it names. The url carries its own connection
  // details — that is the whole point of the legacy path — so the per-key checks must be skipped.
  it("accepts a directly-supplied POSTGRES_URL in place of the agent DB", () => {
    expect(() =>
      validateConfig(
        baseEnv({
          POSTGRES_AGENT_DATABASE: undefined,
          POSTGRES_HOST: undefined,
          POSTGRES_PORT: undefined,
          POSTGRES_DATABASE: undefined,
          POSTGRES_USER: undefined,
          POSTGRES_PASSWORD: undefined,
          POSTGRES_CLIENT_CERT_PATH: undefined,
          POSTGRES_CLIENT_KEY_PATH: undefined,
          POSTGRES_SERVER_CA_CERT_PATH: undefined,
          POSTGRES_URL: "postgresql://u:p@db.internal:5432/oracle_agent",
        }),
      ),
    ).to.not.throw();
  });

  // The legacy url was the one credential in this module checked with isBlank rather than
  // isMissingOrPlaceholder, so `POSTGRES_URL=your_postgres_url_here` satisfied the guard and
  // the oracle started toward an unusable url. Nothing ships that placeholder today — but a
  // guard whose whole job is catching unfilled config must not have one key it exempts.
  it("refuses a placeholder POSTGRES_URL standing in for the agent DB", () => {
    try {
      validateConfig(
        baseEnv({
          POSTGRES_AGENT_DATABASE: undefined,
          POSTGRES_URL: "your_postgres_url_here",
        }),
      );
      expect.fail("expected a ConfigError");
    } catch (err) {
      expect(err.name).to.equal("ConfigError");
      expect(err.message).to.match(/POSTGRES_AGENT_DATABASE/);
    }
  });

  // Not reachable by copying .env.oracle.example, which ships a real `oracle_agent` — but a
  // named database is the one the runtime USES: wireAgentDbForPluginSql bootstraps against
  // whatever is here the moment it is non-blank, so a placeholder is not "unset with a hint",
  // it is a live connection to a database that does not exist.
  it("refuses a placeholder agent DB name", () => {
    try {
      validateConfig(baseEnv({ POSTGRES_AGENT_DATABASE: "your_agent_db_here" }));
      expect.fail("expected a ConfigError");
    } catch (err) {
      expect(err.name).to.equal("ConfigError");
      expect(err.message).to.match(/placeholder/);
    }
  });

  // ...and a url alongside it does not excuse it, because the runtime prefers the name: the
  // legacy branch is only taken when no database is named at all.
  it("refuses a placeholder agent DB name even when a POSTGRES_URL is supplied", () => {
    try {
      validateConfig(
        baseEnv({
          POSTGRES_AGENT_DATABASE: "your_agent_db_here",
          POSTGRES_URL: "postgresql://u:p@db.internal:5432/oracle_agent",
        }),
      );
      expect.fail("expected a ConfigError");
    } catch (err) {
      expect(err.message).to.match(/placeholder/);
    }
  });

  // A database NAME with no credentials is what the committed .env.oracle.example carries, so
  // it is the shape someone gets by copying the example — it must be rejected, not accepted
  // and then failed on at connect time.
  it("refuses a named agent DB whose connection config is incomplete", () => {
    try {
      validateConfig(baseEnv({ POSTGRES_PASSWORD: undefined, POSTGRES_HOST: undefined }));
      expect.fail("expected a ConfigError");
    } catch (err) {
      expect(err.message).to.match(/POSTGRES_HOST/);
      expect(err.message).to.match(/POSTGRES_PASSWORD/);
    }
  });

  // Either form satisfies the cert requirement; postgresBootstrap accepts inline PEM as well
  // as a path, and the guard reuses ITS lists, so it must accept whatever that module does.
  it("accepts inline cert PEM in place of the *_PATH form", () => {
    expect(() =>
      validateConfig(
        baseEnv({
          POSTGRES_CLIENT_CERT_PATH: undefined,
          POSTGRES_CLIENT_KEY_PATH: undefined,
          POSTGRES_SERVER_CA_CERT_PATH: undefined,
          POSTGRES_CLIENT_CERT: "-----BEGIN CERTIFICATE-----",
          POSTGRES_CLIENT_KEY: "-----BEGIN PRIVATE KEY-----",
          POSTGRES_SERVER_CA_CERT: "-----BEGIN CERTIFICATE-----",
        }),
      ),
    ).to.not.throw();
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
      validateConfig({ USE_MOCK_STORAGE: "true", NETWORK_NAME: "" });
      expect.fail("expected a ConfigError");
    } catch (err) {
      expect(err.message).to.include("NETWORK_NAME");
      expect(err.message).to.include("POSTGRES_AGENT_DATABASE");
      expect(err.message).to.include("AI_AGENT_CONTRACT_ADDRESS");
    }
  });

  describe("poll settings", () => {
    const problemsOf = (overrides) => {
      try {
        validateConfig(baseEnv(overrides));
      } catch (err) {
        return err.message;
      }
      return "";
    };

    it("accepts them unset, and as positive whole numbers", () => {
      expect(problemsOf({})).to.equal("");
      expect(
        problemsOf({
          POLL_INTERVAL_MS: "3000",
          POLL_BACKOFF_CAP_MS: "60000",
          EVENT_BATCH_SIZE: "10",
        }),
      ).to.equal("");
    });

    for (const name of ["POLL_INTERVAL_MS", "POLL_BACKOFF_CAP_MS", "EVENT_BATCH_SIZE"]) {
      for (const value of ["3s", "0", "-5", "2.5", "10blocks"]) {
        it(`refuses ${name}=${value} instead of quietly using the default`, () => {
          const message = problemsOf({ [name]: value });

          expect(message).to.include(name);
          expect(message).to.include("positive whole number");
        });
      }
    }

    it("refuses a backoff cap below the poll interval", () => {
      // Found at start-up, not after the catch-up has run and the loop refuses to build.
      const message = problemsOf({ POLL_INTERVAL_MS: "120000", POLL_BACKOFF_CAP_MS: "60000" });

      expect(message).to.include("POLL_BACKOFF_CAP_MS");
      expect(message).to.include("POLL_INTERVAL_MS");
    });

    it("refuses an interval above the default cap when no cap is set", () => {
      // The default cap is 60000.
      expect(problemsOf({ POLL_INTERVAL_MS: "120000" })).to.include("POLL_BACKOFF_CAP_MS");
    });
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
      expect(
        () => new ethers.Wallet(key),
        `ethers should accept ${key.slice(0, 6)}…`,
      ).to.not.throw();
      expect(
        () => validateConfig(localEnv({ PRIVATE_KEY: key })),
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
        validateConfig(localEnv({ PRIVATE_KEY: bad }));
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
      validateConfig(localEnv({ PRIVATE_KEY: "your_funding_wallet_private_key_here" }));
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
      // Only a local network takes its key from PRIVATE_KEY.
      const env = name.endsWith("-localnet") ? localEnv : baseEnv;
      expect(() => validateConfig(env({ NETWORK_NAME: name })), name).to.not.throw();
    }
  });

  it("rejects a key or address padded with whitespace", () => {
    // contractUtility passes process.env STRAIGHT into new ethers.Wallet(...) and
    // new ethers.Contract(...) with no trim of its own, so validating a trimmed COPY would
    // approve bytes the consumer then rejects — reproducing the opaque ethers error this guard
    // exists to replace. A leading space from a compose-file quoting mistake is the usual shape.
    for (const env of [
      localEnv({ PRIVATE_KEY: ` 0x${"1".repeat(64)}` }),
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

  // The payload mirror is optional, but half-configured is the worst state: the oracle would
  // boot, answer, and then fail every mirror write in the background — one alert, then silence,
  // while the dApp quietly falls back to the flaky gateway it was meant to be shielded from.
  // Same rule as the storage credentials: boot-time-knowable, so refuse to start and name it.
  describe("payload mirror", () => {
    const SA_KEY = JSON.stringify({
      client_email: "w@p.iam.gserviceaccount.com",
      private_key: "-----KEY-----",
    });

    it("accepts a deployment with the mirror unset", () => {
      expect(() => validateConfig(baseEnv())).to.not.throw();
    });

    it("accepts a bucket paired with a well-formed service-account key", () => {
      const env = baseEnv({
        PAYLOAD_MIRROR_BUCKET: "tradable-app-garrick-senseai-payloads",
        PAYLOAD_MIRROR_SA_KEY: SA_KEY,
      });

      expect(() => validateConfig(env)).to.not.throw();
    });

    it("refuses a bucket with no service-account key", () => {
      const env = baseEnv({ PAYLOAD_MIRROR_BUCKET: "tradable-app-garrick-senseai-payloads" });

      expect(() => validateConfig(env)).to.throw(/PAYLOAD_MIRROR_SA_KEY/);
    });

    it("refuses a service-account key that is not JSON", () => {
      const env = baseEnv({
        PAYLOAD_MIRROR_BUCKET: "b",
        PAYLOAD_MIRROR_SA_KEY: "-----BEGIN PRIVATE KEY-----",
      });

      expect(() => validateConfig(env)).to.throw(/PAYLOAD_MIRROR_SA_KEY.*JSON/);
    });

    it("refuses a service-account key missing client_email or private_key", () => {
      const env = baseEnv({
        PAYLOAD_MIRROR_BUCKET: "b",
        PAYLOAD_MIRROR_SA_KEY: '{"type":"service_account"}',
      });

      expect(() => validateConfig(env)).to.throw(
        /PAYLOAD_MIRROR_SA_KEY.*client_email.*private_key/,
      );
    });

    it("ignores a service-account key with no bucket — the mirror is simply disabled", () => {
      expect(() => validateConfig(baseEnv({ PAYLOAD_MIRROR_SA_KEY: SA_KEY }))).to.not.throw();
    });
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
      validateConfig(localEnv({ PRIVATE_KEY: "   " }));
      expect.fail("expected a ConfigError");
    } catch (err) {
      expect(err.message).to.include("PRIVATE_KEY");
    }
  });

  describe("where the oracle's own key comes from", () => {
    const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

    it("requires PRIVATE_KEY on a local network", () => {
      for (const network of ["base-localnet", "sapphire-localnet"]) {
        expect(
          () => validateConfig(localEnv({ NETWORK_NAME: network, PRIVATE_KEY: undefined })),
          network,
        ).to.throw(ConfigError, /PRIVATE_KEY is missing or empty/);
        expect(() => validateConfig(localEnv({ NETWORK_NAME: network })), network).to.not.throw();
      }
    });

    it("needs no PRIVATE_KEY on a network that is not local", () => {
      for (const network of ["baseSepolia", "base", "sapphire", "sapphire-testnet"]) {
        expect(() => validateConfig(baseEnv({ NETWORK_NAME: network })), network).to.not.throw();
      }
    });

    // The keys of a deployed oracle are made inside the TEE. A PRIVATE_KEY left in the secrets
    // would be a copy of a key held outside it, so it stops the boot until it is removed.
    it("refuses to start with PRIVATE_KEY set on a network that is not local", () => {
      for (const network of ["baseSepolia", "base", "sapphire", "sapphire-testnet"]) {
        let failure;
        try {
          validateConfig(baseEnv({ NETWORK_NAME: network, PRIVATE_KEY: KEY }));
        } catch (error) {
          failure = error;
        }
        expect(failure, network).to.be.instanceOf(ConfigError);
        expect(failure.message, network).to.include(
          "PRIVATE_KEY is set, but on this network the oracle takes its keys from the ROFL key " +
            "service; remove the secret",
        );
        expect(failure.message, network).to.not.include(KEY);
      }
    });

    // The rest of the oracle reads NETWORK_NAME as written. A padded name passed here would
    // be taken for a different network there.
    it("refuses a NETWORK_NAME with spaces around it", () => {
      expect(() => validateConfig(localEnv({ NETWORK_NAME: "base-localnet " }))).to.throw(
        ConfigError,
        /NETWORK_NAME has spaces around it/,
      );
    });

    it("counts a blank PRIVATE_KEY as not set", () => {
      expect(() => validateConfig(baseEnv({ PRIVATE_KEY: "  " }))).to.not.throw();
    });
  });

  // The ElizaOS path gets its market data through a tool server that needs this key. Without it
  // the server starts, lists its tools, and fails every call, so the gap shows only in answers.
  describe("the market-data key", () => {
    it("refuses a network that is not local without COINGECKO_API_KEY, and names it", () => {
      expect(() => validateConfig(baseEnv({ COINGECKO_API_KEY: undefined }))).to.throw(
        ConfigError,
        /COINGECKO_API_KEY is missing or empty/,
      );
    });

    it("counts a blank key as missing", () => {
      expect(() => validateConfig(baseEnv({ COINGECKO_API_KEY: "   " }))).to.throw(
        ConfigError,
        /COINGECKO_API_KEY is missing or empty/,
      );
    });

    it("counts the example file's placeholder as missing, and does not print it", () => {
      const placeholder = "your_coingecko_api_key_here";
      let thrown = null;
      try {
        validateConfig(baseEnv({ COINGECKO_API_KEY: placeholder }));
      } catch (error) {
        thrown = error;
      }

      expect(thrown).to.be.instanceOf(ConfigError);
      expect(thrown.message).to.match(/COINGECKO_API_KEY is still the example-file placeholder/);
      expect(thrown.message).to.not.include(placeholder);
    });

    it("starts on a network that is not local when the key is set", () => {
      expect(() => validateConfig(baseEnv())).to.not.throw();
    });

    it("does not ask a local network for it", () => {
      expect(() => validateConfig(localEnv({ COINGECKO_API_KEY: undefined }))).to.not.throw();
    });
  });
  // The live reasoning stream's settings. Each is optional (defaults live in code), but a set
  // value that cannot work stops start-up, naming the setting and never repeating the value: a
  // value pasted into the wrong setting can be a secret.
  describe("the stream settings", () => {
    const refusalFor = (overrides) => {
      try {
        validateConfig(baseEnv(overrides));
      } catch (error) {
        return error;
      }
      return null;
    };

    it("accepts no stream settings at all: every one has a default", () => {
      expect(() => validateConfig(baseEnv())).to.not.throw();
    });

    it("ends a connection by default before the ROFL proxy would cut it, and after a poll's wait", () => {
      const {
        STREAM_SETTING_DEFAULTS,
        PROXY_CONNECTION_LIMIT_MS,
        PROXY_LIMIT_HEADROOM_MS,
      } = require("../src/stream/streamConfig");
      const { STREAM_HTTP } = require("../src/stream/streamContract");
      const lifetime = STREAM_SETTING_DEFAULTS.STREAM_MAX_CONN_MS;
      // The proxy closed every connection 30.3 to 30.5 s after it opened (measured on Sapphire
      // testnet, 2026-11-25): the limit is taken as 30 000 ms and the default leaves 5 000 ms
      // for a slow write, so the server's own clean end comes first.
      expect(PROXY_CONNECTION_LIMIT_MS).to.equal(30000);
      expect(PROXY_LIMIT_HEADROOM_MS).to.equal(5000);
      expect(lifetime).to.equal(PROXY_CONNECTION_LIMIT_MS - PROXY_LIMIT_HEADROOM_MS);
      // A poll waits 20 000 ms for a first frame; a lifetime below that would cut every poll short.
      expect(lifetime).to.be.above(STREAM_HTTP.pollWaitMs);
      // One heartbeat (15 000 ms) still fits inside a connection.
      expect(lifetime).to.be.above(STREAM_SETTING_DEFAULTS.STREAM_HEARTBEAT_MS);
    });

    it("refuses a connection lifetime the ROFL proxy would cut first, naming the setting", () => {
      // 30 000 ms is the proxy's limit: at it or above it, the proxy ends the stream, not the server.
      for (const value of ["30000", "35000", "240000"]) {
        const error = refusalFor({ STREAM_MAX_CONN_MS: value });
        expect(error, value).to.be.an("error");
        expect(error.message).to.match(/STREAM_MAX_CONN_MS/);
        // The message names the limit (30000), never what was set.
        if (value !== "30000") expect(error.message).to.not.include(value);
      }
      // One millisecond under the limit is the operator's choice to make.
      expect(refusalFor({ STREAM_MAX_CONN_MS: "29999" })).to.equal(null);
    });

    it("accepts a complete, valid set", () => {
      expect(() =>
        validateConfig(
          baseEnv({
            STREAM_ENABLED: "true",
            STREAM_PORT: "8787",
            STREAM_ALLOWED_ORIGINS:
              "https://a.example, http://localhost:3002,https://b.example:8443",
            STREAM_GRACE_MS: "120000",
            STREAM_HEARTBEAT_MS: "15000",
            STREAM_MAX_CONN_MS: "25000",
            STREAM_MAX_CONN_PER_ANSWER: "4",
            STREAM_MAX_CONN_TOTAL: "200",
            STREAM_HOST: "127.0.0.1",
          }),
        ),
      ).to.not.throw();
    });

    const badValues = [
      ["STREAM_ENABLED", "yes-please-0x5ec7e7"],
      ["STREAM_PORT", "0"],
      ["STREAM_PORT", "65536"],
      ["STREAM_PORT", "87a87"],
      ["STREAM_GRACE_MS", "-5"],
      ["STREAM_GRACE_MS", "2m"],
      ["STREAM_HEARTBEAT_MS", "0"],
      ["STREAM_MAX_CONN_MS", "99999999999"],
      ["STREAM_MAX_CONN_PER_ANSWER", "1.5"],
      ["STREAM_MAX_CONN_TOTAL", "0"],
      ["STREAM_ALLOWED_ORIGINS", "https://ok.example,http://plain-0x5ec7e7.example"],
      ["STREAM_ALLOWED_ORIGINS", "https://with-path-0x5ec7e7.example/app"],
      ["STREAM_ALLOWED_ORIGINS", "https://trailing-0x5ec7e7.example/"],
      ["STREAM_ALLOWED_ORIGINS", "https://a.example,,https://b.example"],
      ["STREAM_ALLOWED_ORIGINS", "*"],
      ["STREAM_ALLOWED_ORIGINS", "ftp://files-0x5ec7e7.example"],
      ["STREAM_ALLOWED_ORIGINS", "https://user:pw-0x5ec7e7@a.example"],
      ["STREAM_HOST", "host-0x5ec7e7.example"],
      ["STREAM_HOST", "127.0.0.1:8787-0x5ec7e7"],
      ["STREAM_HOST", "http://127.0.0.1/0x5ec7e7"],
      ["STREAM_HOST", "300.1.1.1-0x5ec7e7"],
    ];
    for (const [name, value] of badValues) {
      it(`refuses ${name} set to something unusable, naming it but not its value (${name}=…)`, () => {
        const error = refusalFor({ [name]: value });
        expect(error).to.be.instanceOf(ConfigError);
        expect(error.message).to.include(name);
        // A value of a few characters ("0") can occur in any sentence; the long ones cannot.
        if (value.length > 3) expect(error.message).to.not.include(value);
        expect(error.message).to.not.include("0x5ec7e7");
      });
    }

    it("refuses a heartbeat that is not shorter than the longest connection", () => {
      const error = refusalFor({ STREAM_HEARTBEAT_MS: "5000", STREAM_MAX_CONN_MS: "5000" });
      expect(error.message).to.match(/STREAM_HEARTBEAT_MS/);
      expect(error.message).to.match(/STREAM_MAX_CONN_MS/);
    });

    it("refuses more connections per answer than in all", () => {
      const error = refusalFor({ STREAM_MAX_CONN_PER_ANSWER: "10", STREAM_MAX_CONN_TOTAL: "5" });
      expect(error.message).to.match(/STREAM_MAX_CONN_PER_ANSWER/);
    });

    it("refuses a reader cap above a third of the socket budget, so proof-less sockets keep room", () => {
      // 768 sockets in the budget: up to 256 readers is accepted, 257 is not.
      expect(() => validateConfig(baseEnv({ STREAM_MAX_CONN_TOTAL: "256" }))).to.not.throw();
      const error = refusalFor({ STREAM_MAX_CONN_TOTAL: "257" });
      expect(error).to.be.instanceOf(ConfigError);
      expect(error.message).to.match(/STREAM_MAX_CONN_TOTAL/);
      expect(error.message).to.not.include("257");
    });

    it("checks nothing else of the stream when it is switched off", () => {
      expect(() =>
        validateConfig(baseEnv({ STREAM_ENABLED: "false", STREAM_PORT: "not-a-port" })),
      ).to.not.throw();
    });
  });
});
