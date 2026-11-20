const chalk = require("chalk");

const { sameValue, RehearsalError } = require("./values");

const RECOVERY_HINT =
  "Re-run the forward phase to resume: the snapshot stays the restore baseline and records each step as it is sent and as it is proven, so a step recorded as sent is settled first and a finished pair is not sent again. The confirm phase refuses while a step is recorded as sent or the wallet has a transaction waiting to be mined; once the forward phase has finished, run REHEARSAL_PHASE=confirm to list what differs from the snapshot; a proxy whose pending owner is the Safe needs acceptOwnership() from the Safe; a proxy owned by the Safe is returned with transferOwnership(<deploy wallet>) from the Safe, and then accepted by the confirm phase from this wallet.";
// Public RPC endpoints are load-balanced; the node that answers the read-back may not have the
// block the receipt came from yet. Read at that block and retry rather than fail a landed tx.
const VERIFY_ATTEMPTS = 5;
const VERIFY_RETRY_MS = 2000;
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CONTRACT_KEYS = { agent: "aiAgent", escrow: "escrow" };

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
    throw new RehearsalError(`[${stepDef.id}] ${stepDef.event.name} was not emitted`);
  }
  const parsed = target.interface.parseLog(raw);
  stepDef.event.args.forEach((expected, i) => {
    if (!sameValue(parsed.args[i], expected)) {
      throw new RehearsalError(
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
  throw new RehearsalError(
    `[${stepDef.id}] ${getterCall(stepDef.verify)} at block ${receipt.blockNumber} is ${last}, expected ${expected} after ${attempts} attempts`,
  );
}

async function simulateStep(stepDef, target, log) {
  try {
    await target[stepDef.method].staticCall(...stepDef.args);
  } catch (error) {
    throw new RehearsalError(
      `[${stepDef.id}] dry run of ${stepDef.contract}.${stepDef.method} would revert: ${error.message}`,
    );
  }
  log("  dry-run:  call simulated OK");
  return { id: stepDef.id, txHash: null, blockNumber: null };
}

/** Sends the step's call and returns the transaction once the node has taken it. */
async function submit(stepDef, target) {
  try {
    return await target[stepDef.method](...stepDef.args);
  } catch (error) {
    throw new RehearsalError(
      `[${stepDef.id}] ${stepDef.contract}.${stepDef.method} failed: ${error.message}\n${RECOVERY_HINT}`,
      { cause: error },
    );
  }
}

/** What landed, for an error raised once the step's transaction is in a block. */
function landed(stepDef, tx, receipt, error) {
  return new RehearsalError(
    `${error.message} ([${stepDef.id}] sent as ${tx.hash} landed in block ${receipt.blockNumber}). Nothing more was sent; run again to settle it from its receipt.`,
    { cause: error },
  );
}

/**
 * Sends one step. Its hash is logged and it is recorded "sent", with the hash and nonce, as
 * soon as the node returns it, before the run waits for it; it is recorded "done" only after
 * its event and getter checks pass. Each failure says how far the step got.
 */
async function sendStep(stepDef, target, log, record) {
  const tx = await submit(stepDef, target);
  log(`  sent:     ${tx.hash} (nonce ${tx.nonce})`);
  try {
    await record(stepDef.id, { status: "sent", txHash: tx.hash, nonce: tx.nonce });
  } catch (error) {
    throw new RehearsalError(
      `[${stepDef.id}] sent as ${tx.hash} (nonce ${tx.nonce}), but the snapshot could not be written: ${error.message}. The transaction may land, so send nothing by hand; fix the disk and run again.`,
      { cause: error },
    );
  }
  let receipt;
  try {
    receipt = await tx.wait();
  } catch (error) {
    throw new RehearsalError(
      `[${stepDef.id}] sent as ${tx.hash}; waiting for it failed: ${error.message}\n${RECOVERY_HINT}`,
      { cause: error },
    );
  }
  log(`  block:    ${receipt.blockNumber}`);
  try {
    findEvent(receipt, target, stepDef);
    await verifyGetter(target, stepDef, receipt);
    await record(stepDef.id, { status: "done", txHash: tx.hash, blockNumber: receipt.blockNumber });
  } catch (error) {
    throw landed(stepDef, tx, receipt, error);
  }
  return { id: stepDef.id, txHash: tx.hash, blockNumber: receipt.blockNumber };
}

/**
 * Runs the plan as decided: `send` steps are sent (static-called in a dry run), `skip` steps
 * are left, and `observe` steps are recorded done without being sent. With no decisions every
 * step is sent. `record(id, entry)` keeps the step records; a dry run records nothing.
 */
async function runPlan({
  plan,
  decisions = plan.map((step) => ({ step, action: "send" })),
  contracts,
  signer,
  dryRun,
  log,
  record = async () => {},
}) {
  const results = [];
  for (const { step: stepDef, action, reason, warn } of decisions) {
    const target = contracts[CONTRACT_KEYS[stepDef.contract]].connect(signer);
    describeStep(stepDef, target, log);
    const would = dryRun ? "would " : "";
    if (action === "skip") {
      log(warn ? chalk.yellow(`  ${would}skip: ${reason}`) : `  ${would}skip: ${reason}`);
      results.push({ id: stepDef.id, txHash: null, blockNumber: null, skipped: true });
    } else if (action === "observe") {
      log(`  ${would}record as done without sending: ${reason}`);
      if (!dryRun) await record(stepDef.id, { status: "done", observed: true });
      results.push({ id: stepDef.id, txHash: null, blockNumber: null, observed: true });
    } else if (dryRun) {
      results.push(await simulateStep(stepDef, target, log));
    } else {
      results.push(await sendStep(stepDef, target, log, record));
    }
  }
  return results;
}

module.exports = {
  CONTRACT_KEYS,
  VERIFY_ATTEMPTS,
  VERIFY_RETRY_MS,
  defaultSleep,
  findEvent,
  verifyGetter,
  runPlan,
};
