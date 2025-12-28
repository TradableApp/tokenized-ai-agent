const arweave = require("./arweave");
const autonomys = require("./autonomys");

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
  // We initialize BOTH so we can read old Arweave data AND write new Autonomys data.
  await Promise.all([arweave.initializeIrys(), autonomys.initializeAutoDrive()]);
  console.log("Storage providers initialized (Arweave + Autonomys).");
}

/**
 * Uploads data using the primary (current) storage provider.
 * @param {Buffer} dataBuffer The data to upload.
 * @param {Array} tags Optional metadata tags.
 * @returns {Promise<string>} The resulting CID.
 */
async function uploadData(dataBuffer, tags = []) {
  // Use Autonomys as the primary provider for new uploads
  return autonomys.uploadData(dataBuffer, tags);
  // return arweave.uploadData(dataBuffer, tags);
}

/**
 * Fetches data from the correct storage provider based on its CID.
 * @param {string} cid The Content ID of the data to fetch.
 * @returns {Promise<string>} The raw data as a String (for consistency).
 */
async function fetchData(cid) {
  const provider = getProviderFromCID(cid);
  return provider.fetchData(cid);
}

/**
 * Queries for a transaction ID by its tags.
 * Implements a Waterfall Strategy for backward compatibility.
 * @param {Array<{name: string, value: string}>} tags The tags to search for.
 * @returns {Promise<string|null>} The first matching CID, or null.
 */
async function queryTransactionByTags(tags) {
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
