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

/**
 * One of the script's own refusals or reports: its message says what happened and what to do,
 * so it is printed alone. Anything else is unexpected and is printed with its stack.
 */
class RehearsalError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "RehearsalError";
  }
}

/** The text printed for a failure that ends the run. */
function describeFailure(error) {
  if (!(error instanceof RehearsalError)) return String(error?.stack ?? error);
  const { cause } = error;
  if (cause && !(cause instanceof RehearsalError)) {
    return `${error.message}\nCaused by: ${cause?.stack ?? cause}`;
  }
  return error.message;
}

module.exports = { sameValue, isRevert, RehearsalError, describeFailure };
