const { ethers } = require("ethers");

const { sameValue } = require("./values");

/**
 * What a rehearsal leaves on the pair until it is finished: each as a line saying what was
 * found. Read when the baseline would come from the live state, where any of these would be
 * taken for a value from before the rehearsal and "restored" as such.
 */
async function findLeftovers({ contracts, safe, rehearsalPromptFee }) {
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
  const found = [];
  if (sameValue(promptFee, rehearsalPromptFee)) {
    found.push(`promptFee() is the rehearsal fee ${rehearsalPromptFee}`);
  }
  if (sameValue(treasury, safe)) found.push(`treasury() is the Safe ${safe}`);
  for (const [name, owner, pending] of [
    ["agent", agentOwner, agentPending],
    ["escrow", escrowOwner, escrowPending],
  ]) {
    if (sameValue(owner, safe)) found.push(`the Safe owns the ${name}`);
    if (!sameValue(pending, ethers.ZeroAddress)) {
      found.push(`the ${name} has an ownership offer open to ${pending}`);
    }
  }
  if (safeIsOracle) found.push(`the Safe holds the oracle role`);
  return found;
}

/** Refuses to take the live state as the baseline while it shows any leftover. */
function assertNoLeftovers(found) {
  if (found.length === 0) return;
  throw new Error(
    `The live state shows what a rehearsal leaves behind, and there is no unconfirmed snapshot to restore it from: ${found.join("; ")}. Nothing was sent. If a rehearsal's snapshot was lost, return these to their values from before it by hand, then run again.`,
  );
}

module.exports = { findLeftovers, assertNoLeftovers };
