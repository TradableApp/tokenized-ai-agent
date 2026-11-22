/**
 * Moves the oracle role off the deploy wallet after a fresh deploy, in the order of section 1.1
 * of docs/BASE_TESTNET_DEPLOY_RUNBOOK.md. Two phases, each run on its own:
 *
 *   grant            gives ORACLE_ADDRESS (the oracle's own signer) the role, and checks it holds it.
 *   retire-deployer  removes the deploy wallet's role, only once ORACLE_ADDRESS holds the role and
 *                    ANSWER_TX_HASH is a submitAnswer to the agent sent by ORACLE_ADDRESS.
 *
 * Owner calls, signed by the deploy wallet until the ownership handover; once the Safe owns the
 * agent the script refuses and names the Safe's path. Run with the network and env file named:
 *
 *   ORACLE_ADDRESS=0x… ENV_FILE=.env.base-testnet HARDHAT_NETWORK=baseSepolia node scripts/authorize-oracle.js grant
 *   ORACLE_ADDRESS=0x… ANSWER_TX_HASH=0x… ENV_FILE=… HARDHAT_NETWORK=… node scripts/authorize-oracle.js retire-deployer
 *
 * (or `bun run authorize-oracle:<network> <phase>`). On Base mainnet a phase that sends needs
 * DEPLOY_MAINNET_CONFIRMED=1.
 *
 * On a live network the agent, the escrow and the token are read from ENV_FILE alone (one that
 * only the root .env or the shell sets is refused), and all three are printed before anything is
 * read or sent. ORACLE_ADDRESS and ANSWER_TX_HASH are given on the command line, as above.
 */
const chalk = require("chalk");

const { describeShape, isSet } = require("./lib/settingShape");
const { readEnvFile } = require("./lib/envFile");
const { PAIR_TARGET_VARS, resolveTarget, shown } = require("./lib/pairTarget");

const PHASES = Object.freeze(["grant", "retire-deployer"]);
const MAINNET_NETWORK = "base";
const CONFIRM_VAR = "DEPLOY_MAINNET_CONFIRMED";
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/** One of the script's own refusals: its message says what happened and what to do. */
class HandoverError extends Error {
  constructor(message) {
    super(message);
    this.name = "HandoverError";
  }
}

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const NOTHING_SENT = "Nothing was sent.";

function oracleAddressFrom(env, signer) {
  const value = env.ORACLE_ADDRESS;
  if (!isSet(value)) {
    throw new HandoverError(
      `ORACLE_ADDRESS is required: the address the oracle answers from (the signer= on its [OracleKeys] start-up line). ${NOTHING_SENT}`,
    );
  }
  if (!ADDRESS_RE.test(value)) {
    throw new HandoverError(
      `ORACLE_ADDRESS is not an address (${describeShape(value)}). ${NOTHING_SENT}`,
    );
  }
  if (same(value, signer)) {
    throw new HandoverError(
      `ORACLE_ADDRESS is the signer ${signer}, the deploy wallet whose role this moves away. Name the address the oracle answers from. ${NOTHING_SENT}`,
    );
  }
  return value;
}

async function assertSignerOwnsAgent({ agent, signer }) {
  const owner = await agent.owner();
  if (same(owner, signer)) return;
  throw new HandoverError(
    `The agent's owner is ${owner}, not the signer ${signer}. Once ownership is with the Safe, only the Safe can add or remove an oracle: queue agent.addOracle(<oracle>) and, after the oracle has answered from it, agent.removeOracle(<deploy wallet>) from the Safe (Transaction Builder), in the order of section 1.1 of docs/BASE_TESTNET_DEPLOY_RUNBOOK.md. ${NOTHING_SENT}`,
  );
}

function assertMainnetConfirmed({ networkName, env }) {
  if (networkName !== MAINNET_NETWORK || env[CONFIRM_VAR] === "1") return;
  throw new HandoverError(
    `${CONFIRM_VAR} is ${describeShape(env[CONFIRM_VAR])}; an owner call on ${MAINNET_NETWORK} needs exactly ${CONFIRM_VAR}=1. ${NOTHING_SENT}`,
  );
}

async function grant({ agent, oracle, networkName, env, log }) {
  if (await agent.isOracle(oracle)) {
    log(`${oracle} already holds the oracle role. ${NOTHING_SENT}`);
    return { sent: [] };
  }
  assertMainnetConfirmed({ networkName, env });
  const receipt = await (await agent.addOracle(oracle)).wait();
  log(`agent.addOracle(${oracle}) tx: ${receipt.hash} (block ${receipt.blockNumber})`);
  if (!(await agent.isOracle(oracle))) {
    throw new HandoverError(
      `agent.addOracle(${oracle}) was mined as ${receipt.hash}, but agent.isOracle(${oracle}) is false. Do not remove the deploy wallet's role; find out why first.`,
    );
  }
  log(
    chalk.green(
      `${oracle} holds the oracle role. Next: see one prompt answered by it, then run retire-deployer with ANSWER_TX_HASH set to that answer's transaction.`,
    ),
  );
  return { sent: [receipt.hash] };
}

/** Refuses unless `hash` is a mined, successful submitAnswer to the agent sent by `oracle`. */
async function assertAnsweredBy({ agent, provider, oracle, hash }) {
  if (!isSet(hash)) {
    throw new HandoverError(
      `ANSWER_TX_HASH is required: the transaction of one answer the oracle sent from ORACLE_ADDRESS (the smoke test's answerTxHash). The deploy wallet's role is removed only after the oracle has answered as itself. ${NOTHING_SENT}`,
    );
  }
  if (!TX_HASH_RE.test(hash)) {
    throw new HandoverError(
      `ANSWER_TX_HASH is not a transaction hash (${describeShape(hash)}). ${NOTHING_SENT}`,
    );
  }
  const [tx, receipt] = await Promise.all([
    provider.getTransaction(hash),
    provider.getTransactionReceipt(hash),
  ]);
  if (!tx || !receipt) {
    throw new HandoverError(
      `ANSWER_TX_HASH ${hash} was not found on this network (or is not mined yet). ${NOTHING_SENT}`,
    );
  }
  const agentAddress = await agent.getAddress();
  let call = null;
  try {
    call = agent.interface.parseTransaction({ data: tx.data });
  } catch {
    call = null;
  }
  if (!tx.to || !same(tx.to, agentAddress) || call?.name !== "submitAnswer") {
    throw new HandoverError(
      `ANSWER_TX_HASH ${hash} is not a submitAnswer call to the agent ${agentAddress}. ${NOTHING_SENT}`,
    );
  }
  if (receipt.status !== 1) {
    throw new HandoverError(
      `ANSWER_TX_HASH ${hash} is a submitAnswer that reverted, so it answered nothing. ${NOTHING_SENT}`,
    );
  }
  if (!same(tx.from, oracle)) {
    throw new HandoverError(
      `ANSWER_TX_HASH ${hash} was sent by ${tx.from}, not ORACLE_ADDRESS ${oracle}: it does not show the oracle answering as itself. ${NOTHING_SENT}`,
    );
  }
}

async function retireDeployer({ agent, signer, oracle, provider, networkName, env, log }) {
  if (!(await agent.isOracle(oracle))) {
    throw new HandoverError(
      `ORACLE_ADDRESS ${oracle} does not hold the oracle role. Run the grant phase first: removing the deploy wallet's role now could leave the agent with no oracle, and users' prompts paid and unanswered. ${NOTHING_SENT}`,
    );
  }
  await assertAnsweredBy({ agent, provider, oracle, hash: env.ANSWER_TX_HASH });
  if (!(await agent.isOracle(signer))) {
    log(`The deploy wallet ${signer} does not hold the oracle role. ${NOTHING_SENT}`);
    return { sent: [] };
  }
  assertMainnetConfirmed({ networkName, env });
  const receipt = await (await agent.removeOracle(signer)).wait();
  log(`agent.removeOracle(${signer}) tx: ${receipt.hash} (block ${receipt.blockNumber})`);
  const [signerHolds, oracleHolds] = await Promise.all([
    agent.isOracle(signer),
    agent.isOracle(oracle),
  ]);
  if (signerHolds || !oracleHolds) {
    throw new HandoverError(
      `agent.removeOracle(${signer}) was mined as ${receipt.hash}, but agent.isOracle(${signer}) is ${signerHolds} and agent.isOracle(${oracle}) is ${oracleHolds}. Check the agent's oracles now.`,
    );
  }
  log(
    chalk.green(
      `The deploy wallet ${signer} no longer holds the oracle role; ${oracle} still does.`,
    ),
  );
  return { sent: [receipt.hash] };
}

/**
 * Runs one phase. `agent` is the EVMAIAgent contract; it is connected to `signer` here. Every
 * input is a parameter, so the refusals can be tested where the script runs them.
 */
async function runHandover({ phase, agent, signer, provider, env, networkName, log }) {
  if (!PHASES.includes(phase)) {
    throw new HandoverError(
      `Name the phase: one of ${PHASES.join(", ")} (for example node scripts/authorize-oracle.js grant). ${NOTHING_SENT}`,
    );
  }
  const connected = agent.connect(signer);
  await assertSignerOwnsAgent({ agent: connected, signer: signer.address });
  const oracle = oracleAddressFrom(env, signer.address);
  const args = {
    agent: connected,
    signer: signer.address,
    oracle,
    provider,
    networkName,
    env,
    log,
  };
  return phase === "grant" ? grant(args) : retireDeployer(args);
}

/**
 * The agent, escrow and token this run acts on, or a refusal listing every problem. On a live
 * network all three come from ENV_FILE alone and must be set; locally only the agent is needed.
 */
function resolveHandoverTarget({ networkName, envFile, fileEnv, processEnv }) {
  const { values, problems } = resolveTarget({
    networkName,
    envFile,
    fileEnv,
    processEnv,
    vars: PAIR_TARGET_VARS,
    addressKeys: Object.keys(PAIR_TARGET_VARS),
    requiredLive: Object.keys(PAIR_TARGET_VARS),
    requiredLocal: ["agent"],
    howToRun:
      "Run it through its package script (for example bun run authorize-oracle:base-testnet grant).",
  });
  if (problems.length > 0) {
    throw new HandoverError(
      `Oracle hand-over on ${networkName} refused:\n  - ${problems.join("\n  - ")}\n${NOTHING_SENT}`,
    );
  }
  return values;
}

/** The run's header: the network, the phase, the signer and the pair it acts on. */
function targetLines({ networkName, envFile, phase, signer, target }) {
  return [
    `--- Oracle hand-over on ${chalk.bold(networkName)} · phase=${phase} · signer=${signer} ---`,
    `  Agent: ${shown(target.agent)}`,
    `  Escrow: ${shown(target.escrow)}`,
    `  Fee token: ${shown(target.token)}`,
    `  Settings from: ${envFile ?? "the environment (ENV_FILE is not set)"}`,
  ];
}

async function main() {
  const hre = require("hardhat");
  const { env } = process;
  const networkName = hre.network.name;
  const target = resolveHandoverTarget({
    networkName,
    envFile: env.ENV_FILE,
    fileEnv: readEnvFile(env.ENV_FILE),
    processEnv: env,
  });
  const [signer] = await hre.ethers.getSigners();
  const phase = process.argv[2];
  const log = (line) => console.log(line);
  for (const line of targetLines({
    networkName,
    envFile: env.ENV_FILE,
    phase,
    signer: signer.address,
    target,
  })) {
    log(line);
  }
  const agent = await hre.ethers.getContractAt("EVMAIAgent", target.agent);
  await runHandover({
    phase,
    agent,
    signer,
    provider: hre.ethers.provider,
    env,
    networkName: hre.network.name,
    log,
  });
}

module.exports = { PHASES, runHandover, resolveHandoverTarget, targetLines, HandoverError };

if (require.main === module) {
  main().catch((error) => {
    console.error(chalk.red(error instanceof HandoverError ? error.message : error?.stack));
    process.exitCode = 1;
  });
}
