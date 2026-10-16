const hre = require("hardhat");
const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");
const chalk = require("chalk");

const { ethers } = hre;

const DEFAULT_REHEARSAL_PROMPT_FEE_TOKENS = "2";
const PHASES = new Set(["forward", "confirm"]);
const MAINNET_NETWORK = "base";
const RECOVERY_HINT =
  "Run REHEARSAL_PHASE=confirm to list what differs from the snapshot; any proxy already owned by the Safe is returned with transferOwnership(<deploy wallet>) queued from the Safe.";

const CONTRACT_KEYS = { agent: "aiAgent", escrow: "escrow" };

async function readState({ aiAgent, escrow }) {
  const [agentOwner, escrowOwner, oracle, treasury, promptFee] = await Promise.all([
    aiAgent.owner(),
    escrow.owner(),
    aiAgent.oracle(),
    escrow.treasury(),
    escrow.promptFee(),
  ]);
  return { agentOwner, escrowOwner, oracle, treasury, promptFee };
}

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
  const ownerEvent = (from) => ({ name: "OwnershipTransferred", args: [from, safe] });

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
    step("oracle-set", "agent", "setOracle", [safe], addrEvent("OracleUpdated", safe), {
      getter: "oracle",
      expected: safe,
    }),
    step(
      "oracle-restore",
      "agent",
      "setOracle",
      [state.oracle],
      addrEvent("OracleUpdated", state.oracle),
      { getter: "oracle", expected: state.oracle },
    ),
    step(
      "agent-owner-to-safe",
      "agent",
      "transferOwnership",
      [safe],
      ownerEvent(state.agentOwner),
      { getter: "owner", expected: safe },
    ),
    step(
      "escrow-owner-to-safe",
      "escrow",
      "transferOwnership",
      [safe],
      ownerEvent(state.escrowOwner),
      { getter: "owner", expected: safe },
    ),
  ];
}

function sameValue(actual, expected) {
  if (typeof expected === "bigint" || typeof actual === "bigint") {
    return BigInt(actual) === BigInt(expected);
  }
  return String(actual).toLowerCase() === String(expected).toLowerCase();
}

function describeStep(stepDef, target, log) {
  const calldata = target.interface.encodeFunctionData(stepDef.method, stepDef.args);
  log(`\n[${stepDef.id}] ${stepDef.contract}.${stepDef.method}(${stepDef.args.join(", ")})`);
  log(`  to:       ${target.target}`);
  log(`  calldata: ${calldata}`);
  log(`  expects:  ${stepDef.event.name}(${stepDef.event.args.join(", ")})`);
  log(`  verify:   ${stepDef.verify.getter}() == ${stepDef.verify.expected}`);
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

async function verifyGetter(target, stepDef) {
  const actual = await target[stepDef.verify.getter]();
  if (!sameValue(actual, stepDef.verify.expected)) {
    throw new Error(
      `[${stepDef.id}] ${stepDef.verify.getter}() is ${actual}, expected ${stepDef.verify.expected}`,
    );
  }
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
    await verifyGetter(target, stepDef);
    log(`  tx:       ${receipt.hash} (block ${receipt.blockNumber})`);
    results.push({ id: stepDef.id, txHash: receipt.hash, blockNumber: receipt.blockNumber });
  }
  return results;
}

async function buildSafeReturnTxs({ contracts, returnTo }) {
  const encode = async (contract) => ({
    to: await contract.getAddress(),
    value: "0",
    data: contract.interface.encodeFunctionData("transferOwnership", [returnTo]),
  });
  return [await encode(contracts.aiAgent), await encode(contracts.escrow)];
}

async function verifyReturned({ contracts, state }) {
  const live = await readState(contracts);
  const mismatches = Object.keys(state)
    .filter((field) => !sameValue(live[field], state[field]))
    .map((field) => ({ field, expected: String(state[field]), actual: String(live[field]) }));
  return { ok: mismatches.length === 0, mismatches };
}

function snapshotPath() {
  return path.resolve(__dirname, `../cache/admin-rehearsal.${hre.network.name}.json`);
}

function writeSnapshot(state, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const serialisable = Object.fromEntries(Object.entries(state).map(([k, v]) => [k, String(v)]));
  fs.writeFileSync(file, JSON.stringify(serialisable, null, 2));
  return file;
}

function readSnapshot(file) {
  if (!fs.existsSync(file)) {
    throw new Error(
      `No snapshot at ${file}; run the forward phase first (for example bun run rehearse:base-testnet)`,
    );
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  return { ...raw, promptFee: BigInt(raw.promptFee) };
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

  const state = await readState(contracts);
  log(
    `Live state: ${JSON.stringify(Object.fromEntries(Object.entries(state).map(([k, v]) => [k, String(v)])))}`,
  );
  assertSignerOwnsBoth(signer.address, state);
  const plan = buildPlan({ state, safeAddress, rehearsalPromptFee });
  await assertSafeHasCode(ethers.getAddress(safeAddress));

  if (!dryRun) {
    writeSnapshot(state, snapshotFile);
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
    "\nQueue these two transactions from the Safe (Transaction Builder → custom data), then run REHEARSAL_PHASE=confirm:",
  );
  log(JSON.stringify(returnTxs, null, 2));
}

async function confirmPhase({ contracts, log, snapshotFile }) {
  const state = readSnapshot(snapshotFile);
  const { ok, mismatches } = await verifyReturned({ contracts, state });
  if (!ok) {
    for (const m of mismatches) {
      log(chalk.red(`  ${m.field}: expected ${m.expected}, actual ${m.actual}`));
    }
    throw new Error("Rehearsal state has not been fully returned");
  }
  log(
    chalk.green(
      "Confirm phase complete: ownership, fees, treasury and oracle all match the pre-rehearsal snapshot.",
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
    await confirmPhase({ contracts, log, snapshotFile });
  }
}

module.exports = {
  readState,
  buildPlan,
  runPlan,
  buildSafeReturnTxs,
  verifyReturned,
  parseRehearsalFee,
  forwardPhase,
  confirmPhase,
  assertMainnetConfirmed,
  findEvent,
  main,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(chalk.red(error.message));
    process.exitCode = 1;
  });
}
