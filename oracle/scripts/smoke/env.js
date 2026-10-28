/**
 * Smoke configuration: per-environment default tables plus the SMOKE_* overrides.
 *
 * One script serves Base Sepolia today and Base mainnet later, so the per-chain facts live in a
 * table keyed by SMOKE_ENV, and every explicit SMOKE_* variable wins over the table. Mainnet has
 * no committed addresses yet: its table names what is REQUIRED and the resolver fails once,
 * listing every missing variable BY NAME. No value — RPC URLs carry API keys and private keys are
 * private — ever appears in an error message.
 */

const SMOKE_ENVS = Object.freeze({
  "base-testnet": Object.freeze({
    rpcUrl: "https://sepolia.base.org",
    chainId: 84532,
    escrow: "0x36ec08471F2b995024967204D7542713cFaf5Fa4",
    agent: "0x4a0C7e5807f9174499a8F56F2C69c61b39a4c64D",
    token: "0xD77FF82e661C3838a59ea78bbF31F8c4c2BD8A80",
    // The deployed oracle's ECIES public key (compose.base-testnet.yaml PUBLIC_KEY). Not a secret:
    // it is what every client encrypts TO. Override with SMOKE_ORACLE_PUBLIC_KEY after a key
    // rotation — a stale key here means prompts land on-chain and are never answered.
    oraclePublicKey:
      "0x0416f5d18e33f98511a465603133837e3ec99c7f3a9ecc8beade30d520753317d54edbf421d412b673c36639fc9147e54e3150b4499eb344efdb2ac04dab952f9f",
  }),
  "base-mainnet": Object.freeze({
    rpcUrl: "https://mainnet.base.org",
    chainId: 8453,
    // Deliberately absent: filled from SMOKE_ESCROW_ADDRESS / SMOKE_AGENT_ADDRESS /
    // SMOKE_TOKEN_ADDRESS / SMOKE_ORACLE_PUBLIC_KEY once the mainnet contracts exist. Guessing
    // here would point a funded wallet at the wrong contract.
  }),
});

const DEFAULT_PROMPT = "What is the latest news on Bitcoin?";
const DEFAULT_METRICS_FILE = "smoke-metrics.json";

/** Which SMOKE_* variable fills each table slot, so a missing one is reported by name. */
const REQUIRED = [
  ["escrow", "SMOKE_ESCROW_ADDRESS"],
  ["agent", "SMOKE_AGENT_ADDRESS"],
  ["token", "SMOKE_TOKEN_ADDRESS"],
  ["oraclePublicKey", "SMOKE_ORACLE_PUBLIC_KEY"],
];

const pick = (env, name, fallback) => {
  const v = env[name];
  return v !== undefined && v !== "" ? v : fallback;
};

function resolvePrivateKeys(env) {
  const list = env.SMOKE_PRIVATE_KEYS
    ? env.SMOKE_PRIVATE_KEYS.split(",")
        .map((k) => k.trim())
        .filter(Boolean)
    : [];
  if (list.length) return list;
  if (env.SMOKE_PRIVATE_KEY) return [env.SMOKE_PRIVATE_KEY.trim()];
  throw new Error(
    "SMOKE_PRIVATE_KEY is required (or SMOKE_PRIVATE_KEYS, a comma-separated list, for SMOKE_BURST)",
  );
}

function resolveBurst(env, keyCount) {
  if (env.SMOKE_BURST === undefined || env.SMOKE_BURST === "") return 1;
  if (!/^[1-9]\d*$/.test(env.SMOKE_BURST))
    throw new Error(`SMOKE_BURST must be a positive integer, got '${env.SMOKE_BURST}'`);
  const burst = Number(env.SMOKE_BURST);
  if (burst > keyCount)
    throw new Error(
      `SMOKE_BURST=${burst} needs ${burst} private keys in SMOKE_PRIVATE_KEYS (one account per ` +
        `concurrent prompt — the escrow serialises a single user's prompts), got ${keyCount} key(s)`,
    );
  return burst;
}

/**
 * The asset the answer must actually be about — the check that catches a fluent, well-sourced
 * answer on the wrong subject, which structure alone never can.
 *
 * ABSENT AND EMPTY MEAN DIFFERENT THINGS, because in a compose file they are different things:
 * `SMOKE_ASSET=` is an empty string in process.env, not an absent key, while `# SMOKE_ASSET=` is
 * absent. An operator adding the former to switch the check off would, under a plain `||`, get
 * "Bitcoin" back — the variable would look set and do nothing. A custom SMOKE_PROMPT with no
 * SMOKE_ASSET means we cannot know what to assert, so the check is skipped rather than failing a
 * correct answer to the question that was actually asked.
 */
function resolveAsset(env) {
  if ("SMOKE_ASSET" in env) return env.SMOKE_ASSET.trim() || undefined;
  return env.SMOKE_PROMPT ? undefined : "Bitcoin";
}

const isTruthy = (v) => ["1", "true", "yes"].includes(String(v ?? "").toLowerCase());

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @returns {{
 *   envName: string, rpcUrl: string, chainId: number,
 *   escrow: string, agent: string, token: string, oraclePublicKey: string,
 *   privateKeys: string[], burst: number, injection: boolean,
 *   prompt: string, asset: string | undefined, metricsFile: string,
 *   timeoutMs: number, pollMs: number, fetchTimeoutMs: number,
 *   storageGatewayUrl: string | undefined,
 * }}
 */
function resolveSmokeConfig(env = process.env) {
  const envName = pick(env, "SMOKE_ENV", "base-testnet");
  const table = SMOKE_ENVS[envName];
  if (!table)
    throw new Error(
      `unknown SMOKE_ENV '${envName}' — known environments: ${Object.keys(SMOKE_ENVS).join(", ")}`,
    );

  const resolved = {
    escrow: pick(env, "SMOKE_ESCROW_ADDRESS", table.escrow),
    agent: pick(env, "SMOKE_AGENT_ADDRESS", table.agent),
    token: pick(env, "SMOKE_TOKEN_ADDRESS", table.token),
    oraclePublicKey: pick(env, "SMOKE_ORACLE_PUBLIC_KEY", table.oraclePublicKey),
  };
  const missing = REQUIRED.filter(([slot]) => !resolved[slot]).map(([, name]) => name);
  if (missing.length)
    throw new Error(
      `SMOKE_ENV=${envName} has no committed defaults for: ${missing.join(", ")} — set them explicitly`,
    );

  const privateKeys = resolvePrivateKeys(env);

  return {
    envName,
    rpcUrl: pick(env, "SMOKE_RPC_URL", table.rpcUrl),
    chainId: Number(pick(env, "SMOKE_CHAIN_ID", table.chainId)),
    ...resolved,
    privateKeys,
    burst: resolveBurst(env, privateKeys.length),
    injection: isTruthy(env.SMOKE_INJECTION),
    prompt: pick(env, "SMOKE_PROMPT", DEFAULT_PROMPT),
    asset: resolveAsset(env),
    metricsFile: pick(env, "SMOKE_METRICS_FILE", DEFAULT_METRICS_FILE),
    timeoutMs: Number(pick(env, "SMOKE_TIMEOUT_MS", 300_000)),
    pollMs: Number(pick(env, "SMOKE_POLL_MS", 6_000)),
    fetchTimeoutMs: Number(pick(env, "SMOKE_FETCH_TIMEOUT_MS", 30_000)),
    storageGatewayUrl: pick(env, "SMOKE_STORAGE_GATEWAY_URL", undefined),
  };
}

module.exports = { SMOKE_ENVS, resolveSmokeConfig, DEFAULT_PROMPT };
