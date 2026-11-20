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
 */
function signerRoleNote(signer) {
  return `The signer ${signer} holds the oracle role on the agent. Once ownership is handed over, only the new owner can remove it, so the owner removes it before the handover: agent.removeOracle(${signer}). The rehearsal does not remove it, and the confirm phase does not pass while it is held.`;
}

/** Says whether the signer holds the oracle role, and returns it. */
async function reportSignerRole({ aiAgent, signer, log }) {
  const holds = await aiAgent.isOracle(signer);
  log(
    holds
      ? chalk.yellow(signerRoleNote(signer))
      : `The signer ${signer} does not hold the oracle role on the agent.`,
  );
  return holds;
}

/**
 * Refuses a live oracle that is the signer. The rehearsal checks that the live oracle keeps its
 * role, and the signer's own role is one the owner removes before the handover: one address
 * cannot be both. `source` names where the oracle address came from.
 */
function assertOracleIsNotSigner({ oracle, signer, source }) {
  if (!oracle || !sameValue(oracle, signer)) return;
  throw new RehearsalError(
    `${source} is the signer ${signer}. The rehearsal checks that the live oracle keeps its role, and the signer's own role is one the owner removes before the handover, so they must be two addresses. Nothing was sent. Name the address the oracle answers prompts from, or leave it unset.`,
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
  assertOracleIsNotSigner,
  assertSnapshotOracleIsNotSigner,
};
