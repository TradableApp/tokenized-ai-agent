const arweave = require("./arweave");
const autonomys = require("./autonomys");
const ipfs = require("./ipfs");
const crypto = require("crypto");

// Mock storage in-memory cache (for USE_MOCK_STORAGE mode)
const mockStorageCache = new Map();
// Mock tag index: { cid, tags } per upload, in insertion order. Lets
// queryTransactionByTags resolve CIDs within a single run — notably the
// per-conversation rofl-key file that getSessionKey() looks up on every
// follow-up message (regeneration/branch/multi-turn). Newest-first matching
// mirrors the real providers' "first match" semantics.
const mockTagIndex = [];

// --- Mock Flags ---
const USE_MOCK_STORAGE = process.env.USE_MOCK_STORAGE === "true";

// Local IPFS (Kubo) mode — LOCALNET ONLY. When LOCAL_IPFS_API_URL is set, answer
// content is stored in / fetched from a real local IPFS node (so the dApp can
// hydrate it by CID), while tag lookups still use the in-memory index above —
// plain IPFS has no tag query. MOCK_AI stays true for deterministic answers; only
// the storage layer becomes real. Never set in production (keeps Kubo out of the
// TEE path).
const LOCAL_IPFS_API_URL = process.env.LOCAL_IPFS_API_URL;
const USE_LOCAL_IPFS = !!LOCAL_IPFS_API_URL;

// Both mock and local-IPFS modes resolve tags via the in-memory index.
const USE_IN_MEMORY_TAG_INDEX = USE_MOCK_STORAGE || USE_LOCAL_IPFS;

// --- Provider Selection Logic ---

/**
 * Determines the storage provider based on the CID format.
 * This acts as a router to support multiple storage backends.
 * NOTE: LOCAL_IPFS mode does NOT use this router — fetchData short-circuits to
 * ipfs.fetchData before reaching here. So this only distinguishes Autonomys vs
 * Arweave. The CID-format ordering contract that matters (Autonomys before the
 * broad IPFS pattern) lives on the consumer side, sense-ai-dapp's
 * getStorageProvider — keep the two in lockstep.
 * @param {string} cid The Content ID.
 * @returns {object} The appropriate storage utility module.
 */
function getProviderFromCID(cid) {
  // Autonomys Auto Drive CID validation
  // Format: CIDv1 with base32 encoding
  // Starts with 'bafkr6i' (base32 prefix + CIDv1 identifier)
  // Uses base32 character set: a-z, 2-7
  if (cid && /^bafkr6i[a-z2-7]{52}$/.test(cid)) {
    return autonomys;
  }

  // Heuristic for Arweave/Irys: Base64URL (check second - less specific)
  // Standard Arweave is 43 chars, but Irys can sometimes return 44 chars.
  // We check for a valid range and character set.
  if (cid && cid.length >= 43 && cid.length <= 44 && /^[a-zA-Z0-9_-]+$/.test(cid)) {
    return arweave;
  }

  throw new Error(`Unsupported CID format: ${cid}`);
}

// --- Public API ---

/**
 * Initializes all configured storage providers.
 */
async function initializeStorage() {
  if (USE_MOCK_STORAGE) {
    console.log("Storage providers initialized (MOCK STORAGE MODE).");
    mockStorageCache.clear();
    mockTagIndex.length = 0;
    return;
  }

  if (USE_LOCAL_IPFS) {
    await ipfs.initialize(LOCAL_IPFS_API_URL);
    console.log("Storage providers initialized (LOCAL IPFS MODE).");
    mockTagIndex.length = 0;
    return;
  }

  if (process.env.STORAGE_PROVIDER === "irys") {
    await arweave.initializeIrys();
    console.log("Storage providers initialized (Irys only — STORAGE_PROVIDER=irys).");
  } else {
    // Initialize BOTH so we can read old Arweave data AND write new Autonomys data.
    await Promise.all([arweave.initializeIrys(), autonomys.initializeAutoDrive()]);
    console.log("Storage providers initialized (Arweave + Autonomys).");
  }
}

/**
 * Uploads data using the primary (current) storage provider.
 * In MOCK mode, stores data in-memory and returns a deterministic CID.
 * @param {Buffer} dataBuffer The data to upload.
 * @param {Array} tags Optional metadata tags.
 * @returns {Promise<string>} The resulting CID.
 */
async function uploadData(dataBuffer, tags = []) {
  if (USE_MOCK_STORAGE) {
    // Generate a deterministic mock CID based on the data hash
    const hash = crypto.createHash("sha256").update(dataBuffer).digest("hex");
    const mockCid = `mock_${hash.substring(0, 20)}`;
    mockStorageCache.set(mockCid, dataBuffer);
    if (Array.isArray(tags) && tags.length > 0) {
      mockTagIndex.push({ cid: mockCid, tags });
    }
    console.log(`[Mock Storage] Uploaded data: ${mockCid}`);
    return mockCid;
  }

  if (USE_LOCAL_IPFS) {
    // Real CID from the local node; record tags in the in-memory index so
    // queryTransactionByTags resolves within the run (IPFS has no tag query).
    const cid = await ipfs.uploadData(dataBuffer, tags);
    if (Array.isArray(tags) && tags.length > 0) {
      mockTagIndex.push({ cid, tags });
    }
    return cid;
  }

  if (process.env.STORAGE_PROVIDER === "irys") {
    return arweave.uploadData(dataBuffer, tags);
  }
  return autonomys.uploadData(dataBuffer, tags);
}

/**
 * Fetches data from the correct storage provider based on its CID.
 * In MOCK mode, retrieves data from in-memory cache.
 * @param {string} cid The Content ID of the data to fetch.
 * @returns {Promise<string>} The raw data as a String (for consistency).
 */
async function fetchData(cid) {
  if (USE_MOCK_STORAGE) {
    if (mockStorageCache.has(cid)) {
      const data = mockStorageCache.get(cid);
      console.log(`[Mock Storage] Retrieved data: ${cid}`);
      // Return as string for consistency with real storage layer
      return data.toString("utf-8");
    }
    console.warn(`[Mock Storage] CID not found in cache: ${cid}`);
    return null;
  }

  if (USE_LOCAL_IPFS) {
    // Localnet routes EVERY CID to the local node (getProviderFromCID is bypassed):
    // all CIDs this run were produced by ipfs.uploadData. A stale `mock_…` CID from
    // a prior USE_MOCK_STORAGE run would 404 here, but each e2e run starts fresh.
    return ipfs.fetchData(cid);
  }

  const provider = getProviderFromCID(cid);
  return provider.fetchData(cid);
}

/**
 * Queries for a transaction ID by its tags.
 * In MOCK mode, resolves against the in-memory tag index (newest match first)
 * so within-run lookups — e.g. the per-conversation rofl-key file — succeed.
 * In production, implements a Waterfall Strategy for backward compatibility.
 * @param {Array<{name: string, value: string}>} tags The tags to search for.
 * @returns {Promise<string|null>} The first matching CID, or null.
 */
async function queryTransactionByTags(tags) {
  if (USE_IN_MEMORY_TAG_INDEX) {
    // Mock and local-IPFS modes resolve tags from the in-memory index (plain IPFS
    // has no tag query). Return the most recent CID whose tags satisfy ALL query
    // tags.
    for (let i = mockTagIndex.length - 1; i >= 0; i--) {
      const entry = mockTagIndex[i];
      const matchesAll = tags.every((q) =>
        entry.tags.some((t) => t.name === q.name && t.value === q.value),
      );
      if (matchesAll) {
        console.log(`[Tag Index] queryTransactionByTags matched ${entry.cid}`);
        return entry.cid;
      }
    }
    console.log("[Tag Index] queryTransactionByTags: no match in in-memory tag index");
    return null;
  }

  // Try Primary Provider (Autonomys) first
  try {
    const autoCid = await autonomys.queryTransactionByTags(tags);
    if (autoCid) {
      return autoCid;
    }
  } catch (error) {
    console.warn("Error querying Autonomys tags (continuing to fallback):", error.message);
  }

  // Fallback to Legacy Provider (Arweave)
  // This ensures old conversations can still be resumed
  try {
    const arweaveCid = await arweave.queryTransactionByTags(tags);
    if (arweaveCid) {
      console.log("Found tag match on Arweave (Legacy).");
      return arweaveCid;
    }
  } catch (error) {
    console.warn("Error querying Arweave tags:", error.message);
  }

  return null;
}

module.exports = {
  initializeStorage,
  uploadData,
  fetchData,
  queryTransactionByTags,
};
