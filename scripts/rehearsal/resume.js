const { ethers } = require("ethers");

const { sameValue, RehearsalError } = require("./values");

/** The live values the leftover check and the resume decisions read. */
async function readLive({ contracts, safe }) {
  const { aiAgent, escrow } = contracts;
  const [promptFee, treasury, agentOwner, escrowOwner, beyond] = await Promise.all([
    escrow.promptFee(),
    escrow.treasury(),
    aiAgent.owner(),
    escrow.owner(),
    readBeyondState({ contracts, safe }),
  ]);
  return { promptFee, treasury, agentOwner, escrowOwner, ...beyond };
}

/** The live values the leftover check needs that the baseline state does not hold. */
async function readBeyondState({ contracts, safe }) {
  const { aiAgent, escrow } = contracts;
  const [safeIsOracle, agentPendingOwner, escrowPendingOwner] = await Promise.all([
    aiAgent.isOracle(safe),
    aiAgent.pendingOwner(),
    escrow.pendingOwner(),
  ]);
  return { safeIsOracle, agentPendingOwner, escrowPendingOwner };
}

/**
 * What a rehearsal leaves on the pair until it is finished: each as a line saying what was
 * found. Read when the baseline would come from the live state, where any of these would be
 * taken for a value from before the rehearsal and "restored" as such. Given `state` (the
 * baseline about to be saved), its values are judged, so the check and the baseline are one
 * read; only the offers and the Safe's role, which it does not hold, are read.
 */
async function findLeftovers({ contracts, safe, rehearsalPromptFee, state }) {
  const live = state
    ? {
        ...(await readBeyondState({ contracts, safe })),
        promptFee: state.promptFee,
        treasury: state.treasury,
        agentOwner: state.agentOwner,
        escrowOwner: state.escrowOwner,
      }
    : await readLive({ contracts, safe });
  const found = [];
  if (sameValue(live.promptFee, rehearsalPromptFee)) {
    found.push(
      `promptFee() is the rehearsal fee ${rehearsalPromptFee}: a rehearsal may have left it, or the pair's real fee may simply equal the rehearsal fee, and then choose another REHEARSAL_PROMPT_FEE`,
    );
  }
  if (sameValue(live.treasury, safe)) {
    found.push(
      `treasury() is the Safe ${safe}: a rehearsal may have left it, or the Safe may be the real treasury, and then the treasury steps would rehearse nothing; set the treasury back, or rehearse with another Safe`,
    );
  }
  for (const name of ["agent", "escrow"]) {
    if (sameValue(live[`${name}Owner`], safe)) found.push(`the Safe owns the ${name}`);
    const pending = live[`${name}PendingOwner`];
    if (!sameValue(pending, ethers.ZeroAddress)) {
      found.push(`the ${name} has an ownership offer open to ${pending}`);
    }
  }
  if (live.safeIsOracle) found.push(`the Safe holds the oracle role`);
  return found;
}

/** Refuses to take the live state as the baseline while it shows any leftover. */
function assertNoLeftovers(found) {
  if (found.length === 0) return;
  throw new RehearsalError(
    `The live state shows what a rehearsal leaves behind, and there is no unconfirmed snapshot to restore it from: ${found.join("; ")}. Nothing was sent. If a rehearsal's snapshot was lost, return these to their values from before it by hand, then run again.`,
  );
}

// Each set-and-restore pair: the getter both steps change, its value before the rehearsal and
// the value the rehearsal sets.
const PAIRS = [
  {
    set: "fee-set",
    restore: "fee-restore",
    getter: "promptFee()",
    live: (live) => live.promptFee,
    before: ({ baseline }) => baseline.promptFee,
    during: ({ rehearsalPromptFee }) => rehearsalPromptFee,
    byHand: ({ baseline }) => `escrow.setPromptFee(${baseline.promptFee})`,
  },
  {
    set: "treasury-set",
    restore: "treasury-restore",
    getter: "treasury()",
    live: (live) => live.treasury,
    before: ({ baseline }) => baseline.treasury,
    during: ({ safe }) => safe,
    byHand: ({ baseline }) => `escrow.setTreasury(${baseline.treasury})`,
  },
  {
    set: "oracle-add",
    restore: "oracle-remove",
    getter: "isOracle(Safe)",
    live: (live) => live.safeIsOracle,
    before: () => false,
    during: () => true,
    byHand: ({ safe }) => `agent.removeOracle(${safe})`,
  },
];

const OFFERS = {
  "agent-owner-to-safe": "agent",
  "escrow-owner-to-safe": "escrow",
};

const isDone = (record) => record?.status === "done";
const decision = (action, reason, warn = false) => ({ action, reason, ...(warn ? { warn } : {}) });

function refuse(text) {
  throw new RehearsalError(
    `${text} Nothing was sent. Find out what changed it and set it by hand before running again.`,
  );
}

/** The two decisions for one pair, by the resume table. */
function decidePair(pair, context) {
  const value = pair.live(context.live);
  const before = pair.before(context);
  const during = pair.during(context);
  const at = sameValue(value, before)
    ? "baseline"
    : sameValue(value, during)
      ? "rehearsal"
      : "other";
  const setDone = isDone(context.steps[pair.set]);
  const restoreDone = isDone(context.steps[pair.restore]);
  const now = `${pair.getter} is ${value} (baseline ${before}, rehearsal value ${during})`;

  if (restoreDone && !setDone) {
    refuse(`[${pair.restore}] is recorded done but [${pair.set}] is not, which no run records.`);
  }
  if (setDone && restoreDone) {
    if (at === "rehearsal") refuse(`[${pair.set}] and [${pair.restore}] finished, but ${now}.`);
    const warn = at === "other";
    const reason = warn
      ? `finished in an earlier run; ${now}, changed since, left as it is`
      : "finished in an earlier run";
    return [decision("skip", reason, warn), decision("skip", reason, warn)];
  }
  if (at === "other")
    refuse(`[${pair.set}] ${setDone ? "finished" : "is not recorded"}, but ${now}.`);
  if (setDone) {
    return at === "rehearsal"
      ? [decision("skip", "finished in an earlier run"), decision("send", now)]
      : [decision("skip", "finished in an earlier run"), decision("observe", `${now}: restored`)];
  }
  return at === "rehearsal"
    ? [decision("observe", `${now}: set without a record`), decision("send", now)]
    : [decision("send", now), decision("send", "after its set")];
}

/**
 * An offer recorded done with none open: most often the Safe accepted and offered back, and the
 * confirm phase accepted, then failed on a value changed since. Nothing here can resume that.
 */
function refuseReturned(id, name) {
  throw new RehearsalError(
    `[${id}] is recorded done, but no ownership offer is open on the ${name}: the rehearsal was most likely returned, and the confirm phase accepted the ownership back. Nothing was sent. Run the confirm phase to check it; if it fails on a value that was changed on purpose since the rehearsal, move the snapshot aside (keep it: it holds the values from before the rehearsal), then run again.`,
  );
}

function decideOffer(id, { steps, live, safe }) {
  // A Safe that already owns the proxy never gets here: the run needs the signer to own both.
  const name = OFFERS[id];
  const pending = live[`${name}PendingOwner`];
  const toSafe = sameValue(pending, safe);
  if (isDone(steps[id])) {
    if (toSafe) return decision("skip", "offered in an earlier run");
    if (sameValue(pending, ethers.ZeroAddress)) refuseReturned(id, name);
    refuse(
      `[${id}] is recorded done, but the ${name}'s pending owner is now ${pending}, not the Safe ${safe}.`,
    );
  }
  if (toSafe) return decision("observe", `the ${name} is already offered to the Safe`);
  if (!sameValue(pending, ethers.ZeroAddress)) {
    refuse(
      `[${id}] would replace an ownership offer of the ${name} that is open to ${pending}, which is not the Safe ${safe}.`,
    );
  }
  return decision("send", `offer the ${name} to the Safe`);
}

/**
 * What a run does with each step of `plan`: `send` it, `skip` it, or `observe` it (record it
 * done without sending, because the chain already shows it). Pure: from the step records, the
 * live values, the baseline, the Safe and the rehearsal fee. Throws, naming the step, where the
 * chain and the records disagree in a way a guess would make worse.
 */
function decideSteps({ plan, steps, live, baseline, safe, rehearsalPromptFee }) {
  for (const [id, record] of Object.entries(steps)) {
    if (!isDone(record)) {
      throw new RehearsalError(
        `[${id}] is recorded as ${record?.status}; it must be settled first.`,
      );
    }
  }
  const context = { steps, live, baseline, safe, rehearsalPromptFee };
  const decided = {};
  for (const pair of PAIRS) {
    [decided[pair.set], decided[pair.restore]] = decidePair(pair, context);
  }
  for (const id of Object.keys(OFFERS)) decided[id] = decideOffer(id, context);
  return plan.map((step) => {
    if (!decided[step.id])
      throw new RehearsalError(`[${step.id}] is not a step the rehearsal knows`);
    return { step, ...decided[step.id] };
  });
}

/**
 * What to do with a step recorded as sent that this node has no receipt for: forget it (it did
 * not land and will not) only when its nonce is still unused and nothing is waiting; otherwise
 * refuse, since it, or a transaction that replaced it, may have landed or may still.
 */
async function settleWithoutReceipt(stepDef, record, getCounts) {
  const sentAs = `[${stepDef.id}] was sent as ${record.txHash}, and no receipt was found on this node`;
  if (typeof record.nonce !== "number") {
    throw new RehearsalError(
      `${sentAs}; no nonce was recorded with it, so it cannot be placed. Nothing was sent. Look the transaction up on an explorer, and run again once it is mined or certainly dropped.`,
    );
  }
  const { latest, pending } = await getCounts();
  if (latest > record.nonce) {
    throw new RehearsalError(
      `${sentAs}, but the wallet has used its nonce ${record.nonce}: it, or a replacement, landed and this node cannot show it. Nothing was sent. Run again against a node that has the receipt.`,
    );
  }
  if (pending > latest) {
    throw new RehearsalError(
      `${sentAs}, and the wallet has a transaction waiting to be mined. Nothing was sent. Wait for it to be mined, then run again.`,
    );
  }
}

/**
 * Runs `check` (the step's event) on a receipt that succeeded. A failure leaves the step recorded
 * as sent, so every later run meets it again: the refusal says so, and how to get out.
 */
function checkLanded(stepDef, record, receipt, check) {
  try {
    check(stepDef, receipt);
  } catch (error) {
    throw new RehearsalError(
      `[${stepDef.id}] was sent as ${record.txHash}, which landed in block ${receipt.blockNumber}, but its receipt does not show the step: ${error.message}. Nothing was sent. The step stays recorded as sent, so it will keep stopping every run until this is resolved; running again will not change it. Look the transaction up on a block explorer. If the recorded hash is not this step's transaction, move the snapshot aside (keep it: it holds the values from before the rehearsal), return any rehearsal value still live to that value by hand, then run again.`,
      { cause: error },
    );
  }
}

/**
 * The step records with every `sent` step settled: done when its receipt succeeded and `check`
 * (its event) passes, forgotten when it reverted or, with no receipt, when its nonce is unused
 * and nothing is pending. State at the receipt's block is never read: a node may have pruned it.
 */
async function settleSentSteps({ plan, steps, getReceipt, getCounts, check, log }) {
  let settled = { ...steps };
  // Only the receipt's event is checked here, on purpose: the state at the receipt's block may
  // have been pruned from the node. Sending a step checks both its event and that state.
  for (const stepDef of plan) {
    const record = steps[stepDef.id];
    if (record?.status !== "sent") continue;
    const receipt = await getReceipt(record.txHash);
    if (receipt?.status === 1) {
      checkLanded(stepDef, record, receipt, check);
      log(`[${stepDef.id}] sent as ${record.txHash}: landed in block ${receipt.blockNumber}`);
      const done = { status: "done", txHash: record.txHash, blockNumber: receipt.blockNumber };
      settled = { ...settled, [stepDef.id]: done };
      continue;
    }
    if (receipt) {
      log(`[${stepDef.id}] sent as ${record.txHash}: reverted, so it is sent again`);
    } else {
      await settleWithoutReceipt(stepDef, record, getCounts);
      // Forgetting is safe however the unrecorded transaction resolves: the next decision for
      // this step is derived from the live value, so if it lands after all its value is seen
      // and the step is recorded as observed or its restore sent, and if not it is sent again.
      log(
        `[${stepDef.id}] sent as ${record.txHash}: no receipt found on this node and its nonce is unused`,
      );
    }
    settled = Object.fromEntries(Object.entries(settled).filter(([id]) => id !== stepDef.id));
  }
  return settled;
}

/**
 * The confirm phase marks a rehearsal finished, so it refuses one that is not: a step still
 * recorded as sent may yet land and change a value the chain now shows at its baseline, and a
 * version 2 run whose ownership offers are not both recorded done rehearsed no ownership. A
 * version 1 snapshot records no steps, and one already confirmed passed these checks before.
 */
function assertConfirmable(snapshot, file) {
  for (const [id, record] of Object.entries(snapshot.steps)) {
    if (record?.status === "sent") {
      throw new RehearsalError(
        `[${id}] is recorded in ${file} as sent as ${record.txHash} and has not been settled: it may still land and change what this phase would check. Nothing was sent. Run the forward phase to settle it, then run the confirm phase.`,
      );
    }
  }
  if (snapshot.version === 1 || snapshot.confirmed) return;
  const missing = Object.keys(OFFERS).filter((id) => !isDone(snapshot.steps[id]));
  if (missing.length > 0) {
    throw new RehearsalError(
      `${missing.map((id) => `[${id}]`).join(" and ")} not recorded done in ${file}: the forward phase did not finish, so no ownership was rehearsed. Nothing was sent. Run the forward phase to finish it, then run the confirm phase.`,
    );
  }
}

/** Each set recorded done whose restore is not, with the call that restores it by hand. */
function openSets({ steps, baseline, safe }) {
  if (!baseline) return [];
  return PAIRS.filter((pair) => isDone(steps[pair.set]) && !isDone(steps[pair.restore])).map(
    (pair) => `[${pair.set}] (restore with ${pair.byHand({ baseline, safe })})`,
  );
}

/**
 * Refuses while the wallet has a transaction the chain has not mined yet, saying how to get out:
 * the counts, how to clear a stuck nonce, and which rehearsal values may be live meanwhile.
 */
async function assertNoPendingTransactions({ provider, address, steps = {}, baseline, safe }) {
  const [pending, latest] = await Promise.all([
    provider.getTransactionCount(address, "pending"),
    provider.getTransactionCount(address, "latest"),
  ]);
  if (pending <= latest) return;
  const open = openSets({ steps, baseline, safe });
  const live =
    open.length === 0
      ? ""
      : ` These sets are recorded done and their restores are not, so their rehearsal values are live until restored: ${open.join("; ")}.`;
  throw new RehearsalError(
    `The wallet ${address} has ${pending - latest} transaction(s) waiting to be mined (latest ${latest}, pending ${pending}). Nothing was sent.${live} Wait for them to be mined, then run again. If one is stuck, replace it from this wallet with a transaction at nonce ${latest} (for example 0 value to itself, at a higher fee), then run again.`,
  );
}

module.exports = {
  readLive,
  findLeftovers,
  assertNoLeftovers,
  decideSteps,
  settleSentSteps,
  assertNoPendingTransactions,
  assertConfirmable,
};
