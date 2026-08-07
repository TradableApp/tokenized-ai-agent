/**
 * Refuses to start on a configuration that cannot possibly work, naming the variable.
 *
 * WHY BOOT AND NOT FIRST USE. Two failures on base-testnet motivated this, and both were
 * knowable before the oracle accepted a single event:
 *
 *   AI_AGENT_CONTRACT_ADDRESS left at its placeholder. `new ethers.Contract(addr, abi, runner)`
 *   does NOT reject a bad address — it constructs happily and defers resolution, treating
 *   anything not address-shaped as an ENS name. The first call then fails with "contract runner
 *   does not support name resolution", which names no variable, no file and no value, and reads
 *   like a provider bug rather than a typo in a compose file.
 *
 *   AUTONOMYS_API_KEY / IRYS_PAYMENT_PRIVATE_KEY are read lazily inside the storage layer at
 *   upload time. A missing one therefore fails AFTER the prompt has been decrypted, answered and
 *   charged for on-chain — the user is debited and there is no MessageFile. That is the
 *   expensive shape: config mistakes should cost a restart, never a user's money.
 *
 * Everything is reported in one pass. A guard that surfaces one variable per restart turns a
 * five-variable misconfiguration into five deploy cycles, and in a TEE each cycle is an image
 * build, an on-chain update and a restart.
 */

/** Thrown when the process must not continue. Typed so callers can distinguish it from bugs. */
class ConfigError extends Error {
  constructor(problems) {
    super(
      `Refusing to start — ${problems.length} configuration problem(s):\n` +
        problems.map((p) => `  - ${p}`).join("\n"),
    );
    this.name = "ConfigError";
    this.problems = problems;
  }
}

/** Values that exist but say nothing. A quoted empty string in a compose file is the usual shape. */
function isBlank(value) {
  return typeof value !== "string" || !value.trim();
}

/**
 * Placeholders shipped in the example env files. These are the values most likely to reach a
 * real deployment, because they look filled in.
 */
const PLACEHOLDER = /^0x(your|example|replace|todo)/i;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Which credentials a given STORAGE_PROVIDER actually needs.
 *
 * DERIVED FROM `storage/storage.js::initializeStorage`, not from a plausible-sounding taxonomy.
 * The real branch there is exactly two-way:
 *
 *   STORAGE_PROVIDER === "irys"  → Irys ONLY               → IRYS_PAYMENT_PRIVATE_KEY
 *   anything else, INCLUDING unset → Irys AND Autonomys     → both credentials
 *
 * The second branch is the normal case, not an error: `.env.oracle.example` ships
 * `STORAGE_PROVIDER=` empty, and the comment there explains why — both are initialised so old
 * Arweave data stays readable while new writes go to Autonomys. So an unrecognised or missing
 * value must NOT be rejected; it must be validated as "both", which is the stricter requirement.
 *
 * A first version of this guard invented a three-key provider map and demanded only the matching
 * credential. It let a deployment with NO storage credentials at all start cleanly — the exact
 * failure this module exists to prevent, since the credentials are read at upload time and would
 * therefore have failed after the user had paid.
 *
 * @param {string} provider lower-cased STORAGE_PROVIDER, possibly ""
 * @returns {string[]} env var names that must be present
 */
function requiredStorageCredentials(provider) {
  return provider === "irys"
    ? ["IRYS_PAYMENT_PRIVATE_KEY"]
    : ["IRYS_PAYMENT_PRIVATE_KEY", "AUTONOMYS_API_KEY"];
}

/** Required regardless of network, storage provider, or mode. */
const ALWAYS_REQUIRED = ["NETWORK_NAME", "PRIVATE_KEY", "AI_AGENT_CONTRACT_ADDRESS"];

/**
 * Validates the oracle's configuration, or throws naming every problem found.
 *
 * @param {Record<string, string | undefined>} [env] defaults to `process.env`
 * @throws {ConfigError}
 */
function validateConfig(env = process.env) {
  const problems = [];

  for (const name of ALWAYS_REQUIRED) {
    if (isBlank(env[name])) problems.push(`${name} is missing or empty`);
  }

  // Only shape-check the address once we know something is there — otherwise a missing value
  // would produce two problems for one mistake, which makes the report harder to act on.
  const address = env.AI_AGENT_CONTRACT_ADDRESS;
  if (!isBlank(address)) {
    const trimmed = address.trim();
    if (PLACEHOLDER.test(trimmed)) {
      problems.push(
        `AI_AGENT_CONTRACT_ADDRESS is still the placeholder "${trimmed}" — ethers would accept ` +
          `this and fail later with "contract runner does not support name resolution"`,
      );
    } else if (!ADDRESS.test(trimmed)) {
      problems.push(
        `AI_AGENT_CONTRACT_ADDRESS "${trimmed}" is not a valid address — ethers treats a ` +
          `non-address as an ENS name and fails asynchronously on first call`,
      );
    }
  }

  // Mock storage never touches a credential; localnet e2e runs with none configured at all.
  if (env.USE_MOCK_STORAGE !== "true") {
    const provider = (env.STORAGE_PROVIDER || "").trim().toLowerCase();
    const describe = provider ? `STORAGE_PROVIDER is "${provider}"` : "STORAGE_PROVIDER is unset";
    for (const credential of requiredStorageCredentials(provider)) {
      if (isBlank(env[credential])) {
        problems.push(
          `${credential} is missing or empty, but ${describe} — this is read at upload time, ` +
            `so it would fail AFTER the user has paid for the answer`,
        );
      }
    }
  }

  if (problems.length) throw new ConfigError(problems);
}

module.exports = { validateConfig, ConfigError };
