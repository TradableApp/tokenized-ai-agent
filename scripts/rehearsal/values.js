/**
 * True when two values the rehearsal compares are the same: amounts as numbers whatever their
 * type, and everything else (addresses, booleans, keys) as text without regard to letter case.
 */
function sameValue(actual, expected) {
  if (typeof expected === "bigint" || typeof actual === "bigint") {
    const [left, right] = [asAmount(actual), asAmount(expected)];
    return left !== null && right !== null && left === right;
  }
  return String(actual).toLowerCase() === String(expected).toLowerCase();
}

/** `value` as an amount, or null when it is nothing or no whole number. */
function asAmount(value) {
  if (value === null || value === undefined || value === "") return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
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

/**
 * The snapshot is on disk, renamed into place, but its folder could not be synced: a crash now
 * may lose it. A caller says it was written, not that it was not.
 */
class SnapshotNotDurable extends RehearsalError {
  constructor(message, options) {
    super(message, options);
    this.name = "SnapshotNotDurable";
  }
}

module.exports = { sameValue, isRevert, RehearsalError, SnapshotNotDurable, describeFailure };
