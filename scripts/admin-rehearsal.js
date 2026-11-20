const hre = require("hardhat");
const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");
const chalk = require("chalk");

const { sameValue, isRevert } = require("./rehearsal/values");
const { writeSnapshot, readSnapshot } = require("./rehearsal/snapshot");

const { ethers } = hre;

const DEFAULT_REHEARSAL_PROMPT_FEE_TOKENS = "2";
const PHASES = new Set(["forward", "confirm"]);
const MAINNET_NETWORK = "base";
const RECOVERY_HINT =
  "Re-run the forward phase to resume: the existing snapshot stays the restore baseline and steps whose getter already holds the target are skipped. Run REHEARSAL_PHASE=confirm to list what differs from the snapshot; a proxy whose pending owner is the Safe needs acceptOwnership() from the Safe; a proxy owned by the Safe is returned with transferOwnership(<deploy wallet>) from the Safe, and then accepted by the confirm phase from this wallet.";
// Public RPC endpoints are load-balanced; the node that answers the read-back may not have the
// block the receipt came from yet. Read at that block and retry rather than fail a landed tx.
const VERIFY_ATTEMPTS = 5;
const VERIFY_RETRY_MS = 2000;
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CONTRACT_KEYS = { agent: "aiAgent", escrow: "escrow" };
const ORACLE_ROLE = ethers.id("ORACLE_ROLE");

/**
 * The oracle set cannot be listed from the contract, so the snapshot watches one address: the
 * live oracle named by the caller. Its authorization is recorded before the rehearsal and
 * compared afterwards, so a rehearsal that leaves the live oracle without its role is caught.
 *
 * The encryption key clients read from the agent is in the snapshot too, with its publisher:
 * removing the publishing oracle withdraws the key, and clients then cannot submit a prompt.
 */
async function readState({ aiAgent, escrow, oracleAddress }) {
  const [agentOwner, escrowOwner, treasury, promptFee, encryption] = await Promise.all([
    aiAgent.owner(),
    escrow.owner(),
    escrow.treasury(),
    escrow.promptFee(),
    readEncryptionKey(aiAgent),
  ]);
  const state = { agentOwner, escrowOwner, treasury, promptFee, ...encryption };
  if (!oracleAddress) {
    return state;
  }
  const oracle = ethers.getAddress(oracleAddress);
  return { ...state, oracle, oracleAuthorized: await aiAgent.isOracle(oracle) };
}

/**
 * The published encryption key and its publisher, or neither when a getter reverts. A proxy
 * from before the key has neither getter; one from the version between has the key but not the
 * publisher. Both are left out in either case, so the snapshot never holds half of the pair,
 * and the rehearsal still runs against such a proxy. Any other failure is thrown.
 */
async function readEncryptionKey(aiAgent) {
  try {
    const [encryptionKey, encryptionKeyPublisher] = await Promise.all([
      aiAgent.oracleEncryptionKey(),
      aiAgent.oracleEncryptionKeyPublisher(),
    ]);
    return { encryptionKey, encryptionKeyPublisher };
  } catch (error) {
    if (!isRevert(error)) {
      throw error;
    }
    return {};
  }
}

const NO_ENCRYPTION_KEY_NOTE =
  "The encryption key is not in the snapshot (the agent did not have one to read when it was taken), so it is not checked.";

function assertSafeAddress(safeAddress, state) {
  if (!ethers.isAddress(safeAddress) || safeAddress === ethers.ZeroAddress) {
    throw new Error(`Safe address is not a usable address: ${safeAddress}`);
  }
  const safe = ethers.getAddress(safeAddress);
  if (
    safe === ethers.getAddress(state.agentOwner) ||
    safe === ethers.getAddress(state.escrowOwner)
  ) {
    throw new Error(`Safe ${safe} already owns a proxy; the transfer would rehearse nothing`);
  }
  return safe;
}

function assertSignerOwnsBoth(signerAddress, state) {
  const signer = ethers.getAddress(signerAddress);
  if (
    signer !== ethers.getAddress(state.agentOwner) ||
    signer !== ethers.getAddress(state.escrowOwner)
  ) {
    throw new Error(
      `Signer ${signer} does not own both proxies (agentOwner=${state.agentOwner}, escrowOwner=${state.escrowOwner})`,
    );
  }
}

async function assertSafeHasCode(safe) {
  const code = await ethers.provider.getCode(safe);
  if (code === "0x") {
    throw new Error(`Safe ${safe} has no contract code; an EOA cannot stand in for the Safe`);
  }
}

function assertMainnetConfirmed({ networkName, dryRun, confirmed }) {
  if (networkName === MAINNET_NETWORK && !dryRun && confirmed !== "1") {
    throw new Error(
      `Live run on ${networkName} refused: set REHEARSAL_MAINNET_CONFIRMED=1 to send owner transactions on Base mainnet`,
    );
  }
}

/** The confirm phase sends the acceptance, so there is nothing a dry run of it could simulate. */
function assertPhaseCanDryRun({ phase, dryRun }) {
  if (dryRun && phase === "confirm") {
    throw new Error(
      "The confirm phase has no dry run: it sends a transaction. Unset DRY_RUN to run it.",
    );
  }
}

function step(id, contract, method, args, event, verify) {
  return { id, contract, method, args, event, verify };
}

function buildPlan({ state, safeAddress, rehearsalPromptFee }) {
  const safe = assertSafeAddress(safeAddress, state);
  const fee = BigInt(rehearsalPromptFee);
  if (fee === BigInt(state.promptFee)) {
    throw new Error("Rehearsal prompt fee equals the live fee; the event would prove nothing");
  }

  const feeEvent = (value) => ({ name: "PromptFeeUpdated", args: [value] });
  const feeVerify = (value) => ({ getter: "promptFee", expected: value });
  const addrEvent = (name, value) => ({ name, args: [value] });
  // Ownership moves in two steps. The deploy wallet's transfer only offers it: the Safe becomes
  // the pending owner, and the owner changes when the Safe itself accepts.
  const offerEvent = (from) => ({ name: "OwnershipTransferStarted", args: [from, safe] });
  const offered = { getter: "pendingOwner", expected: safe };
  const roleEvent = (name) => ({ name, args: [ORACLE_ROLE, safe] });

  return [
    step("fee-set", "escrow", "setPromptFee", [fee], feeEvent(fee), feeVerify(fee)),
    step(
      "fee-restore",
      "escrow",
      "setPromptFee",
      [state.promptFee],
      feeEvent(state.promptFee),
      feeVerify(state.promptFee),
    ),
    step("treasury-set", "escrow", "setTreasury", [safe], addrEvent("TreasuryUpdated", safe), {
      getter: "treasury",
      expected: safe,
    }),
    step(
      "treasury-restore",
      "escrow",
      "setTreasury",
      [state.treasury],
      addrEvent("TreasuryUpdated", state.treasury),
      { getter: "treasury", expected: state.treasury },
    ),
    // The Safe is added as a second oracle and removed again. The live oracle keeps its role
    // throughout, so the rehearsal never interrupts answers.
    step("oracle-add", "agent", "addOracle", [safe], roleEvent("RoleGranted"), {
      getter: "isOracle",
      args: [safe],
      expected: true,
    }),
    step("oracle-remove", "agent", "removeOracle", [safe], roleEvent("RoleRevoked"), {
      getter: "isOracle",
      args: [safe],
      expected: false,
    }),
    step(
      "agent-owner-to-safe",
      "agent",
      "transferOwnership",
      [safe],
      offerEvent(state.agentOwner),
      offered,
    ),
    step(
      "escrow-owner-to-safe",
      "escrow",
      "transferOwnership",
      [safe],
      offerEvent(state.escrowOwner),
      offered,
    ),
  ];
}

/** The getter call as text, e.g. `isOracle(0xSafe)`, for logs and errors. */
function getterCall(verify) {
  return `${verify.getter}(${(verify.args ?? []).join(", ")})`;
}

function describeStep(stepDef, target, log) {
  const calldata = target.interface.encodeFunctionData(stepDef.method, stepDef.args);
  log(`\n[${stepDef.id}] ${stepDef.contract}.${stepDef.method}(${stepDef.args.join(", ")})`);
  log(`  to:       ${target.target}`);
  log(`  calldata: ${calldata}`);
  log(`  expects:  ${stepDef.event.name}(${stepDef.event.args.join(", ")})`);
  log(`  verify:   ${getterCall(stepDef.verify)} == ${stepDef.verify.expected}`);
}

function findEvent(receipt, target, stepDef) {
  const topicHash = target.interface.getEvent(stepDef.event.name).topicHash;
  const emitter = String(target.target).toLowerCase();
  const raw = receipt.logs.find(
    (l) => l.topics[0] === topicHash && String(l.address).toLowerCase() === emitter,
  );
  if (!raw) {
    throw new Error(`[${stepDef.id}] ${stepDef.event.name} was not emitted`);
  }
  const parsed = target.interface.parseLog(raw);
  stepDef.event.args.forEach((expected, i) => {
    if (!sameValue(parsed.args[i], expected)) {
      throw new Error(
        `[${stepDef.id}] ${stepDef.event.name} arg ${i} was ${parsed.args[i]}, expected ${expected}`,
      );
    }
  });
}

/**
 * Read the step's getter back at the block the receipt landed in, retrying a stale or lagging
 * node. The first live run on Base Sepolia failed here with the fee correctly set on-chain:
 * the public RPC answered the read from a node behind the receipt's block.
 */
async function verifyGetter(
  target,
  stepDef,
  receipt,
  { attempts = VERIFY_ATTEMPTS, sleep = defaultSleep } = {},
) {
  const { getter, args = [], expected } = stepDef.verify;
  let last = "no response";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const actual = await target[getter](...args, { blockTag: receipt.blockNumber });
      if (sameValue(actual, expected)) return;
      last = String(actual);
    } catch (error) {
      last = `error: ${error.message}`;
    }
    if (attempt < attempts) await sleep(VERIFY_RETRY_MS);
  }
  throw new Error(
    `[${stepDef.id}] ${getterCall(stepDef.verify)} at block ${receipt.blockNumber} is ${last}, expected ${expected} after ${attempts} attempts`,
  );
}

/** True when the chain already holds the step's target value (a step an earlier run completed). */
async function alreadyApplied(target, stepDef) {
  const actual = await target[stepDef.verify.getter](...(stepDef.verify.args ?? []));
  return sameValue(actual, stepDef.verify.expected);
}

async function runPlan({ plan, contracts, signer, dryRun, log }) {
  const results = [];
  for (const stepDef of plan) {
    const target = contracts[CONTRACT_KEYS[stepDef.contract]].connect(signer);
    describeStep(stepDef, target, log);

    if (dryRun) {
      try {
        await target[stepDef.method].staticCall(...stepDef.args);
      } catch (error) {
        throw new Error(
          `[${stepDef.id}] dry run of ${stepDef.contract}.${stepDef.method} would revert: ${error.message}`,
        );
      }
      log("  dry-run:  call simulated OK");
      results.push({ id: stepDef.id, txHash: null, blockNumber: null });
      continue;
    }

    if (await alreadyApplied(target, stepDef)) {
      log(
        `  skip:     ${getterCall(stepDef.verify)} already == ${stepDef.verify.expected} (applied by an earlier run)`,
      );
      results.push({ id: stepDef.id, txHash: null, blockNumber: null, skipped: true });
      continue;
    }

    let receipt;
    try {
      const tx = await target[stepDef.method](...stepDef.args);
      receipt = await tx.wait();
    } catch (error) {
      throw new Error(
        `[${stepDef.id}] ${stepDef.contract}.${stepDef.method} failed: ${error.message}\n${RECOVERY_HINT}`,
      );
    }
    findEvent(receipt, target, stepDef);
    await verifyGetter(target, stepDef, receipt);
    log(`  tx:       ${receipt.hash} (block ${receipt.blockNumber})`);
    results.push({ id: stepDef.id, txHash: receipt.hash, blockNumber: receipt.blockNumber });
  }
  return results;
}

/**
 * What the Safe sends, in this order: it accepts ownership of both proxies, which is what proves
 * it can act as their owner, and then offers ownership back. The deploy wallet accepts that offer
 * in the confirm phase.
 */
async function buildSafeReturnTxs({ contracts, returnTo }) {
  const proxies = [contracts.aiAgent, contracts.escrow];
  const encode = async (contract, method, args) => ({
    to: await contract.getAddress(),
    value: "0",
    data: contract.interface.encodeFunctionData(method, args),
  });
  return [
    ...(await Promise.all(proxies.map((proxy) => encode(proxy, "acceptOwnership", [])))),
    ...(await Promise.all(proxies.map((proxy) => encode(proxy, "transferOwnership", [returnTo])))),
  ];
}

/**
 * Accepts the ownership the Safe offered back, on each proxy where the signer is the pending
 * owner. A proxy whose owner is already the signer is left alone, so the phase can be run again.
 * Returns the names of the proxies it accepted on.
 */
async function acceptReturned({ contracts, signer, log }) {
  const accepted = [];
  for (const [name, proxy] of [
    ["agent", contracts.aiAgent],
    ["escrow", contracts.escrow],
  ]) {
    const pending = await proxy.pendingOwner();
    if (!sameValue(pending, signer.address)) continue;
    const receipt = await (await proxy.connect(signer).acceptOwnership()).wait();
    log(`  ${name}.acceptOwnership tx: ${receipt.hash} (block ${receipt.blockNumber})`);
    accepted.push(name);
  }
  return accepted;
}

async function verifyReturned({ contracts, state }) {
  const live = await readState({ ...contracts, oracleAddress: state.oracle });
  // An offer nobody accepted would leave the snapshot's owner in place and still be open.
  const [agentPendingOwner, escrowPendingOwner] = await Promise.all([
    contracts.aiAgent.pendingOwner(),
    contracts.escrow.pendingOwner(),
  ]);
  const pending = Object.entries({ agentPendingOwner, escrowPendingOwner })
    .filter(([, actual]) => !sameValue(actual, ethers.ZeroAddress))
    .map(([field, actual]) => ({ field, expected: ethers.ZeroAddress, actual: String(actual) }));
  const mismatches = [
    ...Object.keys(state)
      .filter((field) => !sameValue(live[field], state[field]))
      .map((field) => ({ field, expected: String(state[field]), actual: String(live[field]) })),
    ...pending,
  ];
  return { ok: mismatches.length === 0, mismatches };
}

function snapshotPath() {
  return path.resolve(__dirname, `../cache/admin-rehearsal.${hre.network.name}.json`);
}

/** The two proxies a rehearsal runs against, as the snapshot records them. */
async function pairOf({ aiAgent, escrow }) {
  const [agentAddress, escrowAddress] = await Promise.all([
    aiAgent.getAddress(),
    escrow.getAddress(),
  ]);
  return { agent: agentAddress, escrow: escrowAddress };
}

/**
 * The rehearsal offers ownership and reads the offer back, which needs `pendingOwner()`. A pair
 * from before ownership moved in two steps has none: a dry run would pass against it, and a
 * live run would stop after the fee, treasury and oracle steps had been sent.
 */
async function assertOwnershipMovesInTwoSteps({ aiAgent, escrow }) {
  for (const [name, proxy] of [
    ["agent", aiAgent],
    ["escrow", escrow],
  ]) {
    try {
      await proxy.pendingOwner();
    } catch (error) {
      if (!isRevert(error)) {
        throw error;
      }
      throw new Error(
        `The ${name} has no pendingOwner(): this pair moves ownership in one step, and the rehearsal is written for a pair that moves it in two steps. Nothing was sent.`,
      );
    }
  }
}

function loadEnv() {
  if (process.env.ENV_FILE) {
    dotenv.config({ path: process.env.ENV_FILE });
  }
  dotenv.config({ path: path.resolve(__dirname, "../.env") });
}

async function attachContracts() {
  const agentAddress = process.env.AI_AGENT_CONTRACT_ADDRESS;
  const escrowAddress = process.env.AI_AGENT_ESCROW_CONTRACT_ADDRESS;
  if (!agentAddress || !escrowAddress) {
    throw new Error("AI_AGENT_CONTRACT_ADDRESS and AI_AGENT_ESCROW_CONTRACT_ADDRESS are required");
  }
  return {
    aiAgent: await ethers.getContractAt("EVMAIAgent", agentAddress),
    escrow: await ethers.getContractAt("EVMAIAgentEscrow", escrowAddress),
    oracleAddress: process.env.REHEARSAL_ORACLE_ADDRESS,
  };
}

function parseRehearsalFee(raw) {
  try {
    return ethers.parseEther(raw || DEFAULT_REHEARSAL_PROMPT_FEE_TOKENS);
  } catch {
    throw new Error(
      `REHEARSAL_PROMPT_FEE="${raw}" is not a token amount; give a decimal in whole tokens (for example 2), not wei`,
    );
  }
}

async function forwardPhase({
  contracts,
  signer,
  dryRun,
  log,
  safeAddress,
  rehearsalPromptFee,
  snapshotFile,
  execute = runPlan,
}) {
  if (!safeAddress) {
    throw new Error("REHEARSAL_SAFE_ADDRESS is required for the forward phase");
  }

  await assertOwnershipMovesInTwoSteps(contracts);
  const pair = await pairOf(contracts);
  const live = await readState(contracts);
  const show = (st) =>
    JSON.stringify(Object.fromEntries(Object.entries(st).map(([k, v]) => [k, String(v)])));
  log(`Live state: ${show(live)}`);
  if (!contracts.oracleAddress) {
    log(
      chalk.yellow(
        "REHEARSAL_ORACLE_ADDRESS is not set: the live oracle's authorization is not in the snapshot and will not be checked by the confirm phase.",
      ),
    );
  }
  assertSignerOwnsBoth(signer.address, live);

  // A snapshot left by an aborted live run is the ONLY record of the pre-rehearsal values; the
  // live state may already carry rehearsal values (e.g. the fee). It stays the restore baseline
  // and is never overwritten. To start over deliberately, delete the file first. A snapshot the
  // confirm phase has passed is a finished rehearsal, not a baseline: the next one starts from
  // the live state. A dry run reads the file too, so that it refuses what the live run would,
  // and then leaves it alone.
  const left = fs.existsSync(snapshotFile) ? readSnapshot(snapshotFile, pair) : null;
  const resuming = !dryRun && left !== null && !left.confirmed;
  const state = resuming ? left.state : live;
  if (resuming) {
    // The confirm phase checks the Safe the snapshot names. Resumed with another one, that
    // Safe's oracle role would go unchecked.
    if (left.safe && !sameValue(left.safe, safeAddress)) {
      throw new Error(
        `The rehearsal in ${snapshotFile} was started with the Safe ${left.safe}, not ${safeAddress}. Nothing was sent. Resume it with the Safe it was started with.`,
      );
    }
    log(`Resuming: ${snapshotFile} exists and stays the restore baseline: ${show(state)}`);
  }
  const plan = buildPlan({ state, safeAddress, rehearsalPromptFee });
  await assertSafeHasCode(ethers.getAddress(safeAddress));

  if (!dryRun && !resuming) {
    writeSnapshot(state, snapshotFile, pair, { safe: ethers.getAddress(safeAddress) });
    log(`Pre-rehearsal state saved to ${snapshotFile} before any transaction is sent`);
  }

  const results = await execute({ plan, contracts, signer, dryRun, log });

  if (dryRun) {
    log(chalk.green(`\nDry run complete: ${results.length} calls simulated, nothing sent.`));
    return;
  }

  log(chalk.green("\nForward phase complete."));
  const returnTxs = await buildSafeReturnTxs({ contracts, returnTo: signer.address });
  log(
    "\nQueue these four transactions from the Safe, in this order (Transaction Builder → custom data): it accepts ownership of both proxies, then offers it back. Then run REHEARSAL_PHASE=confirm, which accepts the offer from this wallet:",
  );
  log(JSON.stringify(returnTxs, null, 2));
}

async function confirmPhase({
  contracts,
  signer,
  log,
  snapshotFile,
  accept = acceptReturned,
  verify = verifyReturned,
  sleep = defaultSleep,
}) {
  const pair = await pairOf(contracts);
  const { state, safe, confirmed } = readSnapshot(snapshotFile, pair);
  if (confirmed) {
    log(chalk.yellow("This snapshot was already confirmed. Checking it against the chain again."));
  }
  const accepted = signer ? await accept({ contracts, signer, log }) : [];
  if (!("encryptionKey" in state)) {
    log(chalk.yellow(NO_ENCRYPTION_KEY_NOTE));
  }
  // An acceptance that has just landed can be read from a node still behind its block, which
  // reports the Safe as owner. Read again then. With nothing accepted, the first answer stands.
  const attempts = accepted.length > 0 ? VERIFY_ATTEMPTS : 1;
  // A forward run stopped between authorising the Safe as an oracle and removing it has changed
  // nothing the snapshot holds. Without the second read, the phase would call such a run
  // complete. It is read with the rest, so it is read again with the rest.
  const read = async () => {
    const returned = await verify({ contracts, state });
    if (!safe || !(await contracts.aiAgent.isOracle(safe))) return returned;
    return {
      ok: false,
      mismatches: [
        ...returned.mismatches,
        { field: "safeIsOracle", expected: "false", actual: "true" },
      ],
    };
  };
  let { ok, mismatches } = await read();
  for (let attempt = 2; !ok && attempt <= attempts; attempt += 1) {
    await sleep(VERIFY_RETRY_MS);
    ({ ok, mismatches } = await read());
  }
  if (!ok) {
    for (const m of mismatches) {
      log(chalk.red(`  ${m.field}: expected ${m.expected}, actual ${m.actual}`));
    }
    throw new Error("Rehearsal state has not been fully returned");
  }
  // Only now: marked any earlier, a failed confirm would let the next forward run start from
  // the live state and overwrite the one record of the pre-rehearsal values.
  writeSnapshot(state, snapshotFile, pair, { safe, confirmed: true });
  log(
    chalk.green(
      "Confirm phase complete: everything in the pre-rehearsal snapshot matches the chain again.",
    ),
  );
}

async function main() {
  loadEnv();
  const phase = process.env.REHEARSAL_PHASE || "forward";
  if (!PHASES.has(phase)) {
    throw new Error(`REHEARSAL_PHASE must be one of ${[...PHASES].join(", ")}`);
  }
  const dryRun = process.env.DRY_RUN === "1";
  assertPhaseCanDryRun({ phase, dryRun });
  assertMainnetConfirmed({
    networkName: hre.network.name,
    dryRun,
    confirmed: process.env.REHEARSAL_MAINNET_CONFIRMED,
  });
  const log = (line) => console.log(line);

  const [signer] = await ethers.getSigners();
  const contracts = await attachContracts();
  log(
    `--- Admin rehearsal on ${chalk.bold(hre.network.name)} · phase=${phase} · signer=${signer.address}${dryRun ? " · DRY RUN" : ""} ---`,
  );

  const snapshotFile = snapshotPath();
  if (phase === "forward") {
    await forwardPhase({
      contracts,
      signer,
      dryRun,
      log,
      safeAddress: process.env.REHEARSAL_SAFE_ADDRESS,
      rehearsalPromptFee: parseRehearsalFee(process.env.REHEARSAL_PROMPT_FEE),
      snapshotFile,
    });
  } else {
    await confirmPhase({ contracts, signer, log, snapshotFile });
  }
}

module.exports = {
  readState,
  buildPlan,
  runPlan,
  buildSafeReturnTxs,
  acceptReturned,
  verifyReturned,
  parseRehearsalFee,
  forwardPhase,
  confirmPhase,
  assertMainnetConfirmed,
  assertPhaseCanDryRun,
  findEvent,
  verifyGetter,
  main,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(chalk.red(error.message));
    process.exitCode = 1;
  });
}
