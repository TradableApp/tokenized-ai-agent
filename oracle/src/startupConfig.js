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

const { SUPPORTED_NETWORKS } = require("./contractUtility");

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

/**
 * The non-hex placeholder style `.env.oracle.example` uses for credentials, e.g.
 * `your_funding_wallet_private_key_here`, `your_actual_api_key_from_ai3_storage`.
 *
 * These are non-empty, so a blank check waves them through — and copying the example without
 * filling it in is the single most likely way to reach production with a bad credential. Since
 * these are read at upload time, that lands as an auth failure AFTER the user has paid, which is
 * this module's whole reason for existing.
 */
const PLAIN_PLACEHOLDER = /^(your|example|replace|todo|changeme|xxx)[_-]/i;

/** True when the value is absent, empty, or still an example-file placeholder. */
function isMissingOrPlaceholder(value) {
  return isBlank(value) || PLAIN_PLACEHOLDER.test(value.trim());
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * A 32-byte hex private key. Checked for the same reason as the address: a mnemonic, a UUID or a
 * truncated key otherwise reaches `new ethers.Wallet(...)` and fails there — and that happens at
 * MODULE LOAD in aiAgentOracle.js, so without validating here the caller sees an ethers stack
 * trace instead of a named variable. See the note on where this guard must be invoked.
 */
const PRIVATE_KEY_HEX = /^0x[0-9a-fA-F]{64}$/;

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

  // A typo'd network name is the same class of bug as the placeholder address: accepted here,
  // rejected somewhere downstream. contractUtility does already throw a readable error for it,
  // but one at a time and at module load — so it costs a restart per typo instead of joining the
  // single report. The list is IMPORTED rather than restated so the two cannot drift.
  const network = env.NETWORK_NAME;
  if (!isBlank(network) && !SUPPORTED_NETWORKS.includes(network.trim())) {
    problems.push(
      `NETWORK_NAME "${network.trim()}" is not a supported network — expected one of: ` +
        SUPPORTED_NETWORKS.join(", "),
    );
  }

  // Shape-check the key for the same reason as the address, and with the same "only if present"
  // rule so one mistake never produces two problems.
  //
  // TESTED RAW, NOT TRIMMED — deliberately, and this is the whole point of the check.
  // `contractUtility.initializeOracle` passes `process.env.PRIVATE_KEY` straight into
  // `new ethers.Wallet(privateKey, provider)` with no trim of its own. Validating a trimmed copy
  // would therefore approve " 0x59c6…" — a leading space from a compose-file quoting mistake —
  // and hand ethers a value it rejects, producing exactly the opaque error this guard exists to
  // replace. The guard must validate the bytes the consumer actually receives.
  const privateKey = env.PRIVATE_KEY;
  if (!isBlank(privateKey)) {
    // Placeholder FIRST, same as the address. Both are "you forgot to fill this in", and telling
    // an operator their copied example value "is not a 32-byte hex key" describes the symptom
    // while hiding the cause — they read it as a formatting problem and go looking for the wrong
    // thing.
    if (PLAIN_PLACEHOLDER.test(privateKey.trim())) {
      problems.push(
        `PRIVATE_KEY is still the example-file placeholder "${privateKey.trim()}" — replace it ` +
          `with a real 32-byte hex private key`,
      );
    } else if (!PRIVATE_KEY_HEX.test(privateKey)) {
      problems.push(
        "PRIVATE_KEY is not a 32-byte hex key (0x + 64 hex characters, no surrounding " +
          "whitespace) — ethers rejects it at Wallet construction, which happens at module load " +
          "and so cannot name the variable",
      );
    }
  }

  // Only shape-check the address once we know something is there — otherwise a missing value
  // would produce two problems for one mistake, which makes the report harder to act on.
  // Raw, for the same reason as the key above: `new ethers.Contract(contractAddress, …)` receives
  // process.env verbatim, so a padded value must fail HERE rather than downstream. The
  // placeholder check trims only to keep its message readable, never to decide validity.
  const address = env.AI_AGENT_CONTRACT_ADDRESS;
  if (!isBlank(address)) {
    if (PLACEHOLDER.test(address.trim())) {
      problems.push(
        `AI_AGENT_CONTRACT_ADDRESS is still the placeholder "${address.trim()}" — ethers would ` +
          `accept this and fail later with "contract runner does not support name resolution"`,
      );
    } else if (!ADDRESS.test(address)) {
      problems.push(
        `AI_AGENT_CONTRACT_ADDRESS "${address}" is not a valid address (0x + 40 hex characters, ` +
          `no surrounding whitespace) — ethers treats a non-address as an ENS name and fails ` +
          `asynchronously on first call`,
      );
    }
  }

  // Mock storage never touches a credential; localnet e2e runs with none configured at all.
  if (env.USE_MOCK_STORAGE !== "true") {
    const provider = (env.STORAGE_PROVIDER || "").trim().toLowerCase();
    const describe = provider ? `STORAGE_PROVIDER is "${provider}"` : "STORAGE_PROVIDER is unset";
    for (const credential of requiredStorageCredentials(provider)) {
      if (isMissingOrPlaceholder(env[credential])) {
        const state = isBlank(env[credential])
          ? "is missing or empty"
          : `is still the example-file placeholder "${env[credential].trim()}"`;
        problems.push(
          `${credential} ${state}, but ${describe} — this is read at upload time, so it would ` +
            `fail AFTER the user has paid for the answer`,
        );
      }
    }
  }

  if (problems.length) throw new ConfigError(problems);
}

module.exports = { validateConfig, ConfigError };
