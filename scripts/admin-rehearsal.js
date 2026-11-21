const hre = require("hardhat");
const dotenv = require("dotenv");
const path = require("path");
const chalk = require("chalk");

const { sameValue, isRevert, RehearsalError, describeFailure } = require("./rehearsal/values");
const {
  snapshotPath,
  legacySnapshotPath,
  writeSnapshot,
  readSnapshot,
  checkLegacySnapshot,
} = require("./rehearsal/snapshot");
const {
  readLive,
  findLeftovers,
  assertNoLeftovers,
  decideSteps,
  settleSentSteps,
  assertNoPendingTransactions,
  assertConfirmable,
} = require("./rehearsal/resume");
const {
  CONTRACT_KEYS,
  VERIFY_ATTEMPTS,
  VERIFY_RETRY_MS,
  defaultSleep,
  findEvent,
  verifyGetter,
  runPlan,
} = require("./rehearsal/steps");
const { treasuryRefusal, holdUnstarted, treasuryRefused } = require("./rehearsal/token");
const {
  isLiveNetwork,
  signerRoleNote,
  reportSignerRole,
  assertOracleIsNotSigner,
  assertSnapshotOracleIsNotSigner,
} = require("./rehearsal/oracleRole");

const { ethers } = hre;

const DEFAULT_REHEARSAL_PROMPT_FEE_TOKENS = "2";
const PHASES = new Set(["forward", "confirm"]);
const MAINNET_NETWORK = "base";
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
    throw new RehearsalError(`Safe address is not a usable address: ${safeAddress}`);
  }
  const safe = ethers.getAddress(safeAddress);
  if (
    safe === ethers.getAddress(state.agentOwner) ||
    safe === ethers.getAddress(state.escrowOwner)
  ) {
    throw new RehearsalError(
      `Safe ${safe} already owns a proxy; the transfer would rehearse nothing`,
    );
  }
  return safe;
}

function assertSignerOwnsBoth(signerAddress, state) {
  const signer = ethers.getAddress(signerAddress);
  if (
    signer !== ethers.getAddress(state.agentOwner) ||
    signer !== ethers.getAddress(state.escrowOwner)
  ) {
    throw new RehearsalError(
      `Signer ${signer} does not own both proxies (agentOwner=${state.agentOwner}, escrowOwner=${state.escrowOwner})`,
    );
  }
}

async function assertSafeHasCode(safe) {
  const code = await ethers.provider.getCode(safe);
  if (code === "0x") {
    throw new RehearsalError(
      `Safe ${safe} has no contract code; an EOA cannot stand in for the Safe`,
    );
  }
}

function assertMainnetConfirmed({ networkName, dryRun, confirmed }) {
  if (networkName === MAINNET_NETWORK && !dryRun && confirmed !== "1") {
    throw new RehearsalError(
      `Live run on ${networkName} refused: set REHEARSAL_MAINNET_CONFIRMED=1 to send owner transactions on Base mainnet`,
    );
  }
}

/** The confirm phase sends the acceptance, so there is nothing a dry run of it could simulate. */
function assertPhaseCanDryRun({ phase, dryRun }) {
  if (dryRun && phase === "confirm") {
    throw new RehearsalError(
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
    throw new RehearsalError(
      "Rehearsal prompt fee equals the live fee; the event would prove nothing",
    );
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

/** The two proxies a rehearsal runs against, as the snapshot records them. */
async function pairOf({ aiAgent, escrow }) {
  const [agentAddress, escrowAddress] = await Promise.all([
    aiAgent.getAddress(),
    escrow.getAddress(),
  ]);
  return { agent: agentAddress, escrow: escrowAddress };
}

/**
 * The pair, the chain, and this pair's snapshot (null when there is none), after the file an
 * earlier version left in the cache has been checked. Whatever cannot be used is refused here,
 * before anything is read from the contracts or sent.
 */
async function loadSnapshot({ contracts, snapshotFile, legacySnapshotFile, network, log }) {
  const pair = await pairOf(contracts);
  const { chainId } = await ethers.provider.getNetwork();
  checkLegacySnapshot({ file: legacySnapshotFile, pair, log, moveTo: snapshotFile });
  const snapshot = readSnapshot(snapshotFile, { pair, network, chainId });
  return { pair, chainId, snapshot };
}

/**
 * A forward run cannot tell which steps a version 1 snapshot's rehearsal sent. A confirmed one
 * is a finished rehearsal, as a confirmed version 2 one is, and the run starts from live state.
 */
function assertForwardCanUse(snapshot, file) {
  if (snapshot?.version !== 1 || snapshot.confirmed) return;
  throw new RehearsalError(
    `The snapshot at ${file} was written by an earlier version of this script and records no steps, so a forward run cannot tell which were sent. Nothing was sent. Run the confirm phase to check it against the chain; once it is confirmed, a forward run starts from the live state. If its rehearsal was returned by hand, move it aside.`,
  );
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
      throw new RehearsalError(
        `The ${name} has no pendingOwner(): this pair moves ownership in one step, and the rehearsal is written for a pair that moves it in two steps. Nothing was sent.`,
      );
    }
  }
}

/** Loads the network's settings file, then the repository's, into `env`. */
function loadEnv(env) {
  if (env.ENV_FILE) {
    dotenv.config({ path: env.ENV_FILE, processEnv: env });
  }
  dotenv.config({ path: path.resolve(__dirname, "../.env"), processEnv: env });
}

async function attachContracts(env) {
  const agentAddress = env.AI_AGENT_CONTRACT_ADDRESS;
  const escrowAddress = env.AI_AGENT_ESCROW_CONTRACT_ADDRESS;
  if (!agentAddress || !escrowAddress) {
    throw new RehearsalError(
      "AI_AGENT_CONTRACT_ADDRESS and AI_AGENT_ESCROW_CONTRACT_ADDRESS are required",
    );
  }
  return {
    aiAgent: await ethers.getContractAt("EVMAIAgent", agentAddress),
    escrow: await ethers.getContractAt("EVMAIAgentEscrow", escrowAddress),
    oracleAddress: env.REHEARSAL_ORACLE_ADDRESS,
  };
}

function parseRehearsalFee(raw) {
  try {
    return ethers.parseEther(raw || DEFAULT_REHEARSAL_PROMPT_FEE_TOKENS);
  } catch {
    throw new RehearsalError(
      `REHEARSAL_PROMPT_FEE="${raw}" is not a token amount; give a decimal in whole tokens (for example 2), not wei`,
    );
  }
}

const show = (values) =>
  JSON.stringify(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, String(v)])));

/**
 * The run's snapshot. A snapshot left by an aborted live run is the ONLY record of the
 * pre-rehearsal values; the live state may already carry rehearsal values (e.g. the fee). It
 * stays the restore baseline and is never overwritten, and it must be resumed with the Safe and
 * rehearsal fee it was started with. To start over deliberately, move the file aside first. A
 * snapshot the confirm phase has passed is a finished rehearsal, not a baseline: the next one
 * starts from the live state, which must then show nothing a rehearsal leaves behind.
 */
async function beginRun({
  left,
  resuming,
  live,
  contracts,
  safeAddress,
  rehearsalPromptFee,
  file,
}) {
  const safe = assertSafeAddress(safeAddress, live);
  if (!resuming) {
    assertNoLeftovers(await findLeftovers({ contracts, safe, rehearsalPromptFee, state: live }));
    return { safe, rehearsalPromptFee, baseline: live, steps: {}, confirmed: false };
  }
  // The confirm phase checks the Safe the snapshot names. Resumed with another one, that
  // Safe's oracle role would go unchecked.
  if (!sameValue(left.safe, safe)) {
    throw new RehearsalError(
      `The rehearsal in ${file} was started with the Safe ${left.safe}, not ${safe}. Nothing was sent. Resume it with the Safe it was started with.`,
    );
  }
  // Another fee would leave a set made with the first one looking like a value from elsewhere.
  if (!sameValue(left.rehearsalPromptFee, rehearsalPromptFee)) {
    throw new RehearsalError(
      `The rehearsal in ${file} was started with the rehearsal fee ${left.rehearsalPromptFee}, not ${rehearsalPromptFee}. Nothing was sent. Resume it with the fee it was started with.`,
    );
  }
  return { ...left, safe };
}

/** Each step a run with this snapshot sends, skips or records as observed. */
async function decideRun({ plan, contracts, signer, snapshot, log, save }) {
  const steps = await settleSentSteps({
    plan,
    steps: snapshot.steps,
    getReceipt: (hash) => ethers.provider.getTransactionReceipt(hash),
    getCounts: async () => {
      const [latest, pending] = await Promise.all([
        ethers.provider.getTransactionCount(signer.address, "latest"),
        ethers.provider.getTransactionCount(signer.address, "pending"),
      ]);
      return { latest, pending };
    },
    check: (stepDef, receipt) =>
      findEvent(receipt, contracts[CONTRACT_KEYS[stepDef.contract]], stepDef),
    log,
  });
  save({ ...snapshot, steps });
  const live = await readLive({ contracts, safe: snapshot.safe });
  return {
    steps,
    decisions: decideSteps({ ...snapshot, plan, steps, live }),
  };
}

/**
 * What a forward run starts from: the pair, chain, this pair's snapshot and the live state,
 * after every check that needs no decision: two-step ownership, the cache file, the snapshot,
 * the signer's ownership and no transaction pending. On a live network it also says whether
 * the signer holds the oracle role.
 */
async function readForwardStart({
  contracts,
  signer,
  snapshotFile,
  legacySnapshotFile,
  network,
  log,
  checkSignerRole,
}) {
  if (checkSignerRole) {
    const { oracleAddress: oracle } = contracts;
    assertOracleIsNotSigner({ oracle, signer: signer.address, source: "REHEARSAL_ORACLE_ADDRESS" });
  }
  await assertOwnershipMovesInTwoSteps(contracts);
  const loaded = await loadSnapshot({ contracts, snapshotFile, legacySnapshotFile, network, log });
  assertForwardCanUse(loaded.snapshot, snapshotFile);
  const live = await readState(contracts);
  log(`Live state: ${show(live)}`);
  if (!contracts.oracleAddress) {
    log(
      chalk.yellow(
        "REHEARSAL_ORACLE_ADDRESS is not set: the live oracle's authorization is not in the snapshot and will not be checked by the confirm phase.",
      ),
    );
  }
  assertSignerOwnsBoth(signer.address, live);
  if (checkSignerRole) {
    await reportSignerRole({ aiAgent: contracts.aiAgent, signer: signer.address, log });
  }
  await assertNoPendingTransactions({
    provider: ethers.provider,
    address: signer.address,
    ...(loaded.snapshot ?? {}),
  });
  return { ...loaded, live };
}

/**
 * True when this run will make the Safe the treasury: its set is not recorded done and the
 * Safe is not already the treasury. Once it is, refusing would only keep it there.
 */
function willSetTreasury(snapshot, live) {
  return (
    snapshot.steps["treasury-set"]?.status !== "done" && !sameValue(live.treasury, snapshot.safe)
  );
}

function reportForward({ dryRun, results, returnTxs, log }) {
  if (dryRun) {
    const simulated = results.filter((r) => !r.skipped && !r.observed).length;
    log(chalk.green(`\nDry run complete: ${simulated} calls simulated, nothing sent or written.`));
    return;
  }
  log(chalk.green("\nForward phase complete."));
  log(
    "\nQueue these four transactions from the Safe, in this order (Transaction Builder → custom data): it accepts ownership of both proxies, then offers it back. Then run REHEARSAL_PHASE=confirm, which accepts the offer from this wallet:",
  );
  log(JSON.stringify(returnTxs, null, 2));
}

async function forwardPhase({
  contracts,
  signer,
  dryRun,
  log,
  safeAddress,
  rehearsalPromptFee,
  snapshotFile,
  legacySnapshotFile = null,
  network = hre.network.name,
  execute = runPlan,
  checkSignerRole = isLiveNetwork(network),
}) {
  if (!safeAddress) {
    throw new RehearsalError("REHEARSAL_SAFE_ADDRESS is required for the forward phase");
  }
  const start = await readForwardStart({
    contracts,
    signer,
    snapshotFile,
    legacySnapshotFile,
    network,
    log,
    checkSignerRole,
  });
  const { pair, chainId, snapshot: left, live } = start;
  // A dry run takes the same path, so that it predicts the live run: it resumes, settles,
  // decides and refuses as the live run would, and only writes nothing.
  const resuming = left !== null && !left.confirmed;
  const begun = await beginRun({
    left,
    resuming,
    live,
    contracts,
    safeAddress,
    rehearsalPromptFee,
    file: snapshotFile,
  });
  // Replaced, never changed, by `save` and `record` below. They are called one at a time, in
  // order, each after the last has returned; a concurrent caller would lose a step record.
  let snapshot = { ...begun, network, chainId, pair };
  if (resuming)
    log(`Resuming: ${snapshotFile} stays the restore baseline: ${show(snapshot.baseline)}`);
  const plan = buildPlan({ state: snapshot.baseline, safeAddress, rehearsalPromptFee });
  await assertSafeHasCode(snapshot.safe);
  // A fresh run refuses here, before anything is written; a resumed one restores first.
  const refusal = willSetTreasury(snapshot, live)
    ? await treasuryRefusal({
        escrow: contracts.escrow,
        safe: snapshot.safe,
        runner: ethers.provider,
        log,
      })
    : null;
  if (refusal && !resuming) throw treasuryRefused({ refusal, dryRun });

  const save = (next) => {
    snapshot = next;
    if (!dryRun) writeSnapshot(snapshotFile, snapshot);
  };
  if (!resuming) {
    save(snapshot);
    if (!dryRun) log(`Pre-rehearsal state saved to ${snapshotFile} before any transaction is sent`);
  }
  const decided = await decideRun({ plan, contracts, signer, snapshot, log, save });
  const { decisions, sent, held } = refusal ? holdUnstarted(decided.decisions) : decided;
  // A step's record is on disk before the next step is sent, so a restore is sent only after
  // its set's "done" record is written.
  const record = async (id, entry) =>
    save({ ...snapshot, steps: { ...snapshot.steps, [id]: entry } });
  const results = await execute({ plan, decisions, contracts, signer, dryRun, log, record });
  if (refusal) throw treasuryRefused({ refusal, sent, held, dryRun });
  const returnTxs = dryRun ? [] : await buildSafeReturnTxs({ contracts, returnTo: signer.address });
  reportForward({ dryRun, results, returnTxs, log });
}

/** The snapshot the confirm phase checks, once it is known to be one it may mark confirmed. */
async function readConfirmable({
  contracts,
  signer,
  snapshotFile,
  legacySnapshotFile,
  network,
  log,
}) {
  const loaded = await loadSnapshot({ contracts, snapshotFile, legacySnapshotFile, network, log });
  const { snapshot } = loaded;
  if (snapshot === null) {
    throw new RehearsalError(
      `No snapshot at ${snapshotFile}; run the forward phase first (for example bun run rehearse:base-testnet)`,
    );
  }
  assertConfirmable(snapshot, snapshotFile);
  await assertNoPendingTransactions({
    provider: ethers.provider,
    address: signer.address,
    ...snapshot,
  });
  return loaded;
}

/**
 * Compares the chain with the snapshot, `attempts` times at most while it differs. A forward run
 * stopped between authorising the Safe as an oracle and removing it has changed nothing the
 * snapshot holds, so the Safe's role is read too, and read again with the rest. Given `signer`,
 * its own oracle role is read the same way: the phase does not pass while it is held.
 */
async function readReturned({ contracts, state, safe, signer, attempts, verify, sleep }) {
  const roleHeld = async (field, address) =>
    address && (await contracts.aiAgent.isOracle(address))
      ? [{ field, expected: "false", actual: "true" }]
      : [];
  const read = async () => {
    const returned = await verify({ contracts, state });
    const roles = [
      ...(await roleHeld("safeIsOracle", safe)),
      ...(await roleHeld("signerIsOracle", signer)),
    ];
    if (roles.length === 0) return returned;
    return { ok: false, mismatches: [...returned.mismatches, ...roles] };
  };
  let result = await read();
  for (let attempt = 2; !result.ok && attempt <= attempts; attempt += 1) {
    await sleep(VERIFY_RETRY_MS);
    result = await read();
  }
  return result;
}

/** Lists what differs from the snapshot, with what to do about the signer's role, and refuses. */
function refuseNotReturned({ mismatches, signer, log }) {
  for (const m of mismatches) {
    log(chalk.red(`  ${m.field}: expected ${m.expected}, actual ${m.actual}`));
  }
  if (mismatches.some((m) => m.field === "signerIsOracle")) {
    log(chalk.yellow(signerRoleNote(signer)));
  }
  throw new RehearsalError(
    "Rehearsal state has not been fully returned: each line above differs from the snapshot. Return each to the snapshot's value and run this phase again. If one differs because it was changed on purpose since the rehearsal, this phase fails on it every time: move the snapshot aside (keep it: it holds the values from before the rehearsal), and a later forward run starts from the live state.",
  );
}

async function confirmPhase({
  contracts,
  signer,
  log,
  snapshotFile,
  legacySnapshotFile = null,
  network = hre.network.name,
  accept = acceptReturned,
  verify = verifyReturned,
  sleep = defaultSleep,
  checkSignerRole = isLiveNetwork(network),
}) {
  const { pair, chainId, snapshot } = await readConfirmable({
    contracts,
    signer,
    snapshotFile,
    legacySnapshotFile,
    network,
    log,
  });
  const { baseline: state, safe, confirmed } = snapshot;
  if (confirmed) {
    log(chalk.yellow("This snapshot was already confirmed. Checking it against the chain again."));
  }
  const accepted = await accept({ contracts, signer, log });
  if (checkSignerRole) {
    const { oracle } = state;
    assertSnapshotOracleIsNotSigner({
      oracle,
      signer: signer.address,
      file: snapshotFile,
      accepted,
    });
  }
  if (!("encryptionKey" in state)) log(chalk.yellow(NO_ENCRYPTION_KEY_NOTE));
  // An acceptance that has just landed can be read from a node still behind its block, which
  // reports the Safe as owner. Read again then. With nothing accepted, the first answer stands.
  const attempts = accepted.length > 0 ? VERIFY_ATTEMPTS : 1;
  const { ok, mismatches } = await readReturned({
    contracts,
    state,
    safe,
    signer: checkSignerRole ? signer.address : null,
    attempts,
    verify,
    sleep,
  });
  if (!ok) refuseNotReturned({ mismatches, signer: signer.address, log });
  // Only now: marked any earlier, a failed confirm would let the next forward run start from
  // the live state and overwrite the one record of the pre-rehearsal values.
  // Written as version 2 whatever it was read as, on the network and chain it was checked on.
  writeSnapshot(snapshotFile, { ...snapshot, network, chainId, pair, confirmed: true });
  log(
    chalk.green(
      "Confirm phase complete: everything in the pre-rehearsal snapshot matches the chain again.",
    ),
  );
}

/**
 * Every input is a parameter, so the guards can be tested where the script runs them. Run as a
 * script, it takes the process environment, Hardhat's network and the real contracts.
 */
async function main({
  env = process.env,
  networkName = hre.network.name,
  loadEnvFile = loadEnv,
  getSigners = () => ethers.getSigners(),
  attach = attachContracts,
  forward = forwardPhase,
  confirm = confirmPhase,
} = {}) {
  loadEnvFile(env);
  const phase = env.REHEARSAL_PHASE || "forward";
  if (!PHASES.has(phase)) {
    throw new RehearsalError(`REHEARSAL_PHASE must be one of ${[...PHASES].join(", ")}`);
  }
  const dryRun = env.DRY_RUN === "1";
  assertPhaseCanDryRun({ phase, dryRun });
  assertMainnetConfirmed({ networkName, dryRun, confirmed: env.REHEARSAL_MAINNET_CONFIRMED });
  const log = (line) => console.log(line);

  const [signer] = await getSigners();
  const contracts = await attach(env);
  log(
    `--- Admin rehearsal on ${chalk.bold(networkName)} · phase=${phase} · signer=${signer.address}${dryRun ? " · DRY RUN" : ""} ---`,
  );

  const root = path.resolve(__dirname, "..");
  const files = {
    network: networkName,
    snapshotFile: snapshotPath({
      root,
      network: networkName,
      agent: await contracts.aiAgent.getAddress(),
    }),
    legacySnapshotFile: legacySnapshotPath({ root, network: networkName }),
  };
  if (phase === "forward") {
    await forward({
      contracts,
      signer,
      dryRun,
      log,
      safeAddress: env.REHEARSAL_SAFE_ADDRESS,
      rehearsalPromptFee: parseRehearsalFee(env.REHEARSAL_PROMPT_FEE),
      ...files,
    });
  } else {
    await confirm({ contracts, signer, log, ...files });
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
    console.error(chalk.red(describeFailure(error)));
    process.exitCode = 1;
  });
}
