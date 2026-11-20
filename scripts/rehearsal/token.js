const { ethers } = require("ethers");

const { RehearsalError } = require("./values");

// A token that moves only to or from addresses its owner has listed answers this. An ordinary
// token has no such function.
const TRANSFER_RULE_ABI = ["function isTransferExempt(address account) view returns (bool)"];

/**
 * True when a call reverted with no data at all: what a contract with no such function and no
 * fallback answers. A revert with data is the contract's own answer, and a node that did not
 * answer is no answer; neither is taken for a missing function. ethers turns any JSON-RPC error
 * to a call into CALL_EXCEPTION, so with no data the node's own words must say it reverted. The
 * in-process Hardhat network throws its own error, with the empty data and no ethers code.
 */
function isEmptyRevert(error) {
  if (error === null || typeof error !== "object") return false;
  if (error.code === "CALL_EXCEPTION") {
    if (error.data === "0x") return true;
    return error.data == null && /revert/i.test(String(error.info?.error?.message ?? ""));
  }
  if (typeof error.code === "string") return false;
  return error.data === "0x" && /reverted/i.test(String(error.message));
}

/**
 * The escrow's token, and whether it keeps a list (`restricted`) with the Safe on it (`listed`).
 * Anything other than a yes, a no or a missing function is refused: nothing has been sent yet,
 * and a guess either way could leave users' payments refused while the Safe is the treasury.
 */
async function readTransferRule({ escrow, safe, runner }) {
  const token = await escrow.ableToken();
  const rule = new ethers.Contract(token, TRANSFER_RULE_ABI, runner);
  try {
    const listed = await rule.isTransferExempt(safe);
    return { token, restricted: true, listed: listed === true };
  } catch (error) {
    if (isEmptyRevert(error)) return { token, restricted: false, listed: false };
    throw new RehearsalError(
      `The rehearsal could not tell whether the escrow's token ${token} moves only to or from addresses its owner has listed: asking it whether the Safe ${safe} is listed gave no yes or no. Nothing was sent. Check the token, then run again.`,
      { cause: error },
    );
  }
}

/**
 * Before a run that will make the Safe the treasury: refuses while the escrow's token keeps a
 * list and the Safe is not on it, since every payment the escrow sends to the treasury (a
 * cancellation fee, a branch or rename fee) would then be refused until the restore.
 */
async function assertSafeCanBeTreasury({ escrow, safe, runner, log }) {
  const { token, restricted, listed } = await readTransferRule({ escrow, safe, runner });
  if (!restricted) {
    log(`The escrow's token ${token} does not restrict who it moves between.`);
    return;
  }
  if (listed) {
    log(`The escrow's token ${token} keeps a list, and the Safe ${safe} is on its list.`);
    return;
  }
  throw new RehearsalError(
    `The escrow's token ${token} moves only to or from addresses its owner has listed, and the Safe ${safe} is not on its list. While the Safe is the treasury, every payment the escrow sends to the treasury would be refused. Nothing was sent. Have the token's owner list the Safe, or rehearse with a Safe that is listed, then run again.`,
  );
}

module.exports = { isEmptyRevert, readTransferRule, assertSafeCanBeTreasury };
