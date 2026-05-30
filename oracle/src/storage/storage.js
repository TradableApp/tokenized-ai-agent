const arweave = require("./arweave");
const autonomys = require("./autonomys");
const crypto = require("crypto");

// Mock storage in-memory cache (for USE_MOCK_STORAGE mode)
const mockStorageCache = new Map();

// --- Mock Flags ---
const USE_MOCK_STORAGE = process.env.USE_MOCK_STORAGE === "true";

// --- Provider Selection Logic ---

/**
 * Determines the storage provider based on the CID format.
 * This acts as a router to support multiple storage backends.
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
    console.log(`[Mock Storage] Uploaded data: ${mockCid}`);
    return mockCid;
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

  const provider = getProviderFromCID(cid);
  return provider.fetchData(cid);
}

/**
 * Queries for a transaction ID by its tags.
 * In MOCK mode, always returns null (no stored conversations).
 * In production, implements a Waterfall Strategy for backward compatibility.
 * @param {Array<{name: string, value: string}>} tags The tags to search for.
 * @returns {Promise<string|null>} The first matching CID, or null.
 */
async function queryTransactionByTags(tags) {
  if (USE_MOCK_STORAGE) {
    console.log("[Mock Storage] queryTransactionByTags returning null (no persistent storage)");
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
