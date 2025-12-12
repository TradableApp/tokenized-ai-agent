const arweave = require("./arweave");
// const autonomys = require("./autonomys"); // Placeholder for the future

/**
 * Determines the storage provider based on the CID format.
 * This acts as a router to support multiple storage backends.
 * @param {string} cid The Content ID.
 * @returns {object} The appropriate storage utility module.
 */
function getProviderFromCID(cid) {
  // Heuristic for Arweave/Irys: Base64URL.
  // Standard Arweave is 43 chars, but Irys can sometimes return 44 chars.
  // We check for a valid range and character set.
  if (cid && cid.length >= 43 && cid.length <= 50 && /^[a-zA-Z0-9_-]+$/.test(cid)) {
    return arweave;
  }

  // Determine Autonomys provider by CID prefix (example placeholder).
  // if (cid && cid.startsWith("...")) {
  //   return autonomys;
  // }

  throw new Error(`Unsupported CID format: ${cid}`);
}

/**
 * Initializes all configured storage providers.
 */
async function initializeStorage() {
  await arweave.initializeIrys();

  // await autonomys.initialize(); // Autonomys initialization

  console.log("All storage providers initialized.");
}

/**
 * Uploads data using the primary (current) storage provider.
 * @param {Buffer} dataBuffer The data to upload.
 * @returns {Promise<string>} The resulting CID.
 */
async function uploadData(dataBuffer, tags = []) {
  // Currently, Arweave is our provider for all new uploads.
  return arweave.uploadData(dataBuffer, tags);

  // return autonomys.uploadData(dataBuffer, tags); // Autonomys upload
}

/**
 * Fetches data from the correct storage provider based on its CID.
 * @param {string} cid The Content ID of the data to fetch.
 * @returns {Promise<string>} The raw data as a string.
 */
async function fetchData(cid) {
  const provider = getProviderFromCID(cid);
  return provider.fetchData(cid);
}

/**
 * Queries for a transaction ID by its tags, delegating to the primary provider.
 * @param {Array<{name: string, value: string}>} tags The tags to search for.
 * @returns {Promise<string|null>} The first matching transaction ID, or null.
 */
async function queryTransactionByTags(tags) {
  // Currently, Arweave is our only provider that supports this.
  return arweave.queryTransactionByTags(tags);
}

module.exports = {
  initializeStorage,
  uploadData,
  fetchData,
  queryTransactionByTags,
};
