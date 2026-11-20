/**
 * True when two values the rehearsal compares are the same: amounts as numbers whatever their
 * type, and everything else (addresses, booleans, keys) as text without regard to letter case.
 */
function sameValue(actual, expected) {
  if (typeof expected === "bigint" || typeof actual === "bigint") {
    return BigInt(actual) === BigInt(expected);
  }
  return String(actual).toLowerCase() === String(expected).toLowerCase();
}

/**
 * True when a read failed because the contract reverted, as opposed to the node not answering.
 * ethers reports a revert as CALL_EXCEPTION. The in-process Hardhat network throws its own
 * error with no ethers code, recognizable only by its text; an error that carries any other
 * code came from a real node and is never taken for a revert, whatever its text says.
 */
function isRevert(error) {
  if (error?.code === "CALL_EXCEPTION") return true;
  if (typeof error?.code === "string") return false;

  return /revert/i.test(String(error?.message));
}

module.exports = { sameValue, isRevert };
