const hre = require("hardhat");
const chalk = require("chalk");

const { describeShape, isSet } = require("./lib/settingShape");
const { readEnvFile, fileOnlyProblems, withFileValues } = require("./lib/envFile");
const { failureText } = require("./lib/failureText");
const { typedSettings, typedOnlyProblems } = require("./lib/typedSettings");
const { LOCAL_NETWORKS } = require("./lib/networks");

// Hardhat's config has already loaded the root .env and then ENV_FILE over it, so the process
// environment holds both. DEPLOY_MODE and the pair's addresses are read again from ENV_FILE
// alone on every EVM network (FILE_ONLY_VARS below), and so is every setting that wires a fresh
// pair on a live network (FRESH_LIVE_FILE_ONLY_VARS). DRY_RUN and DEPLOY_MAINNET_CONFIRMED are
// read from what was typed alone (TYPED_ONLY_VARS), recorded before the files loaded: a file
// line that contradicts what was typed stops the deploy.

// Define which networks are Sapphire-based.
const SAPPHIRE_NETWORKS = new Set(["sapphire", "sapphire-testnet", "sapphire-localnet"]);

// --- Base mainnet guard -------------------------------------------------------------------
// `deploy:base-mainnet` reads .env.base-mainnet, which ships with placeholder addresses until
// the mainnet contracts exist. `ethers` treats a non-address string as an ENS name and defers
// resolution, so a placeholder would not fail until the first transaction had already cost gas.
// Every address-shaped variable that is set must be a real address (on every EVM network), and
// on `base` the run must be confirmed with DEPLOY_MAINNET_CONFIRMED=1 (exactly "1"), mirroring
// REHEARSAL_MAINNET_CONFIRMED in scripts/admin-rehearsal.js.
const MAINNET_NETWORK = "base";
const CONFIRM_VAR = "DEPLOY_MAINNET_CONFIRMED";
const ADDRESS_ENV_VARS = [
  "TOKEN_CONTRACT_ADDRESS",
  "AI_AGENT_CONTRACT_ADDRESS",
  "AI_AGENT_ESCROW_CONTRACT_ADDRESS",
  "TREASURY_ADDRESS",
  "ORACLE_ADDRESS",
];
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
// Whether the deploy sends at all, so never from a file.
const TYPED_ONLY_VARS = Object.freeze(["DRY_RUN", CONFIRM_VAR]);

// --- Deploy mode --------------------------------------------------------------------------
// `fresh` deploys a new agent and escrow and refuses while either pair address is set;
// `upgrade` upgrades the pair both addresses name. Before the mode, an empty address meant a new
// proxy, so a pair address deleted from ENV_FILE but still in the root .env upgraded the old
// proxy, and one left out deployed half a pair beside the other half.
const DEPLOY_MODES = Object.freeze(["fresh", "upgrade"]);
const PAIR_VARS = Object.freeze(["AI_AGENT_CONTRACT_ADDRESS", "AI_AGENT_ESCROW_CONTRACT_ADDRESS"]);
const FILE_ONLY_VARS = Object.freeze(["DEPLOY_MODE", ...PAIR_VARS]);
// The fees a fresh escrow starts with, in wei of the fee token, by the plan's name for each.
const FEE_VARS = Object.freeze({
  prompt: "INITIAL_PROMPT_FEE",
  cancellation: "INITIAL_CANCELLATION_FEE",
  metadata: "INITIAL_METADATA_FEE",
  branch: "INITIAL_BRANCH_FEE",
});
// Everything a fresh pair on a live network is wired with. One left out of ENV_FILE but set in
// the root .env would otherwise be used, and the read-back would pass, since it compares the
// chain with that same value. An upgrade reads none of them; a local network keeps the merged
// environment, since the e2e bring-up writes only the token, the symbol, the mode and the pair
// to the file and lets the rest fall back to the deploy wallet and the default fees.
// ORACLE_ADDRESS is not among them: a fresh pair on a live network refuses it wherever it is set
// (liveOracleProblem below).
const FRESH_LIVE_FILE_ONLY_VARS = Object.freeze([
  "TOKEN_CONTRACT_ADDRESS",
  "TREASURY_ADDRESS",
  "EXPECTED_FEE_TOKEN_SYMBOL",
  ...Object.values(FEE_VARS),
  "DOMAIN",
]);

// What a local fresh pair charges when a fee is not set, in whole tokens of the fee token.
const DEFAULT_FEES_IN_TOKENS = Object.freeze({
  prompt: "1",
  cancellation: "0.1",
  metadata: "0.1",
  branch: "0.5",
});
// The escrow's getter for each fee, and the label the plan prints.
const FEE_GETTERS = Object.freeze({
  prompt: "promptFee",
  cancellation: "cancellationFee",
  metadata: "metadataUpdateFee",
  branch: "branchFee",
});
const FEE_LABELS = Object.freeze({
  prompt: "Prompt fee",
  cancellation: "Cancellation fee",
  metadata: "Metadata fee",
  branch: "Branch fee",
});
const WHOLE_WEI_RE = /^[0-9]+$/;

/** Why a fee setting cannot be used, or null. The value is described by shape only. */
function feeValueProblem(name, value) {
  if (!isSet(value) || WHOLE_WEI_RE.test(String(value).trim())) return null;
  return `${name} is not a whole number of wei (${describeShape(value)}): write the fee in wei, in decimal digits only, with no sign, point, exponent, separator or 0x (one token of 18 decimals is 1000000000000000000)`;
}

/**
 * Why a fresh pair on a live network cannot take ORACLE_ADDRESS, or null. There the oracle's
 * signer is derived from the new agent's address (oracle/src/oracleKeys.js), so an address set
 * before the agent exists can only be another pair's signer: the new pair would grant it the role
 * and nothing later would remove it. The deploy wallet is the first oracle instead, and the
 * hand-over moves the role. The value is described by shape only.
 */
function liveOracleProblem(networkName, value) {
  if (!isSet(value)) return null;
  return `ORACLE_ADDRESS is set (${describeShape(value)}), but a fresh pair on ${networkName} takes no first oracle from it: there the oracle's signer is derived from the new agent's address, so an address set before the agent exists can only be another pair's signer. Empty ORACLE_ADDRESS (and ANSWER_TX_HASH) in ENV_FILE, and in the root .env and the shell if set there, and deploy again: the deploy wallet is the first oracle, and the deploy prints the hand-over (scripts/authorize-oracle.js grant, then retire-deployer) that moves the role to the new pair's signer once the oracle runs on it.`;
}

/** The settings read from ENV_FILE alone for this network and the mode the file names. */
function fileOnlyNames({ networkName, fileEnv }) {
  const fresh = String(fileEnv?.DEPLOY_MODE ?? "").trim() === "fresh";
  if (!fresh || LOCAL_NETWORKS.has(networkName)) return FILE_ONLY_VARS;
  return [...FILE_ONLY_VARS, ...FRESH_LIVE_FILE_ONLY_VARS];
}

/**
 * What stops a deploy, given the settings it would run with. `env` is the process environment
 * with FILE_ONLY_VARS taken from ENV_FILE. The Sapphire path is not checked here.
 */
function deployProblems({ networkName, env }) {
  if (SAPPHIRE_NETWORKS.has(networkName)) return [];
  const problems = [];
  for (const name of ADDRESS_ENV_VARS) {
    const value = env[name];
    if (isSet(value) && !ADDRESS_RE.test(value)) {
      problems.push(`${name} is a placeholder or not an address (${describeShape(value)})`);
    }
  }
  problems.push(...modeProblems({ networkName, env }));
  // A dry run sends nothing, so it may show the plan before the confirm is given.
  if (networkName === MAINNET_NETWORK && env[CONFIRM_VAR] !== "1" && env.DRY_RUN !== "1") {
    problems.push(
      `${CONFIRM_VAR} is ${describeShape(env[CONFIRM_VAR])}; a live deploy to ${MAINNET_NETWORK} needs exactly ${CONFIRM_VAR}=1 bun run deploy:base-mainnet`,
    );
  }
  return problems;
}

function modeProblems({ networkName, env }) {
  const mode = env.DEPLOY_MODE;
  if (!DEPLOY_MODES.includes(mode)) {
    return [
      `DEPLOY_MODE is ${describeShape(mode)}; set it in ENV_FILE to exactly fresh (deploy a new agent and escrow) or upgrade (upgrade the pair at AI_AGENT_CONTRACT_ADDRESS and AI_AGENT_ESCROW_CONTRACT_ADDRESS)`,
    ];
  }
  const problems = [];
  if (mode === "upgrade") {
    for (const name of PAIR_VARS.filter((n) => !isSet(env[n]))) {
      problems.push(
        `${name} is not set, but DEPLOY_MODE=upgrade upgrades an existing pair and needs both its addresses: set both in ENV_FILE, or use DEPLOY_MODE=fresh with both empty to deploy a new pair`,
      );
    }
    return problems;
  }
  for (const name of PAIR_VARS.filter((n) => isSet(env[n]))) {
    problems.push(
      `${name} is set, but DEPLOY_MODE=fresh deploys a new pair and never touches an existing one: empty both pair addresses in ENV_FILE for a new pair, or use DEPLOY_MODE=upgrade to upgrade the pair they name`,
    );
  }
  if (!isSet(env.TOKEN_CONTRACT_ADDRESS)) {
    problems.push(
      "TOKEN_CONTRACT_ADDRESS is required for a fresh pair: the new escrow takes its fees in that token",
    );
  }
  for (const name of Object.values(FEE_VARS)) {
    const problem = feeValueProblem(name, env[name]);
    if (problem) problems.push(problem);
    if (!isSet(env[name]) && !LOCAL_NETWORKS.has(networkName)) {
      problems.push(
        `${name} must be set for a fresh pair on ${networkName}: it is the fee in wei that users pay, and the default is for local networks only`,
      );
    }
  }
  if (!LOCAL_NETWORKS.has(networkName)) {
    const oracleProblem = liveOracleProblem(networkName, env.ORACLE_ADDRESS);
    if (oracleProblem) problems.push(oracleProblem);
    if (!isSet(env.TREASURY_ADDRESS)) {
      problems.push(
        `TREASURY_ADDRESS must be set for a fresh pair on ${networkName}: it is where fees accrue, and the deploy wallet fallback is for local networks only`,
      );
    }
    if (!isSet(env.EXPECTED_FEE_TOKEN_SYMBOL)) {
      problems.push(
        `EXPECTED_FEE_TOKEN_SYMBOL must be set for a fresh pair on ${networkName}: the deploy reads the token's symbol back and fails when it differs, so a pair is never left paying in the wrong token`,
      );
    }
    if (!isSet(env.DOMAIN)) {
      problems.push(
        `DOMAIN must be set for a fresh pair on ${networkName}: it is the sign-in domain the new agent is initialised with`,
      );
    }
  }
  return problems;
}

/**
 * The settings `fileOnlyNames` lists must come from ENV_FILE: one the file leaves out but the root
 * .env or the shell sets would otherwise pick the mode, the pair or its wiring. Values are never
 * printed.
 */
function sourceProblems({ networkName, envFile, fileEnv, processEnv }) {
  return fileOnlyProblems({
    names: fileEnv ? fileOnlyNames({ networkName, fileEnv }) : FILE_ONLY_VARS,
    envFile,
    fileEnv,
    processEnv,
    howToRun:
      "On an EVM network run the deploy through its package script (for example bun run deploy:base-testnet)",
  });
}

function refusal(networkName, problems) {
  return new Error(`Deployment to ${networkName} refused:\n  - ${problems.join("\n  - ")}`);
}

function assertDeployAllowed(ctx) {
  const problems = deployProblems(ctx);
  if (problems.length === 0) return;
  throw refusal(ctx.networkName, problems);
}

const orNull = (value) => (isSet(value) ? String(value).trim() : null);

/**
 * The deploy's plan from its settings, or a refusal listing every problem. `fileEnv` is ENV_FILE
 * parsed on its own (null when ENV_FILE is not set); `processEnv` is the process environment, with
 * the files loaded; `typedEnv` is what the shell held before they loaded (typedSettings), which
 * DRY_RUN and DEPLOY_MAINNET_CONFIRMED are read from. Without it they are read from `processEnv`.
 */
function resolveDeployPlan({ networkName, envFile, fileEnv, processEnv, typedEnv = processEnv }) {
  const typedProblems = typedOnlyProblems({
    names: TYPED_ONLY_VARS,
    typedEnv,
    processEnv,
    envFile,
  });
  const typed = Object.fromEntries(TYPED_ONLY_VARS.map((name) => [name, typedEnv?.[name]]));
  if (SAPPHIRE_NETWORKS.has(networkName)) {
    // The Sapphire deploy has no dry run: going on would send a real deploy.
    if (typed.DRY_RUN === "1") {
      typedProblems.push(
        "DRY_RUN=1 is set, but the dry run exists only for a fresh pair on an EVM network; the Sapphire deploy has none. Unset DRY_RUN to deploy. Nothing was sent.",
      );
    }
    if (typedProblems.length > 0) throw refusal(networkName, typedProblems);
    return { networkName, isSapphire: true };
  }
  const env = {
    ...withFileValues(processEnv, fileEnv, fileOnlyNames({ networkName, fileEnv })),
    ...typed,
  };
  const problems = [
    ...typedProblems,
    ...sourceProblems({ networkName, envFile, fileEnv, processEnv }),
    ...deployProblems({ networkName, env }),
  ];
  if (problems.length > 0) throw refusal(networkName, problems);
  return {
    networkName,
    isSapphire: false,
    envFile,
    mode: env.DEPLOY_MODE,
    dryRun: env.DRY_RUN === "1",
    live: !LOCAL_NETWORKS.has(networkName),
    domain: orNull(env.DOMAIN),
    token: orNull(env.TOKEN_CONTRACT_ADDRESS),
    treasury: orNull(env.TREASURY_ADDRESS),
    oracle: orNull(env.ORACLE_ADDRESS),
    expectedSymbol: orNull(env.EXPECTED_FEE_TOKEN_SYMBOL),
    agent: orNull(env.AI_AGENT_CONTRACT_ADDRESS),
    escrow: orNull(env.AI_AGENT_ESCROW_CONTRACT_ADDRESS),
    fees: {
      prompt: orNull(env.INITIAL_PROMPT_FEE),
      cancellation: orNull(env.INITIAL_CANCELLATION_FEE),
      metadata: orNull(env.INITIAL_METADATA_FEE),
      branch: orNull(env.INITIAL_BRANCH_FEE),
    },
  };
}

/**
 * True when an EVMAIAgent proxy still holds the single oracle address of the version before the
 * oracle role. That address sits in storage slot 0, and the migration clears it, so a non-zero
 * slot means the oracle must be carried over to the role in the same transaction as the upgrade.
 * A freshly deployed proxy has none: never call `migrateOracleRole` on one (it is
 * `reinitializer(2)` and would use up that version for nothing).
 */
async function needsOracleRoleMigration(provider, proxyAddress) {
  // Slot 0 is `_legacyOracle`; test/StorageLayout.test.js pins it there.
  const legacyOracleSlot = await provider.getStorage(proxyAddress, 0);
  return BigInt(legacyOracleSlot) !== 0n;
}

function explorerFor(networkName) {
  return networkName === MAINNET_NETWORK ? "https://basescan.org" : "https://sepolia.basescan.org";
}

// --- sending helpers ------------------------------------------------------------------------

async function getSafeFees(provider) {
  const { ethers } = hre;
  const fd = await provider.getFeeData();
  // sensible floors/headroom for busy testnets (adjust if needed)
  const minPrio = ethers.parseUnits("1.5", "gwei");
  const minMax = ethers.parseUnits("50", "gwei");

  const maxPriorityFeePerGas =
    fd.maxPriorityFeePerGas && fd.maxPriorityFeePerGas > minPrio
      ? fd.maxPriorityFeePerGas
      : minPrio;

  // add headroom over suggested max (covers base fee spikes)
  const maxFeePerGas =
    fd.maxFeePerGas && fd.maxFeePerGas > minMax
      ? (fd.maxFeePerGas * 12n) / 10n // +20%
      : minMax;

  return { maxFeePerGas, maxPriorityFeePerGas };
}

async function sendWithBump(sendFn, args, opts, bumps = [1.2, 1.5]) {
  try {
    const tx = await sendFn(...args, opts);
    return await tx.wait();
  } catch (e) {
    if (!/replacement transaction underpriced/i.test(e.message || "")) throw e;
  }
  let { maxFeePerGas, maxPriorityFeePerGas } = opts;
  const { nonce } = opts;
  for (const f of bumps) {
    maxFeePerGas = (maxFeePerGas * BigInt(Math.round(f * 100))) / 100n;
    maxPriorityFeePerGas = (maxPriorityFeePerGas * BigInt(Math.round(f * 100))) / 100n;
    try {
      const tx = await sendFn(...args, { nonce, maxFeePerGas, maxPriorityFeePerGas });
      return await tx.wait();
    } catch (e) {
      if (!/replacement transaction underpriced/i.test(e.message || "")) throw e;
    }
  }
  throw new Error("Could not replace tx with a sufficiently higher fee.");
}

// Hardhat's ethers provider doesn't implement waitForTransaction; poll receipt instead.
async function waitDeployed(env, contract) {
  const { ethers } = env;
  await contract.waitForDeployment();
  const tx = await contract.deploymentTransaction?.();
  if (!tx?.hash) return;
  let receipt = null;
  while (!receipt) {
    receipt = await ethers.provider.getTransactionReceipt(tx.hash);
    if (!receipt) await new Promise((r) => setTimeout(r, 1000));
  }
  // A local network mines on demand: waiting for the next block would wait forever.
  if (LOCAL_NETWORKS.has(env.network.name)) return;
  while ((await ethers.provider.getBlockNumber()) < (receipt.blockNumber || 0) + 1) {
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** Sends an owner call: one plain transaction locally, with fee bumping on a live network. */
async function sendOwnerCall(env, signer, fn, args) {
  if (LOCAL_NETWORKS.has(env.network.name)) {
    return (await fn(...args)).wait();
  }
  const nonce = await env.ethers.provider.getTransactionCount(signer.address, "pending");
  const fees = await getSafeFees(env.ethers.provider);
  return sendWithBump(fn, args, { nonce, ...fees });
}

// --- fresh pair -----------------------------------------------------------------------------

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/**
 * Reads the new pair back and lists every way it differs from the plan: the two links, the
 * escrow's token and treasury, both owners, who holds the oracle role, and the token's symbol
 * when the plan names one. An empty list means the pair is as planned. With `blockTag` every
 * value is read at that block, so a node behind the one that mined the link cannot answer from
 * before it.
 */
async function freshPairProblems(env, { plan, aiAgent, aiAgentEscrow, deployer, blockTag }) {
  const { ethers } = env;
  // Spread into each call: an override is passed only when there is a block to read at.
  const at = blockTag === undefined ? [] : [{ blockTag }];
  const agentAddress = await aiAgent.getAddress();
  const escrowAddress = await aiAgentEscrow.getAddress();
  const problems = [];
  const expectSame = (actual, expected, what, named) => {
    if (!same(actual, expected)) problems.push(`${what} is ${actual}, not ${named} ${expected}`);
  };

  expectSame(
    await aiAgent.aiAgentEscrow(...at),
    escrowAddress,
    "agent.aiAgentEscrow()",
    "the new escrow",
  );
  expectSame(
    await aiAgentEscrow.evmAIAgent(...at),
    agentAddress,
    "escrow.evmAIAgent()",
    "the new agent",
  );
  expectSame(
    await aiAgentEscrow.ableToken(...at),
    plan.token,
    "escrow.ableToken()",
    "TOKEN_CONTRACT_ADDRESS",
  );
  expectSame(
    await aiAgentEscrow.treasury(...at),
    plan.treasury ?? deployer.address,
    "escrow.treasury()",
    plan.treasury ? "TREASURY_ADDRESS" : "the deploy wallet",
  );
  expectSame(await aiAgent.owner(...at), deployer.address, "agent.owner()", "the deploy wallet");
  expectSame(
    await aiAgentEscrow.owner(...at),
    deployer.address,
    "escrow.owner()",
    "the deploy wallet",
  );

  const oracle = plan.oracle ?? deployer.address;
  if (!(await aiAgent.isOracle(oracle, ...at))) {
    problems.push(
      `agent.isOracle(${oracle}) is false: ${plan.oracle ? "ORACLE_ADDRESS" : "the deploy wallet"} does not hold the oracle role`,
    );
  }
  if (plan.oracle && (await aiAgent.isOracle(deployer.address, ...at))) {
    problems.push(
      `agent.isOracle(${deployer.address}) is true: the deploy wallet holds the oracle role`,
    );
  }

  problems.push(...(await feeProblems(ethers, { plan, aiAgentEscrow, at })));

  if (plan.expectedSymbol) {
    problems.push(...(await symbolProblems(ethers, plan, at)));
  }
  return problems;
}

/** Each fee the escrow holds that is not the planned one. */
async function feeProblems(ethers, { plan, aiAgentEscrow, at = [] }) {
  let decimals;
  try {
    decimals = await readDecimals(ethers, plan.token, at);
  } catch {
    return [
      `token.decimals() could not be read from TOKEN_CONTRACT_ADDRESS ${plan.token}, so the fees were not compared`,
    ];
  }
  const planned = plannedFees(ethers, plan, decimals);
  const problems = [];
  for (const [key, getter] of Object.entries(FEE_GETTERS)) {
    const actual = await aiAgentEscrow[getter](...at);
    const { wei, isDefault } = planned[key];
    if (actual !== wei) {
      problems.push(
        `escrow.${getter}() is ${actual}, not ${isDefault ? `the default for ${FEE_VARS[key]}` : FEE_VARS[key]} ${wei}`,
      );
    }
  }
  return problems;
}

const ERC20_READS = Object.freeze([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

async function readDecimals(ethers, tokenAddress, at = []) {
  const token = new ethers.Contract(tokenAddress, ERC20_READS, ethers.provider);
  return Number(await token.decimals(...at));
}

/**
 * Each fee in wei, with whether it is the local default. The settings have been checked to be
 * whole numbers of wei; the defaults are whole tokens, so they take the token's decimals.
 */
function plannedFees(ethers, plan, decimals) {
  const fees = {};
  for (const key of Object.keys(FEE_VARS)) {
    const value = plan.fees?.[key];
    fees[key] = isSet(value)
      ? { wei: BigInt(String(value).trim()), isDefault: false }
      : { wei: ethers.parseUnits(DEFAULT_FEES_IN_TOKENS[key], decimals), isDefault: true };
  }
  return fees;
}

/**
 * What the token is, read before anything is sent: whether there is a contract at the address,
 * its symbol (against EXPECTED_FEE_TOKEN_SYMBOL when the plan names one) and its decimals, which
 * the plan's fees are shown in.
 */
async function readFeeToken(ethers, plan) {
  const problems = [];
  if ((await ethers.provider.getCode(plan.token)) === "0x") {
    return {
      problems: [`there is no contract at TOKEN_CONTRACT_ADDRESS ${plan.token}`],
    };
  }
  const token = new ethers.Contract(plan.token, ERC20_READS, ethers.provider);
  let symbol = null;
  try {
    symbol = await token.symbol();
  } catch {
    problems.push(`token.symbol() could not be read from TOKEN_CONTRACT_ADDRESS ${plan.token}`);
  }
  if (symbol !== null && plan.expectedSymbol && symbol !== plan.expectedSymbol) {
    problems.push(
      `token.symbol() is ${JSON.stringify(symbol)}, which is not EXPECTED_FEE_TOKEN_SYMBOL`,
    );
  }
  let decimals = null;
  try {
    decimals = await readDecimals(ethers, plan.token);
  } catch {
    problems.push(
      `token.decimals() could not be read from TOKEN_CONTRACT_ADDRESS ${plan.token}, so the fees cannot be shown in whole tokens`,
    );
  }
  return { problems, symbol, decimals };
}

async function symbolProblems(ethers, plan, at = []) {
  const token = new ethers.Contract(
    plan.token,
    ["function symbol() view returns (string)"],
    ethers.provider,
  );
  let symbol;
  try {
    symbol = await token.symbol(...at);
  } catch {
    return [`token.symbol() could not be read from TOKEN_CONTRACT_ADDRESS ${plan.token}`];
  }
  if (symbol === plan.expectedSymbol) return [];
  return [`token.symbol() is ${JSON.stringify(symbol)}, which is not EXPECTED_FEE_TOKEN_SYMBOL`];
}

// How often a live read-back polls for the link's block, and reads the pair again after a read
// that failed or differed, before it gives up.
const READ_BACK_ATTEMPTS = 6;
const READ_BACK_WAIT_MS = 2000;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The fresh pair's read-back at `linkBlock`, the block that mined the link. A load-balanced public
 * RPC can answer from a node behind the one that mined it, which would report a correct pair as
 * unlinked; every value is read at that block instead, once the node answering has it. On a live
 * network a read that fails or differs is made again, up to READ_BACK_ATTEMPTS times; at a pinned
 * block a difference that stays is real. A local network reads once. Gives back the last list of
 * problems a read gave, or throws when no read succeeded, naming the block and the error's code only (an
 * ethers error can carry the request).
 */
async function readBackFreshPair(
  env,
  args,
  {
    linkBlock,
    provider = env.ethers.provider,
    sleep = () => wait(READ_BACK_WAIT_MS),
    attempts = READ_BACK_ATTEMPTS,
  },
) {
  const tries = LOCAL_NETWORKS.has(env.network.name) ? 1 : attempts;
  for (let poll = 1; poll < tries && (await provider.getBlockNumber()) < linkBlock; poll += 1) {
    await sleep();
  }
  let problems = null;
  let failure = null;
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      problems = await freshPairProblems(env, { ...args, blockTag: linkBlock });
      failure = null;
      if (problems.length === 0) return problems;
    } catch (error) {
      failure = error;
    }
    if (attempt < tries) await sleep();
  }
  if (problems) return problems;
  throw new Error(
    `The read-back could not read the pair at block ${linkBlock} after ${tries} attempt(s) (${failure?.code ?? failure?.name ?? "error"}).`,
  );
}

/** The line that records the new pair, so a second run upgrades it rather than deploying another. */
function recordPairLine({ plan, agentAddress, escrowAddress }) {
  return `In ${plan.envFile}: AI_AGENT_CONTRACT_ADDRESS=${agentAddress}, AI_AGENT_ESCROW_CONTRACT_ADDRESS=${escrowAddress}, DEPLOY_MODE=upgrade.`;
}

function handOverSteps({ plan, deployer, agentAddress, escrowAddress }) {
  const run = `ENV_FILE=${plan.envFile} HARDHAT_NETWORK=${plan.networkName} node scripts/authorize-oracle.js`;
  return [
    chalk.yellow(
      `The deploy wallet ${deployer} is the agent's first oracle. Move the role to the oracle's own address before the ownership handover, in this order (docs/BASE_TESTNET_DEPLOY_RUNBOOK.md, section 1.1):`,
    ),
    `  1. ${recordPairLine({ plan, agentAddress, escrowAddress })}`,
    "  2. Start the oracle on this pair and read the signer= address from its [OracleKeys] start-up line.",
    `  3. In ${plan.envFile}: ORACLE_ADDRESS=<signer>. Then: ${run} grant`,
    "  4. See one prompt answered by it, and take that answer's transaction hash.",
    `  5. In ${plan.envFile}: ANSWER_TX_HASH=<answer tx>. Then: ${run} retire-deployer`,
    `  6. Then empty ORACLE_ADDRESS and ANSWER_TX_HASH in ${plan.envFile}: a fresh deploy on a live network refuses a set ORACLE_ADDRESS.`,
    `  The hand-over reads both settings from ${plan.envFile} alone and refuses one typed on the command line.`,
  ];
}

/**
 * Deploys a new agent and escrow, links them, and reads them back. Throws before sending
 * anything when the plan is not fresh, names a first oracle on a live network, or names the deploy
 * wallet or the zero address as ORACLE_ADDRESS, and after the deploy when the read-back finds a
 * difference, naming each.
 */
async function deployFreshPair(
  env,
  plan,
  { log = console.log, deployer: given, readBackView = (contract) => contract } = {},
) {
  const { ethers, upgrades } = env;
  if (plan.mode !== "fresh") {
    throw new Error(
      `deployFreshPair deploys a fresh pair only; this plan is DEPLOY_MODE=${plan.mode}`,
    );
  }
  if (plan.live && plan.oracle) {
    throw new Error(`${liveOracleProblem(plan.networkName, plan.oracle)} Nothing was sent.`);
  }
  const deployer = given ?? (await ethers.getSigners())[0];
  if (plan.oracle && same(plan.oracle, deployer.address)) {
    throw new Error(
      `ORACLE_ADDRESS is the deploy wallet ${deployer.address}. It is set so that the deploy key never holds the oracle role: name the address the oracle answers from, or leave it unset (the deploy wallet is then the first oracle, and scripts/authorize-oracle.js moves the role). Nothing was sent.`,
    );
  }
  if (plan.oracle && same(plan.oracle, ethers.ZeroAddress)) {
    throw new Error(
      "ORACLE_ADDRESS is the zero address, which no oracle can answer from (the agent's initializer would refuse it). Name the address the oracle answers from, or leave it unset. Nothing was sent.",
    );
  }
  const feeSettingProblems = Object.entries(FEE_VARS)
    .map(([key, name]) => feeValueProblem(name, plan.fees?.[key]))
    .filter(Boolean);
  const token = await readFeeToken(ethers, plan);
  const before = [...feeSettingProblems, ...token.problems];
  if (before.length > 0) {
    throw new Error(`Fresh deploy refused:\n  - ${before.join("\n  - ")}\nNothing was sent.`);
  }
  const oracle = plan.oracle ? ethers.getAddress(plan.oracle) : deployer.address;
  const treasury = plan.treasury ? ethers.getAddress(plan.treasury) : deployer.address;
  const fees = plannedFees(ethers, plan, token.decimals);
  for (const line of planLines({ plan, deployer, oracle, treasury, token, fees, ethers })) {
    log(line);
  }
  if (plan.dryRun) {
    log(
      chalk.yellow(
        "DRY_RUN=1: nothing was sent. Run the deploy without DRY_RUN to send this plan (on Base mainnet with DEPLOY_MAINNET_CONFIRMED=1).",
      ),
    );
    return null;
  }

  const EVMAIAgent = await ethers.getContractFactory("EVMAIAgent", deployer);
  const EVMAIAgentEscrow = await ethers.getContractFactory("EVMAIAgentEscrow", deployer);

  log("Deploying EVMAIAgent proxy...");
  const aiAgent = await upgrades.deployProxy(EVMAIAgent, [plan.domain, oracle, deployer.address], {
    initializer: "initialize",
    kind: "uups",
  });
  await waitDeployed(env, aiAgent);
  const agentAddress = await aiAgent.getAddress();
  log(`✅ EVMAIAgent proxy deployed to: ${chalk.cyan(agentAddress)}`);

  log("Deploying EVMAIAgentEscrow proxy...");
  const aiAgentEscrow = await upgrades.deployProxy(
    EVMAIAgentEscrow,
    [
      plan.token,
      agentAddress,
      treasury,
      deployer.address,
      fees.prompt.wei,
      fees.cancellation.wei,
      fees.metadata.wei,
      fees.branch.wei,
    ],
    { initializer: "initialize", kind: "uups" },
  );
  await waitDeployed(env, aiAgentEscrow);
  const escrowAddress = await aiAgentEscrow.getAddress();
  log(`✅ EVMAIAgentEscrow proxy deployed to: ${chalk.cyan(escrowAddress)}`);

  // A new agent has no escrow yet. One that has is not the agent just deployed.
  const currentEscrow = await aiAgent.aiAgentEscrow();
  if (currentEscrow !== ethers.ZeroAddress) {
    throw new Error(
      `The new agent ${agentAddress} already names an escrow (${currentEscrow}), so it was not linked to the new escrow ${escrowAddress}. Point nothing at this pair.`,
    );
  }
  log("Linking AI Agent to Escrow contract...");
  const linkReceipt = await sendOwnerCall(env, deployer, aiAgent.setAgentEscrow, [escrowAddress]);
  log("✅ Link successful.");

  // Read back at the link's block, so a node behind the one that mined it cannot fail a correct
  // pair. `readBackView` lets a test stand in a node that lags.
  let problems;
  try {
    problems = await readBackFreshPair(
      env,
      {
        plan,
        aiAgent: readBackView(aiAgent),
        aiAgentEscrow: readBackView(aiAgentEscrow),
        deployer,
      },
      { linkBlock: linkReceipt.blockNumber },
    );
  } catch (error) {
    throw new Error(
      `${error.message} The contracts were deployed, at agent ${agentAddress} and escrow ${escrowAddress}, and linked in block ${linkReceipt.blockNumber}: read them back at that block before pointing anything at them or deploying again.`,
    );
  }
  if (problems.length > 0) {
    throw new Error(
      `Fresh deploy read-back failed:\n  - ${problems.join("\n  - ")}\nThe contracts were deployed, at agent ${agentAddress} and escrow ${escrowAddress}: point nothing at them. Fix the setting and deploy a fresh pair again.`,
    );
  }
  reportFreshPair({ plan, log, oracle, deployer: deployer.address, agentAddress, escrowAddress });
  return {
    aiAgent,
    aiAgentEscrow,
    aiAgentAddress: agentAddress,
    aiAgentEscrowAddress: escrowAddress,
  };
}

/**
 * The plan as the operator reads it before anything is sent: who deploys, the token, the
 * treasury, the first oracle and each fee in wei and in whole tokens. No fee is refused for its
 * size: each is printed so that a fee off by a power of ten is seen here.
 */
function planLines({ plan, deployer, oracle, treasury, token, fees, ethers }) {
  const lines = [
    chalk.bold(`Fresh pair on ${plan.networkName}. Check every line before anything is sent:`),
    `  Deploy wallet: ${deployer.address}`,
    `  Fee token: ${plan.token} (symbol ${JSON.stringify(token.symbol)}, ${token.decimals} decimals)`,
    `  Treasury: ${treasury}${plan.treasury ? " (TREASURY_ADDRESS)" : " (the deploy wallet)"}`,
    `  First oracle: ${oracle}${plan.oracle ? " (ORACLE_ADDRESS)" : " (the deploy wallet)"}`,
    `  Domain: ${plan.domain}`,
  ];
  for (const [key, name] of Object.entries(FEE_VARS)) {
    const { wei, isDefault } = fees[key];
    const tokens = ethers.formatUnits(wei, token.decimals);
    const note = isDefault ? ` (default: ${name} is not set)` : "";
    lines.push(`  ${FEE_LABELS[key]} (${name}): ${wei} wei = ${tokens} ${token.symbol}${note}`);
  }
  return lines;
}

function reportFreshPair({ plan, log, oracle, deployer, agentAddress, escrowAddress }) {
  const symbolNote = plan.expectedSymbol
    ? ", and the token's symbol is EXPECTED_FEE_TOKEN_SYMBOL"
    : "";
  log(
    chalk.green(
      `✅ Read back: the two links, the token, the treasury, both owners, the oracle role and the four fees are as planned${symbolNote}.`,
    ),
  );
  if (!plan.expectedSymbol) {
    log(
      chalk.yellow("EXPECTED_FEE_TOKEN_SYMBOL is not set, so the token's symbol was not checked."),
    );
  }
  if (plan.oracle) {
    log(`ORACLE_ADDRESS ${oracle} holds the oracle role; the deploy wallet does not.`);
    log(
      chalk.yellow(
        `Record the pair now, so that a second run upgrades it rather than deploying another. ${recordPairLine({ plan, agentAddress, escrowAddress })}`,
      ),
    );
    return;
  }
  for (const line of handOverSteps({ plan, deployer, agentAddress, escrowAddress })) log(line);
}

// --- upgrade --------------------------------------------------------------------------------

/** Upgrades both proxies the plan names. Refuses a dry-run plan before anything is read or sent. */
async function upgradePair(env, plan, { log = console.log } = {}) {
  const { ethers, upgrades } = env;
  if (plan.mode !== "upgrade") {
    throw new Error(`upgradePair upgrades a pair only; this plan is DEPLOY_MODE=${plan.mode}`);
  }
  if (plan.dryRun) {
    throw new Error(
      "DRY_RUN=1 prints the plan of a fresh pair; an upgrade has no dry run. Nothing was sent.",
    );
  }
  const [deployer] = await ethers.getSigners();
  const EVMAIAgent = await ethers.getContractFactory("EVMAIAgent", deployer);
  const EVMAIAgentEscrow = await ethers.getContractFactory("EVMAIAgentEscrow", deployer);

  log(`Found existing EVMAIAgent at: ${chalk.yellow(plan.agent)}`);
  log("Checking for EVMAIAgent upgrade...");
  // Upgrading from the single-oracle version: carry the stored oracle over to the oracle
  // role inside the upgrade transaction, so the proxy is never upgraded with no oracle.
  const migrateOracle = await needsOracleRoleMigration(ethers.provider, plan.agent);
  if (migrateOracle) {
    log("Legacy oracle address found: migrating it to the oracle role in the upgrade.");
  }
  const aiAgent = await upgrades.upgradeProxy(
    plan.agent,
    EVMAIAgent,
    migrateOracle ? { call: "migrateOracleRole" } : {},
  );
  await waitDeployed(env, aiAgent);
  const aiAgentAddress = await aiAgent.getAddress();
  log(`✅ EVMAIAgent is up-to-date at: ${chalk.cyan(aiAgentAddress)}`);

  log(`Found existing EVMAIAgentEscrow at: ${chalk.yellow(plan.escrow)}`);
  log("Checking for EVMAIAgentEscrow upgrade...");
  const aiAgentEscrow = await upgrades.upgradeProxy(plan.escrow, EVMAIAgentEscrow);
  await waitDeployed(env, aiAgentEscrow);
  const aiAgentEscrowAddress = await aiAgentEscrow.getAddress();
  log(`✅ EVMAIAgentEscrow is up-to-date at: ${chalk.cyan(aiAgentEscrowAddress)}`);
  return { aiAgent, aiAgentEscrow, aiAgentAddress, aiAgentEscrowAddress };
}

// --- Sapphire -------------------------------------------------------------------------------

/** Standard, non-upgradable contracts with a two-step link. Unchanged by the deploy mode. */
async function deploySapphire(deployer) {
  const { ethers } = hre;
  const oracleAddress = deployer.address;
  const treasuryAddress = process.env.TREASURY_ADDRESS || deployer.address;
  console.log(`Deploying contracts with the account: ${chalk.yellow(deployer.address)}`);
  console.log(`This address will be the first authorized Oracle and the default Treasury.`);
  // The roflAppID is not used on-chain for the EVM version but is kept for consistency.
  const roflAppID = ethers.zeroPadBytes("0x", 21);

  console.log("\nDeploying Sapphire contracts...");
  const SapphireAIAgent = await ethers.getContractFactory("SapphireAIAgent", deployer);
  const SapphireAIAgentEscrow = await ethers.getContractFactory("SapphireAIAgentEscrow", deployer);

  // Step 1: Deploy the AIAgent contract. It does not know about the escrow yet.
  const aiAgent = await SapphireAIAgent.deploy(
    process.env.DOMAIN,
    roflAppID,
    oracleAddress,
    deployer.address,
  );
  await waitDeployed(hre, aiAgent);
  const aiAgentAddress = await aiAgent.getAddress();
  console.log(`✅ SapphireAIAgent deployed to: ${chalk.cyan(aiAgentAddress)}`);

  // Step 2: Deploy the Escrow contract, passing the agent's address.
  const aiAgentEscrow = await SapphireAIAgentEscrow.deploy(
    aiAgentAddress,
    treasuryAddress,
    oracleAddress,
    deployer.address,
  );
  await waitDeployed(hre, aiAgentEscrow);
  const aiAgentEscrowAddress = await aiAgentEscrow.getAddress();
  console.log(`✅ SapphireAIAgentEscrow deployed to: ${chalk.cyan(aiAgentEscrowAddress)}`);

  // Step 3: Complete the link by calling the setter on the AIAgent.
  console.log("Linking AI Agent to Escrow contract...");
  const nonce = await ethers.provider.getTransactionCount(deployer.address, "pending");
  const fees = await getSafeFees(ethers.provider);
  await sendWithBump(aiAgent.setAgentEscrow, [aiAgentEscrowAddress], { nonce, ...fees });
  console.log("✅ Link successful.");
}

// --- verification ---------------------------------------------------------------------------

async function verifyOnExplorer(networkName, addresses) {
  if (!process.env.ETHERSCAN_API_KEY) {
    console.warn(
      chalk.yellow("\n⚠️  Skipping verification: ETHERSCAN_API_KEY not found in .env file."),
    );
    return;
  }
  console.log(
    chalk.blue(
      "\nWaiting for 60 seconds before starting verification to allow for block propagation...",
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 60000));
  for (const [name, address] of addresses) {
    try {
      console.log(`Verifying ${name} proxy on Etherscan...`);
      await hre.run("verify:verify", { address });
      console.log(chalk.green(`✅ ${name} verified!`));
      console.log(chalk.cyan(`   Explorer: ${explorerFor(networkName)}/address/${address}#code`));
    } catch (error) {
      console.error(chalk.red("Verification failed:", error.message));
    }
  }
}

async function main() {
  const networkName = hre.network.name;
  const envFile = process.env.ENV_FILE;
  const isSapphire = SAPPHIRE_NETWORKS.has(networkName);
  const plan = resolveDeployPlan({
    networkName,
    envFile,
    fileEnv: isSapphire ? null : readEnvFile(envFile),
    processEnv: process.env,
    // Recorded by hardhat.config.js before the env files loaded.
    typedEnv: typedSettings(process.env),
  });

  console.log(`\n--- Starting deployment to ${chalk.bold(networkName)} ---`);

  // Required env
  if (!process.env.DOMAIN || !process.env.PRIVATE_KEY) {
    throw new Error("Missing required environment variables. Please check DOMAIN or PRIVATE_KEY.");
  }
  const [deployer] = await hre.ethers.getSigners();

  if (plan.isSapphire) {
    await deploySapphire(deployer);
    console.log("\n--- Deployment Finished ---");
    return;
  }

  console.log(`\nDEPLOY_MODE=${plan.mode} (from ${envFile})`);
  // An upgrade has no dry run: upgradePair refuses DRY_RUN=1 itself, before anything is read.
  const pair =
    plan.mode === "fresh"
      ? await deployFreshPair(hre, plan, { deployer })
      : await upgradePair(hre, plan);

  if (!pair) {
    console.log("\n--- Dry run finished ---");
    return;
  }
  if (plan.live) {
    await verifyOnExplorer(networkName, [
      ["EVMAIAgent", pair.aiAgentAddress],
      ["EVMAIAgentEscrow", pair.aiAgentEscrowAddress],
    ]);
  }

  console.log("\n--- Deployment Finished ---");
}

module.exports = {
  FILE_ONLY_VARS,
  FRESH_LIVE_FILE_ONLY_VARS,
  DEPLOY_MODES,
  LOCAL_NETWORKS,
  resolveDeployPlan,
  deployFreshPair,
  freshPairProblems,
  readBackFreshPair,
  upgradePair,
  deployProblems,
  assertDeployAllowed,
  explorerFor,
  needsOracleRoleMigration,
  CONFIRM_VAR,
  MAINNET_NETWORK,
  TYPED_ONLY_VARS,
};

if (require.main === module) {
  main().catch((error) => {
    // Never the error or its stack: an ethers error's message carries the request's address.
    console.error(chalk.red(failureText(error)));
    process.exitCode = 1;
  });
}
