const fs = require("fs");
const path = require("path");

const { sameValue, RehearsalError } = require("./values");

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

/**
 * Writes the snapshot whole: to a temporary file in the same folder, synced to disk, then
 * renamed over the old one. A run stopped part-way leaves the old snapshot or the new one,
 * never a cut-off file.
 */
function writeSnapshot(file, snapshot) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const record = {
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
  const temporary = `${file}.tmp-${process.pid}`;
  const descriptor = fs.openSync(temporary, "w");
  try {
    fs.writeFileSync(descriptor, JSON.stringify(record, null, 2));
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, file);
  return file;
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

function fromVersionTwo(record) {
  return {
    version: 2,
    network: record.network,
    chainId: BigInt(record.chainId),
    pair: record.pair,
    safe: record.safe,
    rehearsalPromptFee:
      record.rehearsalPromptFee === null || record.rehearsalPromptFee === undefined
        ? null
        : BigInt(record.rehearsalPromptFee),
    baseline: withFee(record.baseline),
    steps: record.steps ?? {},
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
