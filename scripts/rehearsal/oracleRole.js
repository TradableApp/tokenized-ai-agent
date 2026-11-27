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
 * When the signer is the agent's encryption key publisher (`publishesKey`), removing its role
 * also withdraws that key (the agent's `_revokeRole`). While that key is there the oracle cannot
 * publish its own (only a key's publisher can replace it); once it is withdrawn the oracle
 * publishes its own on its next check. So the note says the role is still removed, and that a
 * snapshot that recorded the key then always differs on it.
 */
function signerRoleNote(signer, { publishesKey = false } = {}) {
  if (publishesKey) {
    return `The signer ${signer} holds the oracle role on the agent and is the agent's oracleEncryptionKeyPublisher: the encryption key on the agent was published from this wallet. Removing its role (agent.removeOracle(${signer})) withdraws that key: the agent deletes the key when its publisher loses the role. While this wallet's key is there, the oracle cannot publish its own (only a key's publisher can replace it), and a client that checks the agent's key before a paid send refuses to send while it differs from the key it was built with. Once this key is withdrawn, the oracle publishes its own key on its next check (at start-up, when its role comes back, and every five minutes), if it holds the role. Remove the role all the same: once ownership is handed over, only the new owner can remove it, so the owner removes it before the handover, and only after the address the oracle answers from holds the role and has answered a prompt (the deploy runbook's section on moving the oracle role gives the order). A snapshot that recorded this key then differs from the chain on the key every time, and the confirm phase fails on it: move that snapshot aside (keep it: it holds the values from before the rehearsal). Never publish an encryption key from the deploy wallet. The rehearsal does not remove the role, and the confirm phase does not pass while it is held.`;
  }
  return `The signer ${signer} holds the oracle role on the agent. Once ownership is handed over, only the new owner can remove it, so the owner removes it before the handover: agent.removeOracle(${signer}), and only after the address the oracle answers from holds the role and has answered a prompt (the deploy runbook's section on moving the oracle role gives the order). The rehearsal does not remove it, and the confirm phase does not pass while it is held.`;
}

/** Said with the plain note when the publisher could not be read: the node's error is not shown. */
function unreadablePublisherNote(signer) {
  return `The agent's encryption key publisher could not be read, so this does not say whether the signer ${signer} published the key; if it did, removing its role withdraws that key, and a snapshot that recorded the key then differs on it and must be moved aside.`;
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

/**
 * Why a resumed forward run must not go on with this snapshot, or null when it may: the
 * snapshot watches the signer as the live oracle, which an earlier version of the script
 * allowed, and the confirm phase can never pass with it (`assertSnapshotOracleIsNotSigner`).
 * The run still sends the restore of every set already done, so no rehearsal value is left
 * live, and holds every step not yet started; the advice depends on whether it sent any.
 */
function resumedOracleRefusal({ oracle, signer, file }) {
  if (!oracle || !sameValue(oracle, signer)) return null;
  return {
    reason: `The snapshot at ${file} watches the signer ${signer} as the live oracle, which an earlier version of this script allowed. Its rehearsal can never be confirmed: the live oracle's role must be kept, and the signer's is one the owner removes before the handover. No new step is sent with it.`,
    advice: ({ sent }) =>
      `${sent.length > 0 ? "After these restores, return" : "Return"} any value a rehearsal still leaves live to the snapshot's baseline by hand (keep the snapshot: it holds the values from before the rehearsal), then move it aside; a fresh forward run then starts from the live state, refuses while a rehearsal value is left, and takes REHEARSAL_ORACLE_ADDRESS naming the address the oracle answers prompts from.`,
  };
}

module.exports = {
  isLiveNetwork,
  signerRoleNote,
  reportSignerRole,
  isPublisher,
  unreadablePublisherNote,
  assertOracleIsNotSigner,
  assertSnapshotOracleIsNotSigner,
  resumedOracleRefusal,
};
