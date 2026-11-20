const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { sameValue, RehearsalError, SnapshotNotDurable } = require("./values");

/**
 * The rehearsal's snapshot: the values before the rehearsal (its baseline), what it was run
 * with, and which of its steps were sent. It is the only record of the baseline once the first
 * step has landed, so it lives in a folder of its own and not in Hardhat's cache, which
 * `hardhat clean` empties. It is named by network and agent, so a rehearsal of another pair has
 * its own file.
 *
 * Version 2 holds: `version`, `network`, `chainId`, `pair` {agent, escrow}, `safe`,
 * `rehearsalPromptFee`, `baseline` {...}, `steps` {id: {status, txHash, blockNumber, observed}},
 * `confirmed` and `updatedAt`. Version 1, from before steps were recorded, held the baseline's
 * values beside `pair`, `safe` and `confirmed`.
 */
const SNAPSHOT_VERSION = 2;
const STATE_FOLDER = "rehearsal-state";

function snapshotPath({ root, network, agent }) {
  return path.join(root, STATE_FOLDER, `admin-rehearsal.${network}.${agent.toLowerCase()}.json`);
}

/** Where versions before the snapshot had its own folder wrote it. It is read, never written. */
function legacySnapshotPath({ root, network }) {
  return path.join(root, "cache", `admin-rehearsal.${network}.json`);
}

const asText = (values) =>
  Object.fromEntries(Object.entries(values).map(([key, value]) => [key, String(value)]));

function toRecord(snapshot) {
  return {
    version: SNAPSHOT_VERSION,
    network: snapshot.network,
    chainId: String(snapshot.chainId),
    pair: snapshot.pair,
    safe: snapshot.safe,
    rehearsalPromptFee:
      snapshot.rehearsalPromptFee === null || snapshot.rehearsalPromptFee === undefined
        ? null
        : String(snapshot.rehearsalPromptFee),
    baseline: asText(snapshot.baseline),
    steps: snapshot.steps ?? {},
    confirmed: snapshot.confirmed === true,
    updatedAt: new Date().toISOString(),
  };
}

/** Creates `temporary` (never an existing file or link), writes `text` and syncs it to disk. */
function writeSynced(temporary, text) {
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, text);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * Writes the snapshot whole: to a new temporary file in the same folder under a random name,
 * synced to disk, then renamed over the old one; a failed write removes the temporary file. A
 * run stopped part-way leaves the old snapshot or the new one, never a cut-off file. The folder
 * and the file are the running user's only: the file is what the next run restores from.
 */
function writeSnapshot(file, snapshot) {
  const folder = path.dirname(file);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  fs.chmodSync(folder, 0o700);
  const text = JSON.stringify(toRecord(snapshot), null, 2);
  const temporary = path.join(
    folder,
    `.${path.basename(file)}.${crypto.randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    writeSynced(temporary, text);
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  syncFolder(folder, file);
  return file;
}

// Where a folder cannot be opened to be synced (Windows): there is nothing more to do there.
const FOLDER_SYNC_UNSUPPORTED = new Set(["EISDIR", "EPERM", "EINVAL"]);

/**
 * Syncs the folder, so the rename's new entry survives a crash. The new snapshot is in place
 * by then; a failure is still thrown, as a write that did not finish, so a caller that cannot
 * be sure it was recorded stops.
 */
function syncFolder(folder, file) {
  let descriptor;
  try {
    descriptor = fs.openSync(folder, "r");
  } catch (error) {
    if (FOLDER_SYNC_UNSUPPORTED.has(error.code)) return;
    throw durability(file, error);
  }
  try {
    fs.fsyncSync(descriptor);
  } catch (error) {
    throw durability(file, error);
  } finally {
    fs.closeSync(descriptor);
  }
}

function durability(file, error) {
  return new SnapshotNotDurable(
    `The snapshot at ${file} was written, but could not be made durable: ${error.message}`,
    { cause: error },
  );
}

const MOVE_ASIDE =
  "Nothing was sent. Move it aside (keep it if it belongs to a rehearsal still to be returned by hand), then run again.";

function parseFile(file) {
  const text = fs.readFileSync(file, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new RehearsalError(
      `The snapshot at ${file} is not JSON (${error.message}), so it cannot be read as a baseline. ${MOVE_ASIDE}`,
    );
  }
}

function assertPairOf(record, file, pair) {
  const recorded = record?.pair;
  if (!recorded?.agent || !recorded?.escrow) {
    throw new RehearsalError(
      `The snapshot at ${file} does not say which pair it was taken for, so it cannot be used as a baseline. ${MOVE_ASIDE}`,
    );
  }
  if (!sameValue(recorded.agent, pair.agent) || !sameValue(recorded.escrow, pair.escrow)) {
    throw new RehearsalError(
      `The snapshot at ${file} was taken for another pair (agent ${recorded.agent}, escrow ${recorded.escrow}), not agent ${pair.agent}, escrow ${pair.escrow}. ${MOVE_ASIDE}`,
    );
  }
}

function assertTakenOn(record, file, { network, chainId }) {
  if (record.network !== network) {
    throw new RehearsalError(
      `The snapshot at ${file} was taken on network ${record.network}, not ${network}. ${MOVE_ASIDE}`,
    );
  }
  if (!sameValue(record.chainId, chainId)) {
    throw new RehearsalError(
      `The snapshot at ${file} was taken on chain ${record.chainId}, not ${chainId}. ${MOVE_ASIDE}`,
    );
  }
}

const withFee = (values) => ({ ...values, promptFee: BigInt(values.promptFee) });

const STEP_IDS = new Set([
  "fee-set",
  "fee-restore",
  "treasury-set",
  "treasury-restore",
  "oracle-add",
  "oracle-remove",
  "agent-owner-to-safe",
  "escrow-owner-to-safe",
]);
const isAmount = (value) => typeof value === "string" && /^[0-9]+$/.test(value);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isHash = (value) => typeof value === "string" && value.length > 2;
const isNonce = (value) => Number.isSafeInteger(value) && value >= 0;
const isName = (value) => typeof value === "string" && value !== "";
const isAddress = (value) => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
const isBytes = (value) => typeof value === "string" && /^0x(?:[0-9a-fA-F]{2})*$/.test(value);

// The baseline as the script writes it: what readState reads, each field as text. The owners,
// treasury and fee are always read; the key and its publisher only from a proxy that has them,
// and the oracle and its role only when an oracle address is given.
const BASELINE_REQUIRED = { agentOwner: isAddress, escrowOwner: isAddress, treasury: isAddress };
const BASELINE_OPTIONAL = {
  encryptionKey: isBytes,
  encryptionKeyPublisher: isAddress,
  oracle: isAddress,
  oracleAuthorized: (value) => value === "true" || value === "false",
};

/**
 * The first baseline field not in the form the script writes, or null. A confirmed record is
 * no baseline and may come from a version 1 file, so only the fields it holds are checked.
 */
function badBaseline(baseline, open) {
  if (!isAmount(baseline.promptFee)) return "baseline.promptFee";
  for (const [field, valid] of Object.entries(BASELINE_REQUIRED)) {
    if ((open || field in baseline) && !valid(baseline[field])) return `baseline.${field}`;
  }
  for (const [field, valid] of Object.entries(BASELINE_OPTIONAL)) {
    if (field in baseline && !valid(baseline[field])) return `baseline.${field}`;
  }
  return null;
}

/** The first field of a step record that is not what the script writes, or null. */
function badStep(id, record) {
  if (!STEP_IDS.has(id)) return `steps.${id}`;
  if (!isObject(record)) return `steps.${id}`;
  if (record.status === "sent") {
    if (!isHash(record.txHash)) return `steps.${id}.txHash`;
    return isNonce(record.nonce) ? null : `steps.${id}.nonce`;
  }
  if (record.status !== "done") return `steps.${id}.status`;
  return record.observed === true || isHash(record.txHash) ? null : `steps.${id}.txHash`;
}

/**
 * The first field of a version 2 record that is not what the script writes, or null. A
 * confirmed record is no baseline, so it may lack the Safe and the rehearsal fee: one rewritten
 * from a version 1 file has neither.
 */
function badField(record) {
  if (!isName(record.network)) return "network";
  if (!isAmount(record.chainId)) return "chainId";
  const open = record.confirmed !== true;
  if (open && !isName(record.safe)) return "safe";
  if (open && !isAmount(record.rehearsalPromptFee)) return "rehearsalPromptFee";
  if (!isObject(record.baseline)) return "baseline";
  const baseline = badBaseline(record.baseline, open);
  if (baseline) return baseline;
  if (!isObject(record.steps)) return "steps";
  for (const [id, step] of Object.entries(record.steps)) {
    const bad = badStep(id, step);
    if (bad) return bad;
  }
  return null;
}

/** Refuses a version 2 record with a field the script does not write, naming the field. */
function assertWhole(record, file) {
  const bad = badField(record);
  if (bad) {
    throw new RehearsalError(
      `The snapshot at ${file} has a field the script does not write, ${bad}, so it cannot be used as a baseline. ${MOVE_ASIDE}`,
    );
  }
}

function fromVersionTwo(record) {
  return {
    version: 2,
    network: record.network,
    chainId: BigInt(record.chainId),
    pair: record.pair,
    safe: record.safe,
    rehearsalPromptFee: isAmount(record.rehearsalPromptFee)
      ? BigInt(record.rehearsalPromptFee)
      : null,
    baseline: withFee(record.baseline),
    steps: record.steps,
    confirmed: record.confirmed === true,
  };
}

function fromVersionOne(record) {
  const { pair, safe, confirmed, ...values } = record;
  return {
    version: 1,
    pair,
    safe,
    rehearsalPromptFee: null,
    baseline: withFee(values),
    steps: {},
    confirmed: confirmed === true,
  };
}

/**
 * Reads the snapshot at `file` for this pair, network and chain: null where there is none.
 * Anything it cannot use as this pair's baseline is refused, never taken for a missing file:
 * a file that is not JSON, one that does not name its pair, and one of another pair, network,
 * chain or version.
 */
function readSnapshot(file, { pair, network, chainId }) {
  if (!fs.existsSync(file)) return null;
  const record = parseFile(file);
  assertPairOf(record, file, pair);
  if (record.version === undefined) return fromVersionOne(record);
  if (record.version !== SNAPSHOT_VERSION) {
    throw new RehearsalError(
      `The snapshot at ${file} was written by version ${record.version} of this script, which this one cannot read. ${MOVE_ASIDE}`,
    );
  }
  assertWhole(record, file);
  assertTakenOn(record, file, { network, chainId });
  return fromVersionTwo(record);
}

const LEGACY_UNREADABLE =
  "it may be a snapshot of this pair cut off part-way, and the only record of the values before that rehearsal. Nothing was sent. Recover what you can of it, then move it aside and run again.";

/** The record in a file left in the cache; refuses one it cannot read, as it may be a baseline. */
function readLegacy(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new RehearsalError(
      `${file}, written by an earlier version of this script, cannot be read (${error.message}): ${LEGACY_UNREADABLE}`,
      { cause: error },
    );
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new RehearsalError(
      `${file}, written by an earlier version of this script, is not JSON (${error.message}): ${LEGACY_UNREADABLE}`,
    );
  }
}

/** Why a file left in the cache is no baseline of this pair: null when it may be one. */
function legacyNotUsed(file, pair) {
  const record = readLegacy(file);
  if (!record?.pair?.agent || !record?.pair?.escrow) {
    throw new RehearsalError(
      `${file}, written by an earlier version of this script, does not say which pair it was taken for: ${LEGACY_UNREADABLE}`,
    );
  }
  if (!sameValue(record.pair.agent, pair.agent) || !sameValue(record.pair.escrow, pair.escrow)) {
    return `it was taken for another pair (agent ${record.pair.agent}, escrow ${record.pair.escrow})`;
  }
  if (record.confirmed === true) return "its rehearsal was confirmed";
  return null;
}

/**
 * The snapshot earlier versions wrote to Hardhat's cache. It is read, and never written, moved
 * or deleted. One of this pair whose rehearsal was not confirmed may be the only record of the
 * values before that rehearsal, so nothing runs until it has been moved by hand, and so does one
 * that cannot be read, is not JSON or names no pair: it may be such a file cut off part-way. One
 * of another pair, or confirmed, is reported and left where it is.
 */
function checkLegacySnapshot({ file, pair, log, moveTo }) {
  if (!file || !fs.existsSync(file)) return;
  const reason = legacyNotUsed(file, pair);
  if (reason !== null) {
    log(
      `Warning: ${file} was written by an earlier version of this script; ${reason}, so it is not used. It is left where it is.`,
    );
    return;
  }
  throw new RehearsalError(
    `${file} was written by an earlier version of this script, for this pair, and its rehearsal was not confirmed: it may be the only record of the values before that rehearsal. Nothing was sent. Move it to ${moveTo} and run the confirm phase to check it against the chain, or move it aside if that rehearsal was returned by hand.`,
  );
}

module.exports = {
  snapshotPath,
  legacySnapshotPath,
  writeSnapshot,
  readSnapshot,
  checkLegacySnapshot,
};
