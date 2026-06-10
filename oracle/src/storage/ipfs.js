/**
 * @file ipfs.js
 * @notice Local IPFS (Kubo) storage provider — LOCALNET ONLY.
 *
 * Mirrors the autonomys/arweave provider interface (`uploadData`/`fetchData`) but
 * talks to the e2e stack's Kubo node over its HTTP API. Selected by storage.js
 * when `LOCAL_IPFS_API_URL` is set. Implemented **dependency-free** (global
 * `fetch`/`FormData`/`Blob`) so nothing IPFS-related ships in the production/ROFL
 * image — the provider only loads/initialises on localnet.
 *
 * @dev Why this exists: in localnet e2e, `MOCK_AI` stays `true` (deterministic
 * answers) but storage must be REAL and retrievable, because the dApp hydrates
 * answer content by fetching the CID from a gateway. The in-memory mock store
 * kept payloads in-process only, so the dApp's display loop never completed.
 * Real local IPFS gives both sides a shared, fetchable store with real CIDs.
 *
 * Plain IPFS has no tag query, so tag-based lookup (`queryTransactionByTags`)
 * stays in storage.js's in-memory index (now mapping tags → real CIDs). This
 * layer only moves bytes.
 */

let apiUrl = null;

function ensureInitialized() {
  if (!apiUrl) {
    throw new Error("Local IPFS provider not initialized.");
  }
}

/**
 * @notice Point the provider at a Kubo HTTP API and verify it is reachable.
 * @param {string} url e.g. "http://localhost:5001"
 */
async function initialize(url) {
  const cleanUrl = url.replace(/\/+$/, "");
  // Fail fast with a clear message if Kubo isn't up (the Kubo API is POST-only).
  const res = await fetch(`${cleanUrl}/api/v0/version`, { method: "POST" });
  if (!res.ok) {
    throw new Error(`Local IPFS (Kubo) not reachable at ${cleanUrl} (status ${res.status}).`);
  }
  const { Version } = await res.json();
  // Only set after the connectivity check passes, so a failed init leaves the
  // provider uninitialised and ensureInitialized() still guards later calls.
  apiUrl = cleanUrl;
  console.log(`Local IPFS provider initialized (Kubo ${Version} @ ${apiUrl}).`);
}

/**
 * @notice Add data to the local IPFS node and return its CIDv1.
 * @param {Buffer} dataBuffer The data to store.
 * @param {Array<{name: string, value: string}>} _tags Unused here — the tag index
 *        lives in storage.js (plain IPFS has no tag query).
 * @returns {Promise<string>} The resulting CIDv1.
 */
async function uploadData(dataBuffer, _tags = []) {
  ensureInitialized();

  // cid-version=1 so the dApp can recognise it as an IPFS CIDv1; pin so the
  // content survives for the run.
  const form = new FormData();
  form.append("file", new Blob([dataBuffer]));

  const res = await fetch(`${apiUrl}/api/v0/add?cid-version=1&pin=true`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    throw new Error(`IPFS add failed (status ${res.status}): ${await res.text()}`);
  }

  // Kubo returns newline-delimited JSON; the final line is the added file.
  const lines = (await res.text()).trim().split("\n").filter(Boolean);
  if (lines.length === 0) {
    throw new Error("IPFS add returned an empty response body (expected NDJSON with a Hash).");
  }
  const { Hash } = JSON.parse(lines[lines.length - 1]);
  if (!Hash) {
    throw new Error(`IPFS add response missing Hash field: ${lines[lines.length - 1]}`);
  }
  console.log(`Data uploaded to local IPFS ==> CID: ${Hash}`);

  return Hash;
}

/**
 * @notice Fetch data from the local IPFS node by CID.
 * @param {string} cid The CID of the data to fetch.
 * @returns {Promise<string>} The raw data as a UTF-8 string (matches the other
 *          providers, since payloads are AES-GCM ciphertext strings).
 */
async function fetchData(cid) {
  ensureInitialized();

  const res = await fetch(`${apiUrl}/api/v0/cat?arg=${encodeURIComponent(cid)}`, {
    method: "POST",
  });
  if (!res.ok) {
    throw new Error(`IPFS cat failed for ${cid} (status ${res.status}): ${await res.text()}`);
  }

  const data = await res.text();
  console.log(`Data fetched from local IPFS. CID: ${cid}, Size: ${data.length} bytes`);

  return data;
}

module.exports = {
  initialize,
  uploadData,
  fetchData,
};
