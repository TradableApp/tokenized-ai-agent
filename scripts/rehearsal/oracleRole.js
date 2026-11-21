const chalk = require("chalk");

const { sameValue, RehearsalError } = require("./values");

// Networks the deploy wallet runs on its own, where it is also the oracle on purpose. Any other
// network counts as live, so a network added later is checked rather than skipped.
const LOCAL_NETWORKS = new Set(["hardhat", "localhost", "localnet"]);

function isLiveNetwork(network) {
  return !LOCAL_NETWORKS.has(network);
}

/**
 * What to do about the signer's own oracle role. The deploy wallet is given it when the pair is
 * deployed, and once ownership is handed over only the new owner can take it away. Removing it
 * is the owner's decision, so the rehearsal names the call and never sends it.
 *
 * When the signer published the encryption key (`publishesKey`), removing its role withdraws
 * the key (the agent's `_revokeRole`) and no prompt can be submitted until an oracle publishes
 * one; and while the signer's key is published, `setOracleEncryptionKey` refuses any other
 * oracle with `EncryptionKeyHeldByAnotherOracle`. The note then gives that order instead.
 */
function signerRoleNote(signer, { publishesKey = false } = {}) {
  if (publishesKey) {
    return `The signer ${signer} holds the oracle role on the agent and published the encryption key clients encrypt prompts to (oracleEncryptionKeyPublisher). Do not simply remove its role: agent.removeOracle(${signer}) would withdraw that key, and no prompt can be submitted until an oracle publishes a key again. The real oracle cannot publish its key first: while the signer's key is published, the agent refuses any other oracle's key with EncryptionKeyHeldByAnotherOracle. So the owner, before the handover, makes sure the real oracle holds the oracle role (agent.addOracle(<oracle>)), removes the signer's role, and has the real oracle publish its key with agent.setOracleEncryptionKey(key, proof) straight after; prompts cannot be submitted between the two, so choose a quiet time. The rehearsal does none of this, and the confirm phase does not pass while the signer holds the role. A snapshot that records the signer's key differs from the chain once the key changes, and the confirm phase then fails on it every time: move that snapshot aside (keep it: it holds the values from before the rehearsal).`;
  }
  return `The signer ${signer} holds the oracle role on the agent. Once ownership is handed over, only the new owner can remove it, so the owner removes it before the handover: agent.removeOracle(${signer}). The rehearsal does not remove it, and the confirm phase does not pass while it is held.`;
}

/**
 * Says whether the signer holds the oracle role, and returns it. `publisher` is the agent's
 * encryption key publisher as read with the live state (absent on a proxy without the key).
 */
async function reportSignerRole({ aiAgent, signer, log, publisher }) {
  const holds = await aiAgent.isOracle(signer);
  log(
    holds
      ? chalk.yellow(signerRoleNote(signer, { publishesKey: isPublisher(publisher, signer) }))
      : `The signer ${signer} does not hold the oracle role on the agent.`,
  );
  return holds;
}

/** True when `publisher` is the signer. A missing publisher is no one. */
function isPublisher(publisher, signer) {
  return Boolean(publisher) && sameValue(publisher, signer);
}

/**
 * Refuses a live oracle that is the signer. The rehearsal checks that the live oracle keeps its
 * role, and the signer's own role is one the owner removes before the handover: one address
 * cannot be both. `source` names where the oracle address came from.
 */
function assertOracleIsNotSigner({ oracle, signer, source }) {
  if (!oracle || !sameValue(oracle, signer)) return;
  throw new RehearsalError(
    `${source} is the signer ${signer}. The rehearsal checks that the live oracle keeps its role, and the signer's own role is one the owner removes before the handover, so they must be two addresses. Nothing has been sent. Name the address the oracle answers prompts from, or leave it unset.`,
  );
}

/**
 * Refuses a snapshot that watches the signer as the live oracle, which an earlier version of
 * the script allowed. Called after the ownership the Safe offered back is accepted, so no offer
 * is left open; the value is in the snapshot, so the way out is to move the snapshot aside.
 */
function assertSnapshotOracleIsNotSigner({ oracle, signer, file, accepted }) {
  if (!oracle || !sameValue(oracle, signer)) return;
  const taken =
    accepted.length > 0
      ? `The ownership the Safe offered back on the ${accepted.join(" and ")} has been accepted.`
      : "No ownership was waiting to be accepted.";
  throw new RehearsalError(
    `The snapshot at ${file} watches the signer ${signer} as the live oracle, which an earlier version of this script allowed. ${taken} This phase cannot pass with that snapshot: the live oracle's role must be kept, and the signer's is one the owner removes before the handover, so move the snapshot aside (keep it: it holds the values from before the rehearsal); a later forward run starts from the live state, with REHEARSAL_ORACLE_ADDRESS naming the address the oracle answers prompts from.`,
  );
}

module.exports = {
  isLiveNetwork,
  signerRoleNote,
  reportSignerRole,
  isPublisher,
  assertOracleIsNotSigner,
  assertSnapshotOracleIsNotSigner,
};
