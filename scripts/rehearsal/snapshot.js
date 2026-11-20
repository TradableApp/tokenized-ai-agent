const fs = require("fs");
const path = require("path");

const { sameValue } = require("./values");

/**
 * The snapshot holds the pre-rehearsal values and the pair they were read from. The file is
 * named after the network only, so one left by a rehearsal of another pair would otherwise be
 * taken as this pair's baseline, and its treasury and fee written here as a "restore".
 * `safe` is the Safe the rehearsal was run with: it is authorised as an oracle on the way, and the
 * confirm phase checks it no longer is. `confirmed` marks a rehearsal the confirm phase has
 * passed: its values are no longer a baseline.
 */
function writeSnapshot(state, file, pair, { safe, confirmed = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const serialisable = Object.fromEntries(Object.entries(state).map(([k, v]) => [k, String(v)]));
  const record = {
    ...serialisable,
    pair,
    ...(safe ? { safe } : {}),
    ...(confirmed ? { confirmed: true } : {}),
  };
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
  return file;
}

/**
 * Reads the snapshot for `pair`: `{ state, safe, confirmed }`. Refuses one that is not this
 * pair's.
 */
function readSnapshot(file, pair) {
  if (!fs.existsSync(file)) {
    throw new Error(
      `No snapshot at ${file}; run the forward phase first (for example bun run rehearse:base-testnet)`,
    );
  }
  const { pair: recorded, safe, confirmed, ...raw } = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!recorded?.agent || !recorded?.escrow) {
    throw new Error(
      `The snapshot at ${file} does not say which pair it was taken for, so it cannot be used as a baseline. Move it aside if it belongs to a rehearsal still to be returned by hand, or delete it, then run the forward phase again.`,
    );
  }
  if (!sameValue(recorded.agent, pair.agent) || !sameValue(recorded.escrow, pair.escrow)) {
    throw new Error(
      `The snapshot at ${file} was taken for another pair (agent ${recorded.agent}, escrow ${recorded.escrow}), not agent ${pair.agent}, escrow ${pair.escrow}. Nothing was sent. Move it aside or delete it, then run the forward phase again.`,
    );
  }
  return {
    state: { ...raw, promptFee: BigInt(raw.promptFee) },
    safe,
    confirmed: confirmed === true,
  };
}

module.exports = { writeSnapshot, readSnapshot };
