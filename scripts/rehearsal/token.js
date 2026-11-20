const { ethers } = require("ethers");

const { RehearsalError } = require("./values");

// A token that moves only to or from addresses its owner has listed answers this. An ordinary
// token has no such function.
const TRANSFER_RULE_ABI = ["function isTransferExempt(address account) view returns (bool)"];

// A node's whole answer to a revert that carried no data, with nothing after it. A reason after
// it ("execution reverted: ...") means the contract said something, and its data was dropped.
const BARE_REVERT = /^execution reverted$/i;

/**
 * True when a call reverted with no data at all: what a contract with no such function and no
 * fallback answers. Exactly two shapes count: data of exactly `0x`, or no data and a message
 * that is the node's bare revert text. A revert with data or with a reason is the contract's
 * own answer, and a node that refused or failed the request is no answer; neither is taken for
 * a missing function.
 *
 * The error comes in three forms. ethers turns a JSON-RPC error into CALL_EXCEPTION with the
 * node's own error under `info.error`. Hardhat's HTTP provider throws a ProviderError carrying
 * the node's numeric code and message, and `data` only when the node sent it. The in-process
 * Hardhat network throws its own error with the empty data. Any other ethers code is refused.
 */
function isEmptyRevert(error) {
  if (error === null || typeof error !== "object") return false;
  if (typeof error.code === "string" && error.code !== "CALL_EXCEPTION") return false;
  if (error.data === "0x") return true;
  if (error.data !== undefined && error.data !== null) return false;
  const message = error.code === "CALL_EXCEPTION" ? error.info?.error?.message : error.message;
  return BARE_REVERT.test(String(message ?? "").trim());
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
