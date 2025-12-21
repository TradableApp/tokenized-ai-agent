const { createAutoDriveApi } = require("@autonomys/auto-drive");
const { NetworkId } = require("@autonomys/auto-utils");
const { sendAlert } = require("../alerting");

let autoDriveApi = null;
const API_BASE_URL = "https://mainnet.auto-drive.autonomys.xyz/api";

// Helper to select network based on Env (Defaults to TAURUS for testnet)
function getNetworkId() {
  // const envNetwork = process.env.AUTONOMYS_NETWORK || "testnet";

  // For now just using mainnet
  return NetworkId.MAINNET;
  // return envNetwork === "mainnet" ? NetworkId.MAINNET : NetworkId.TAURUS;
}

/**
 * Internal helper to fetch account info directly via API
 * (Since SDK getPendingCredits is currently unavailable)
 */
async function fetchAccountInfo() {
  const apiKey = process.env.AUTONOMYS_API_KEY;

  if (!apiKey) {
    throw new Error("AUTONOMYS_API_KEY not found");
  }

  const response = await fetch(`${API_BASE_URL}/accounts/@me`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
      "X-Auth-Provider": "apikey",
    },
  });

  if (!response.ok) {
    throw new Error(`Autonomys API error: ${response.status} ${response.statusText}`);
  }

  return await response.json();
}

/**
 * Checks the Autonomys Auto Drive credits and sends an alert if low.
 */
async function checkAutoDriveCredits() {
  if (!autoDriveApi) {
    throw new Error("Autonomys Auto Drive not initialized.");
  }

  try {
    /* The following code will only work in future deployments of @autonomys/auto-drive */
    // const credits = await autoDriveApi.getPendingCredits();
    // console.log(`Autonomys Credits - Upload: ${credits.upload}, Download: ${credits.download}`);
    // const subscriptionInfo = await autoDriveApi.getSubscriptionInfo();
    // console.log(`Subscription Info:`, JSON.stringify(subscriptionInfo, null, 2));

    /* Making requests for the credit data directly from the API instead */
    const accountInfo = await fetchAccountInfo();
    const uploadCredits = accountInfo.pendingUploadCredits;
    const downloadCredits = accountInfo.pendingDownloadCredits;

    // Convert to readable MB for logs
    const uploadMB = (uploadCredits / (1024 * 1024)).toFixed(2);
    const downloadMB = (downloadCredits / (1024 * 1024)).toFixed(2);
    console.log(
      `Autonomys Credits - Upload: ${uploadCredits} (${uploadMB} MB), Download: ${downloadCredits} (${downloadMB})`,
    );

    // Alert thresholds (configurable via environment variables)
    // Default threshold: 10MB (10 * 1024 * 1024 bytes)
    const uploadThreshold =
      parseInt(process.env.AUTONOMYS_UPLOAD_CREDIT_THRESHOLD) || 10 * 1024 * 1024;
    const downloadThreshold =
      parseInt(process.env.AUTONOMYS_DOWNLOAD_CREDIT_THRESHOLD) || 10 * 1024 * 1024;

    if (uploadCredits < uploadThreshold) {
      await sendAlert(
        "Autonomys Upload Credits Low",
        `Upload credits (${uploadMB} MB) are below threshold. Please top up the account at https://ai3.storage/`,
      );
    }

    if (downloadCredits < downloadThreshold) {
      await sendAlert(
        "Autonomys Download Credits Low",
        `Download credits (${downloadMB} MB) are below threshold. Please top up the account at https://ai3.storage/`,
      );
    }
  } catch (e) {
    console.error("Failed to check Autonomys Auto Drive credits:", e);

    await sendAlert(
      "Autonomys Credit Check Failed",
      `Failed to check Autonomys credits. Error: ${e.message}`,
    );
  }
}

/**
 * Initializes the Autonomys Auto Drive API instance and performs a proactive credit check.
 */
async function initializeAutoDrive() {
  const apiKey = process.env.AUTONOMYS_API_KEY;

  if (!apiKey) {
    throw new Error("Missing required Autonomys environment variable: AUTONOMYS_API_KEY");
  }

  const network = getNetworkId();

  autoDriveApi = createAutoDriveApi({
    apiKey: apiKey,
    network: network,
  });

  console.log(`Autonomys Auto Drive initialized for network: ${network}`);

  await checkAutoDriveCredits();
}

/**
 * Ensures sufficient credits are available for upload.
 * Note: Auto Drive doesn't provide cost estimation, so we check for minimum credits.
 * @param {number} dataSizeBytes The size of the data (for logging only).
 */
async function ensureCreditsAreSufficient(dataSizeBytes) {
  if (!autoDriveApi) {
    throw new Error("Autonomys Auto Drive not initialized.");
  }

  try {
    const accountInfo = await fetchAccountInfo();
    const remainingCredits = accountInfo.pendingUploadCredits;
    const sizeMB = (dataSizeBytes / (1024 * 1024)).toFixed(6);

    console.log(
      `Preparing to upload ${dataSizeBytes} bytes. Remaining credits: ${remainingCredits}`,
    );

    if (remainingCredits < dataSizeBytes) {
      const errorMessage = `Insufficient upload credits. Required: ${dataSizeBytes}, Remaining: ${remainingCredits}.`;

      await sendAlert(
        "CRITICAL: Autonomys Insufficient Credits",
        `${errorMessage}\nPlease top up the account at https://ai3.storage/`,
      );

      throw new Error(errorMessage);
    }
  } catch (e) {
    console.error("Credit sufficiency check failed:", e);

    throw e;
  }
}

/**
 * Uploads data to Autonomys Auto Drive.
 * @param {Buffer} dataBuffer The data to upload.
 * @param {Array<{name: string, value: string}>} tags Optional metadata tags.
 * @returns {Promise<string>} The CID of the uploaded data.
 */
async function uploadData(dataBuffer, tags = []) {
  if (!autoDriveApi) {
    throw new Error("Autonomys Auto Drive not initialized.");
  }

  try {
    // Check credits before upload
    await ensureCreditsAreSufficient(dataBuffer.length);

    // Extract metadata from tags
    let fileName = `file-${Date.now()}.json`;
    let mimeType = "application/json";

    for (const tag of tags) {
      if (tag.name === "Content-Type") {
        mimeType = tag.value;
      } else if (tag.name === "File-Name") {
        fileName = tag.value;
      }
    }

    // Create GenericFile interface for upload
    const genericFile = {
      read: async function* () {
        yield dataBuffer;
      },
      name: fileName,
      mimeType: mimeType,
      size: dataBuffer.length,
      path: fileName,
    };

    const options = {
      compression: true,
      onProgress: (progress) => {
        // Log every 25% to avoid spamming logs
        if (progress % 25 === 0 && progress > 0) {
          console.log(`Autonomys upload progress: ${progress}%`);
        }
      },
    };

    const cid = await autoDriveApi.uploadFile(genericFile, options);
    console.log(`Data uploaded to Autonomys ==> CID: ${cid}`);

    return cid;
  } catch (e) {
    const errorMessage = `Upload to Autonomys Auto Drive failed. Error: ${e.message}`;

    console.error(errorMessage, e);

    await sendAlert("CRITICAL: Autonomys Upload Failed", errorMessage);

    throw e;
  }
}

/**
 * Fetches data from Autonomys Auto Drive.
 * @param {string} cid The CID of the data to fetch.
 * @returns {Promise<string>} The raw data as a UTF-8 String (for compatibility with both Arweave and Autonomys logic).
 */
async function fetchData(cid) {
  if (!autoDriveApi) {
    throw new Error("Autonomys Auto Drive not initialized.");
  }

  try {
    const stream = await autoDriveApi.downloadFile(cid);
    let fileBuffer = Buffer.alloc(0);

    for await (const chunk of stream) {
      fileBuffer = Buffer.concat([fileBuffer, chunk]);
    }
    console.log(`Data fetched from Autonomys. CID: ${cid}, Size: ${fileBuffer.length} bytes`);

    // Convert Buffer to String to match the Arweave implementation
    return fileBuffer.toString("utf-8");
  } catch (e) {
    const errorMessage = `Failed to fetch CID ${cid} from Autonomys Auto Drive. Error: ${e.message}`;

    console.error(errorMessage, e);

    await sendAlert("Autonomys Download Failed", errorMessage);

    throw e;
  }
}

/**
 * Queries for files by name in the user's Autonomys Auto Drive.
 * @param {Array<{name: string, value: string}>} tags The tags to search for.
 * @returns {Promise<string|null>} The first matching CID, or null.
 */
async function queryTransactionByTags(tags) {
  if (!autoDriveApi) {
    throw new Error("Autonomys Auto Drive not initialized.");
  }

  let searchValue = null;

  for (const tag of tags) {
    // Map our internal tag names to what we can search in Auto Drive (Filename)
    if (
      tag.name === "File-Name" ||
      tag.name === "name" ||
      tag.name === "SenseAI-Key-For-Conversation"
    ) {
      searchValue = tag.value;
      break;
    }
  }

  if (!searchValue) {
    console.log(
      "No searchable tag found. Supported tags for Autonomys: 'File-Name', 'name', 'SenseAI-Key-For-Conversation'",
    );

    return null;
  }

  try {
    const results = await autoDriveApi.searchByNameOrCIDInMyFiles(searchValue);

    if (results && results.length > 0) {
      console.log(`Found ${results.length} matching file(s) for query: "${searchValue}"`);

      return results[0].headCid;
    }
    console.log(`No files found matching query: "${searchValue}"`);

    return null;
  } catch (error) {
    console.error("Error querying Autonomys Auto Drive for tags:", error);

    return null;
  }
}

/**
 * Lists user's files with pagination.
 * @param {number} page Page number (0-indexed).
 * @param {number} limit Number of files per page (max 100).
 * @returns {Promise<object>} Paginated file list.
 */
async function listMyFiles(page = 0, limit = 100) {
  if (!autoDriveApi) {
    throw new Error("Autonomys Auto Drive not initialized.");
  }

  try {
    const myFiles = await autoDriveApi.getMyFiles(page, limit);
    console.log(
      `Retrieved ${myFiles.rows.length} files of ${myFiles.totalCount} total (page ${page})`,
    );
    return myFiles;
  } catch (error) {
    console.error("Error listing Autonomys files:", error);
    throw error;
  }
}

module.exports = {
  initializeAutoDrive,
  uploadData,
  fetchData,
  queryTransactionByTags,
  listMyFiles,
  checkAutoDriveCredits,
};
