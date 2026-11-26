"use strict";

/**
 * The shapes of a content id the oracle's storage paths produce, and so the only ids it will
 * fetch. A prompt names an earlier message by such an id inside its encrypted payload, and a
 * message file names its parent by one; both are the user's to choose, so an id is checked here
 * before it is fetched, routed or printed.
 *
 * - Autonomys Auto Drive (`autonomys.uploadData`): a CIDv1 in base32 of a 32-byte BLAKE3 hash
 *   with the raw codec, so always `bafkr6i` and 52 more of `[a-z2-7]` (59 characters).
 * - Irys / Arweave (`arweave.uploadData`, read for older conversations): a transaction id, the
 *   base64url of a 32-byte hash, 43 characters. 44 is also taken, as the router has always taken
 *   it and the dApp reads it, so no stored conversation that held one is cut off.
 * - Local IPFS (`ipfs.uploadData`, localnet only, `LOCAL_IPFS_API_URL` set): Kubo's CIDv1 of a
 *   SHA-256 hash, `bafkrei` for a file in one block or `bafybei` for one in several, then 52
 *   of `[a-z2-7]`.
 * - Mock storage (`USE_MOCK_STORAGE=true`, tests and localnet only): `mock_` and 20 hex.
 *
 * Every one of these is inside the dApp's rule for a content id (1 to 128 of `[A-Za-z0-9_-]`),
 * so an id the oracle accepts is one the dApp can read, and none can carry a line break, a path
 * or a host.
 */

const AUTONOMYS_ID = /^bafkr6i[a-z2-7]{52}$/;
const ARWEAVE_ID = /^[A-Za-z0-9_-]{43,44}$/;
const LOCAL_IPFS_ID = /^baf(?:kr|yb)ei[a-z2-7]{52}$/;
const MOCK_ID = /^mock_[0-9a-f]{20}$/;

/** Which storage holds the file this id names, or null when it is not an id it produces. */
function contentIdKind(value, env = process.env) {
  if (typeof value !== "string") return null;
  if (AUTONOMYS_ID.test(value)) return "autonomys";
  if (ARWEAVE_ID.test(value)) return "arweave";
  if (env.LOCAL_IPFS_API_URL && LOCAL_IPFS_ID.test(value)) return "local-ipfs";
  if (env.USE_MOCK_STORAGE === "true" && MOCK_ID.test(value)) return "mock";
  return null;
}

/** Is this an id one of the oracle's storage paths produces (under the current settings)? */
function isContentId(value, env = process.env) {
  return contentIdKind(value, env) !== null;
}

/**
 * The id for a log line: itself once it has a content id's shape, otherwise only its type and
 * length, so a value the user chose never reaches a log as it was sent.
 */
function printableContentId(value, env = process.env) {
  if (isContentId(value, env)) return value;
  if (typeof value === "string") return `[not a content id, ${value.length} characters]`;
  return `[not a content id, ${value === null ? "null" : typeof value}]`;
}

module.exports = { contentIdKind, isContentId, printableContentId };
