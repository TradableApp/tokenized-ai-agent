const { ethers } = require("ethers");

const { sameValue } = require("./values");

/** The live values the leftover check and the resume decisions read. */
async function readLive({ contracts, safe }) {
  const { aiAgent, escrow } = contracts;
  const [promptFee, treasury, safeIsOracle, agentOwner, escrowOwner, agentPending, escrowPending] =
    await Promise.all([
      escrow.promptFee(),
      escrow.treasury(),
      aiAgent.isOracle(safe),
      aiAgent.owner(),
      escrow.owner(),
      aiAgent.pendingOwner(),
      escrow.pendingOwner(),
    ]);
  return {
    promptFee,
    treasury,
    safeIsOracle,
    agentOwner,
    escrowOwner,
    agentPendingOwner: agentPending,
    escrowPendingOwner: escrowPending,
  };
}

/**
 * What a rehearsal leaves on the pair until it is finished: each as a line saying what was
 * found. Read when the baseline would come from the live state, where any of these would be
 * taken for a value from before the rehearsal and "restored" as such.
 */
async function findLeftovers({ contracts, safe, rehearsalPromptFee }) {
  const live = await readLive({ contracts, safe });
  const found = [];
  if (sameValue(live.promptFee, rehearsalPromptFee)) {
    found.push(`promptFee() is the rehearsal fee ${rehearsalPromptFee}`);
  }
  if (sameValue(live.treasury, safe)) found.push(`treasury() is the Safe ${safe}`);
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
  throw new Error(
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
  },
  {
    set: "treasury-set",
    restore: "treasury-restore",
    getter: "treasury()",
    live: (live) => live.treasury,
    before: ({ baseline }) => baseline.treasury,
    during: ({ safe }) => safe,
  },
  {
    set: "oracle-add",
    restore: "oracle-remove",
    getter: "isOracle(Safe)",
    live: (live) => live.safeIsOracle,
    before: () => false,
    during: () => true,
  },
];

const OFFERS = {
  "agent-owner-to-safe": "agent",
  "escrow-owner-to-safe": "escrow",
};

const isDone = (record) => record?.status === "done";
const decision = (action, reason, warn = false) => ({ action, reason, ...(warn ? { warn } : {}) });

function refuse(text) {
  throw new Error(
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

function decideOffer(id, { steps, live, safe }) {
  const name = OFFERS[id];
  if (sameValue(live[`${name}Owner`], safe)) {
    refuse(`The Safe already owns the ${name}; run the confirm phase once it has offered it back.`);
  }
  if (isDone(steps[id])) return decision("skip", "offered in an earlier run");
  if (sameValue(live[`${name}PendingOwner`], safe)) {
    return decision("observe", `the ${name} is already offered to the Safe`);
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
      throw new Error(`[${id}] is recorded as ${record?.status}; it must be settled first.`);
    }
  }
  const context = { steps, live, baseline, safe, rehearsalPromptFee };
  const decided = {};
  for (const pair of PAIRS) {
    [decided[pair.set], decided[pair.restore]] = decidePair(pair, context);
  }
  for (const id of Object.keys(OFFERS)) decided[id] = decideOffer(id, context);
  return plan.map((step) => {
    if (!decided[step.id]) throw new Error(`[${step.id}] is not a step the rehearsal knows`);
    return { step, ...decided[step.id] };
  });
}

/**
 * The step records with every `sent` step settled from its receipt: done when it succeeded and
 * `check` passes, forgotten (not landed) when it reverted or has no receipt and nothing is
 * pending. With no receipt and a transaction pending it refuses: it may still land.
 */
async function settleSentSteps({ plan, steps, getReceipt, hasPending, check }) {
  const settled = { ...steps };
  for (const stepDef of plan) {
    const record = steps[stepDef.id];
    if (record?.status !== "sent") continue;
    const receipt = await getReceipt(record.txHash);
    if (!receipt && hasPending) {
      throw new Error(
        `[${stepDef.id}] was sent as ${record.txHash} and has no receipt yet, and the wallet has a transaction waiting to be mined. Nothing was sent. Wait for it to be mined, then run again.`,
      );
    }
    if (receipt?.status === 1) {
      await check(stepDef, receipt);
      settled[stepDef.id] = {
        status: "done",
        txHash: record.txHash,
        blockNumber: receipt.blockNumber,
      };
    } else {
      delete settled[stepDef.id];
    }
  }
  return settled;
}

/** Refuses while the wallet has a transaction the chain has not mined yet. */
async function assertNoPendingTransactions({ provider, address }) {
  const [pending, latest] = await Promise.all([
    provider.getTransactionCount(address, "pending"),
    provider.getTransactionCount(address, "latest"),
  ]);
  if (pending > latest) {
    throw new Error(
      `The wallet ${address} has ${pending - latest} transaction(s) waiting to be mined. Nothing was sent. Wait for them to be mined, then run again.`,
    );
  }
}

module.exports = {
  readLive,
  findLeftovers,
  assertNoLeftovers,
  decideSteps,
  settleSentSteps,
  assertNoPendingTransactions,
};
