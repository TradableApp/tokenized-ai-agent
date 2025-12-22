const dotenv = require("dotenv");
const ethCrypto = require("eth-crypto");
const { ethers } = require("ethers");
const path = require("path");
const fs = require("fs/promises");
const { v5: uuidv5 } = require("uuid");
const crypto = require("crypto");
const { default: PQueue } = require("p-queue");
const { Mutex } = require("async-mutex");

const { initializeOracle } = require("./contractUtility");
const {
  initializeStorage,
  uploadData,
  fetchData,
  queryTransactionByTags,
} = require("./storage/storage");
const {
  createConversationFile,
  createConversationMetadataFile,
  createMessageFile,
  createSearchIndexDeltaFile,
} = require("./formatters");
const { submitTx } = require("./roflUtility");
const { sendAlert } = require("./alerting");
const { validatePayload } = require("./payloadValidator");

// --- Configuration & Initialization ---

// Load the specific environment file first for precedence.
if (process.env.ENV_FILE) {
  dotenv.config({ path: process.env.ENV_FILE });
}
// Load the base .env.oracle file to fill in any missing non-secret variables.
dotenv.config({ path: path.resolve(__dirname, "../.env.oracle") });

const NAMESPACE_UUID = "f7e8a6a0-8d5d-4f7d-8f8a-8c7d6e5f4a3b";
const STATE_FILE_PATH = path.resolve(__dirname, "../oracle-state.json");
const FAILED_JOBS_FILE_PATH = path.resolve(__dirname, "../failed-jobs.json");
const AI_CONTEXT_MESSAGES_LIMIT = parseInt(process.env.AI_CONTEXT_MESSAGES_LIMIT) || 20;
const RETRY_INTERVAL_MS = 60 * 1000; // Check for failed jobs every 60 seconds
const MAX_RETRIES = 10;
const BASE_RETRY_DELAY_MS = 30 * 1000; // Start with a 30-second delay
const NETWORK_NAME = process.env.NETWORK_NAME;
const AI_AGENT_PRIVATE_KEY = process.env.PRIVATE_KEY;
const AI_AGENT_CONTRACT_ADDRESS = process.env.AI_AGENT_CONTRACT_ADDRESS;

// This single function from our utility handles all environment-specific setup.
let { provider, signer, contract, isSapphire } = initializeOracle(
  NETWORK_NAME,
  AI_AGENT_PRIVATE_KEY,
  AI_AGENT_CONTRACT_ADDRESS,
);

// This function allows tests to inject mocked components.
function initForTest(testComponents) {
  provider = testComponents.provider;
  signer = testComponents.signer;
  contract = testComponents.contract;
  isSapphire = testComponents.isSapphire;
}

// --- CONCURRENCY CONTROL ---

// Transaction Mutex: Ensures we NEVER send 2 transactions simultaneously (prevents Nonce errors)
// This implements the "Mutual Exclusion" pattern from the async-mutex docs.
const txMutex = new Mutex();

// Job Queue: Limits concurrency to 5.
// This implements the "Promise queue with concurrency control" pattern from p-queue docs.
const queue = new PQueue({ concurrency: 5 });

console.log(`--- AI AGENT ORACLE STARTING ON: ${NETWORK_NAME.toUpperCase()} ---`);
console.log(`Oracle signer address: ${signer.address}`);
console.log(`Contract address: ${contract.target}`);
console.log(
  `Operating in ${isSapphire ? "Sapphire (confidential)" : "Public EVM (encrypted)"} mode.`,
);

// --- Cryptography Helpers ---

/**
 * [EVM ONLY] Removes the '0x' prefix from a hex string, which is required by eth-crypto.
 * @param {string} hexString - The hex string, which may or may not have a '0x' prefix.
 * @returns {string} The raw hex string without the '0x' prefix.
 */
function strip0xPrefix(hexString) {
  return hexString.startsWith("0x") ? hexString.slice(2) : hexString;
}

/**
 * Symmetrically encrypts a data object using AES-256-GCM.
 * @param {object} dataObject The object to encrypt.
 * @param {Buffer} key The 32-byte symmetric key.
 * @returns {string} A string containing "iv.authTag.encryptedData".
 */
function encryptSymmetrically(dataObject, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const dataBuffer = Buffer.from(JSON.stringify(dataObject));

  // The auth tag MUST be appended to the encrypted data to match Web Crypto's output.
  const encryptedContent = Buffer.concat([cipher.update(dataBuffer), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const combinedBuffer = Buffer.concat([encryptedContent, authTag]);

  // Use BASE64 encoding and the "iv.encrypted" format to match the frontend.
  return `${iv.toString("base64")}.${combinedBuffer.toString("base64")}`;
}

/**
 * Symmetrically decrypts data encrypted with AES-256-GCM.
 * @param {string} encryptedString The "iv.authTag.encryptedData" string.
 * @param {Buffer} key The 32-byte symmetric key.
 * @returns {object} The decrypted and parsed JSON object.
 */
function decryptSymmetrically(encryptedString, key) {
  // Check for the correct two-part format.
  const parts = encryptedString.split(".");
  if (parts.length !== 2) {
    throw new Error('Invalid encrypted data format. Expected "iv.encryptedData".');
  }

  const iv = Buffer.from(parts[0], "base64");
  const combinedBuffer = Buffer.from(parts[1], "base64");

  // The auth tag is the final 16 bytes of the combined buffer.
  const authTag = combinedBuffer.slice(-16);
  const encryptedData = combinedBuffer.slice(0, -16);

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
  return JSON.parse(decrypted.toString("utf-8"));
}

/**
 * Retrieves the session key for an operation. It first checks the event payload.
 * If the key is not present (e.g., for a scheduled job), it falls back to querying the
 * storage provider for a deterministically tagged "Key File" associated with the conversation/job.
 * @param {string} payload - The raw payload from the event.
 * @param {string} roflEncryptedKey - The encrypted key from the event payload.
 * @param {string} conversationId - The conversation ID, used for the fallback query.
 * @returns {Promise<Buffer>} The 32-byte symmetric session key.
 */
async function getSessionKey(payload, roflEncryptedKey, conversationId) {
  if (isSapphire) {
    const parsedPayload = JSON.parse(payload);
    if (parsedPayload.sessionKey) {
      return Buffer.from(strip0xPrefix(parsedPayload.sessionKey), "hex");
    }
  } else if (roflEncryptedKey && roflEncryptedKey !== "0x") {
    // The roflEncryptedKey comes in as a Hex String (0x...).
    // We must convert it to the original UTF-8 Cipher String (iv...ephemKey...mac)
    // before passing it to ethCrypto.
    const cipherString = ethers.toUtf8String(roflEncryptedKey);

    const sessionKeyHex = await ethCrypto.decryptWithPrivateKey(
      AI_AGENT_PRIVATE_KEY,
      ethCrypto.cipher.parse(cipherString),
    );

    return Buffer.from(strip0xPrefix(sessionKeyHex), "hex");
  }

  if (conversationId) {
    console.log(
      `Key not in payload for convId ${conversationId}, querying storage for fallback...`,
    );
    const { chainId } = await provider.getNetwork();
    const keyFileCID = await queryTransactionByTags([
      { name: "Content-Type", value: "application/rofl-key" },
      { name: "SenseAI-Key-For-Conversation", value: `${chainId}-${conversationId}` },
    ]);
    if (!keyFileCID) {
      throw new Error(`Could not find Key File for conversation ${conversationId}.`);
    }
    const fetchedRoflEncryptedKey = await fetchData(keyFileCID);
    const sessionKeyHex = await ethCrypto.decryptWithPrivateKey(
      AI_AGENT_PRIVATE_KEY,
      ethCrypto.cipher.parse(fetchedRoflEncryptedKey),
    );
    return Buffer.from(strip0xPrefix(sessionKeyHex), "hex");
  }

  throw new Error(
    "Could not determine session key: Not in payload and no conversationId provided for fallback.",
  );
}

// --- Storage & History Helpers ---

async function encryptAndUpload(dataObject, sessionKey, tags = []) {
  const encryptedString = encryptSymmetrically(dataObject, sessionKey);
  const dataBuffer = Buffer.from(encryptedString);
  return uploadData(dataBuffer, tags);
}

async function fetchAndDecrypt(cid, sessionKey) {
  const encryptedString = await fetchData(cid);
  return decryptSymmetrically(encryptedString, sessionKey);
}

/**
 * Walks backwards up the message chain on decentralised storage to reconstruct conversation history.
 * @param {string} startMessageCID The CID of the latest message in the thread.
 * @param {string | null} sessionKey The key for decryption (EVM only).
 * @returns {Promise<Array<object>>} An array of message objects for the AI context.
 */
async function reconstructHistory(startMessageCID, sessionKey) {
  if (!startMessageCID) {
    return [];
  }

  // Limit history fetching to avoid infinite loops and excessive costs.
  const history = [];
  let currentCid = startMessageCID;
  // Limit history fetching to avoid infinite loops and excessive costs.
  for (let i = 0; i < AI_CONTEXT_MESSAGES_LIMIT; i += 1) {
    if (!currentCid) {
      break;
    }

    try {
      const messageFile = await fetchAndDecrypt(currentCid, sessionKey);

      history.unshift({ role: messageFile.role, content: messageFile.content });

      // The parentCID of a MessageFile is the CID of the parent message (whether promptMessageCID or answerMessageCID).
      currentCid = messageFile.parentCID;
    } catch (error) {
      console.error(
        `Failed to reconstruct history at CID ${currentCid}. Stopping history build.`,
        error,
      );

      break;
    }
  }

  return history;
}

// --- AI Model Query Functions ---

/**
 * Query the DeepSeek model via a local Ollama server.
 * @param {Array<object>} conversationHistory - The full, ordered history of the conversation.
 * @returns {Promise<string>} The content of the AI's response.
 */
async function queryDeepSeek(conversationHistory) {
  if (!process.env.OLLAMA_URL) {
    throw new Error("OLLAMA_URL is not set in the environment file.");
  }

  const messages = conversationHistory.map((turn) => ({
    role: turn.role, // Assuming history objects have a 'role' property
    content: turn.content,
  }));

  const res = await fetch(`${process.env.OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-r1:1.5b",
      messages,
      stream: false,
    }),
  });

  if (!res.ok) throw new Error(`Ollama server responded with status: ${res.status}`);
  const json = await res.json();

  return json.message?.content || "Error: Malformed response from DeepSeek.";
}

/**
 * Query the ChainGPT API for a response.
 * @param {Array<object>} conversationHistory - The full, ordered history of the conversation.
 * @param {string} conversationId - The unique on-chain ID for this conversation.
 * @returns {Promise<string>} The content of the AI's response.
 */
async function queryChainGPT(conversationHistory, conversationId) {
  if (!process.env.CHAIN_GPT_API_KEY) {
    throw new Error("CHAIN_GPT_API_KEY is not set in the environment file.");
  }

  const userPrompts = conversationHistory.filter((item) => item.role === "user");
  if (userPrompts.length === 0) {
    throw new Error("Cannot query with an empty prompt list.");
  }

  const question = userPrompts[userPrompts.length - 1].content;

  // Use the on-chain conversationId to generate a deterministic UUID.
  const conversationUUID = uuidv5(conversationId.toString(), NAMESPACE_UUID);

  const res = await fetch("https://api.chaingpt.org/chat/stream", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.CHAIN_GPT_API_KEY}`,
    },
    body: JSON.stringify({
      model: "general_assistant",
      question,
      chatHistory: "on",
      sdkUniqueId: conversationUUID,
      aiTone: "PRE_SET_TONE",
      selectedTone: "FRIENDLY",
    }),
  });

  if (!res.ok) throw new Error(`ChainGPT API responded with status: ${res.status}`);
  const answerText = await res.text();

  return answerText.trim() || "Error: Malformed response from ChainGPT.";
}

/**
 * A dispatcher for querying the AI model specified by the AI_PROVIDER env variable.
 * @param {Array<object>} conversationHistory - The full conversation history with roles.
 * @param {string} conversationId - The on-chain ID for the conversation.
 * @returns {Promise<string>} The content of the AI's response.
 */
async function queryAIModel(conversationHistory, conversationId) {
  const aiProvider = process.env.AI_PROVIDER || "DeepSeek";
  console.log(`Querying AI model via: ${aiProvider}`);

  try {
    switch (aiProvider.toLowerCase()) {
      case "chaingpt":
        return await queryChainGPT(conversationHistory, conversationId);
      case "deepseek":
        return await queryDeepSeek(conversationHistory);
      default:
        console.error(`Unknown AI_PROVIDER: "${aiProvider}". Defaulting to DeepSeek.`);
        return await queryDeepSeek(conversationHistory);
    }
  } catch (err) {
    console.error(`Error querying ${aiProvider}:`, err);
    return `Error: Could not generate a response from the ${aiProvider} service.`;
  }
}

// --- Event Handlers ---

// Helper to check for specific contract errors using Ethers v6 Interface
function isContractError(error, errorName) {
  try {
    // 1. Get the specific error fragment from the ABI
    const errorFragment = contract.interface.getError(errorName);
    if (!errorFragment) return false;

    // 2. Check if the error data matches the selector
    const selector = errorFragment.selector;

    // Ethers v6 puts the raw revert data in different places depending on the transport
    const errorData = error.data || error.info?.error?.data || error.transaction?.data;

    if (errorData && errorData.includes(selector)) {
      return true;
    }

    // Fallback: sometimes the message contains the hex string directly
    if (error.message && error.message.includes(selector)) {
      return true;
    }

    return false;
  } catch (e) {
    return false;
  }
}

async function handlePrompt(
  user,
  conversationId,
  promptMessageId,
  answerMessageId,
  payload, // This is `bytes` on EVM, `string` on Sapphire
  roflEncryptedKey, // This is the top-level argument for EVM
  event,
) {
  console.log(
    `[EVENT] Processing PromptSubmitted for convId: ${conversationId} in block ${event.blockNumber}`,
  );

  // --- Idempotency Check ---
  // Check if this specific answer ID has already been finalized on-chain.
  // This prevents wasting AI/Arweave credits on restarts or re-orgs.
  try {
    const isAlreadyDone = await contract.isJobFinalized(answerMessageId);
    if (isAlreadyDone) {
      console.log(
        `  ℹ️ Skipped: Prompt ${promptMessageId} is already answered on-chain or cancelled.`,
      );
      return;
    }
  } catch (err) {
    console.warn(
      `  ⚠️ Could not check isJobFinalized status (RPC error?), proceeding anyway.`,
      err.message,
    );
  }

  try {
    const sessionKey = await getSessionKey(payload, roflEncryptedKey, conversationId.toString());

    const decryptedData = isSapphire
      ? payload
      : decryptSymmetrically(ethers.toUtf8String(payload), sessionKey);

    const clientPayload = validatePayload(decryptedData, "PromptSubmitted");

    const { promptText, isNewConversation, previousMessageId, previousMessageCID } = clientPayload;

    const history = await reconstructHistory(previousMessageCID, sessionKey);
    history.push({ role: "user", content: promptText });

    const answerText = await queryAIModel(history, conversationId.toString());

    // Check again before paying for storage
    try {
      const isDoneNow = await contract.isJobFinalized(answerMessageId);
      if (isDoneNow) {
        console.log(`  ℹ️ Skipped: Prompt ${promptMessageId} was cancelled during AI processing.`);
        return;
      }
    } catch (err) {
      console.warn(
        `  ⚠️ Could not check isJobFinalized status (RPC error?), proceeding anyway.`,
        err.message,
      );
    }

    const now = Date.now();
    let cidBundle = {};

    if (isNewConversation) {
      const { chainId } = await provider.getNetwork();
      const keyFileTags = [
        { name: "Content-Type", value: "application/rofl-key" },
        { name: "SenseAI-Key-For-Conversation", value: `${chainId}-${conversationId}` },
      ];
      // For Sapphire, the sessionKey is received raw in the payload.
      // We must now encrypt it for persistent storage.
      let keyToStore;
      if (isSapphire) {
        const AI_AGENT_PUBLIC_KEY = ethCrypto.publicKeyByPrivateKey(AI_AGENT_PRIVATE_KEY);

        const encryptedKeyObject = await ethCrypto.encryptWithPublicKey(
          AI_AGENT_PUBLIC_KEY,
          sessionKey, // Encrypt the raw session key
        );
        keyToStore = ethCrypto.cipher.stringify(encryptedKeyObject);
      } else {
        keyToStore = ethers.toUtf8String(roflEncryptedKey); // For EVM, we already have it.
      }

      // Stringify the eth-crypto object before saving
      await uploadData(Buffer.from(keyToStore), keyFileTags);

      const [conversationCID, metadataCID, promptMessageCID, searchDeltaCID] = await Promise.all([
        encryptAndUpload(
          createConversationFile({
            id: conversationId.toString(),
            ownerAddress: user,
            createdAt: now,
          }),
          sessionKey,
        ),
        encryptAndUpload(
          createConversationMetadataFile({
            title: promptText.substring(0, 40),
            isDeleted: false,
            lastUpdatedAt: now,
          }),
          sessionKey,
        ),
        encryptAndUpload(
          createMessageFile({
            id: promptMessageId.toString(),
            conversationId: conversationId.toString(),
            parentId: previousMessageId || null,
            parentCID: previousMessageCID || null,
            createdAt: now,
            role: "user",
            content: promptText,
          }),
          sessionKey,
        ),
        encryptAndUpload(
          createSearchIndexDeltaFile({
            conversationId: conversationId.toString(),
            messageId: promptMessageId.toString(),
            userMessageContent: promptText,
          }),
          sessionKey,
        ),
      ]);

      const answerMessageCID = await encryptAndUpload(
        createMessageFile({
          id: answerMessageId.toString(),
          conversationId: conversationId.toString(),
          parentId: promptMessageId.toString(),
          parentCID: promptMessageCID,
          createdAt: now + 1,
          role: "assistant",
          content: answerText,
        }),
        sessionKey,
      );
      cidBundle = {
        conversationCID,
        metadataCID,
        promptMessageCID,
        answerMessageCID,
        searchDeltaCID,
      };
    } else {
      const [promptMessageCID, searchDeltaCID] = await Promise.all([
        encryptAndUpload(
          createMessageFile({
            id: promptMessageId.toString(),
            conversationId: conversationId.toString(),
            parentId: previousMessageId || null,
            parentCID: previousMessageCID || null,
            createdAt: now,
            role: "user",
            content: promptText,
          }),
          sessionKey,
        ),
        encryptAndUpload(
          createSearchIndexDeltaFile({
            conversationId: conversationId.toString(),
            messageId: promptMessageId.toString(),
            userMessageContent: promptText,
          }),
          sessionKey,
        ),
      ]);
      const answerMessageCID = await encryptAndUpload(
        createMessageFile({
          id: answerMessageId.toString(),
          conversationId: conversationId.toString(),
          parentId: promptMessageId.toString(),
          parentCID: promptMessageCID,
          createdAt: now + 1,
          role: "assistant",
          content: answerText,
        }),
        sessionKey,
      );
      cidBundle = {
        conversationCID: "",
        metadataCID: "",
        promptMessageCID,
        answerMessageCID,
        searchDeltaCID,
      };
    }

    // We lock the wallet to ensure Nonces are used sequentially.
    await txMutex.runExclusive(async () => {
      // Double-check finalization on-chain right before sending
      // This catches race conditions where user cancelled while we were uploading
      const isFinalized = await contract.isJobFinalized(answerMessageId);
      if (isFinalized) {
        console.log(
          `  ℹ️ Skipped (in mutex): Prompt ${promptMessageId} finalized or cancelled just now.`,
        );
        return;
      }

      console.log(`  Submitting transaction for prompt ${promptMessageId}...`);
      const tx = await contract.submitAnswer(promptMessageId, answerMessageId, cidBundle);
      const receipt = await tx.wait();
      console.log(
        `  ✅ Success! Answer for prompt ${promptMessageId} submitted. Tx: ${receipt.hash}`,
      );
    });
  } catch (error) {
    if (isContractError(error, "JobAlreadyFinalized")) {
      console.log(
        `  ℹ️ Skipped: Transaction reverted with 'JobAlreadyFinalized'. The user likely cancelled this prompt.`,
      );

      return; // Exit gracefully
    }

    // --- Fallback State Check ---
    // If the transaction failed, check if the job is already finalized on-chain.
    // This handles cases where Ethers v6 or the RPC doesn't return the revert reason clearly.
    try {
      const isFinalized = await contract.isJobFinalized(answerMessageId);
      if (isFinalized) {
        console.log(
          `  ℹ️ Transaction failed but job ${answerMessageId} is finalized on-chain. Treating as cancelled/completed.`,
        );

        return; // Exit gracefully
      }
    } catch (checkErr) {
      console.warn("  ⚠️ Could not verify job finalization status after error.");
    }

    console.error(`Error in handlePrompt for convId ${conversationId}:`, error);

    throw error; // Propagate error to be caught by handleAndRecord
  }
}

async function handleRegeneration(
  user,
  conversationId,
  promptMessageId,
  originalAnswerMessageId,
  answerMessageId,
  payload,
  roflEncryptedKey,
  event,
) {
  console.log(
    `[EVENT] Processing RegenerationRequested for promptId: ${promptMessageId} in block ${event.blockNumber}`,
  );

  // --- Idempotency Check ---
  // Check if this specific answer ID has already been finalized on-chain.
  // This prevents wasting AI/Arweave credits on restarts or re-orgs.
  try {
    const isAlreadyDone = await contract.isJobFinalized(answerMessageId);
    if (isAlreadyDone) {
      console.log(`  ℹ️ Skipped: Regeneration ${answerMessageId} is already finalized on-chain.`);
      return;
    }
  } catch (err) {
    console.warn(`  ⚠️ Could not check isJobFinalized status, proceeding anyway.`);
  }

  try {
    const sessionKey = await getSessionKey(payload, roflEncryptedKey, conversationId.toString());

    const decryptedData = isSapphire
      ? payload
      : decryptSymmetrically(ethers.toUtf8String(payload), sessionKey);

    const clientPayload = validatePayload(decryptedData, "RegenerationRequested");

    const { instructions, promptMessageCID, originalAnswerMessageCID } = clientPayload;

    const history = await reconstructHistory(originalAnswerMessageCID, sessionKey);
    if (instructions) {
      history.push({
        role: "user",
        content: `Please regenerate your previous response. Make it ${instructions}.`,
      });
    }

    const answerText = await queryAIModel(history, conversationId.toString());

    // Check again before paying for storage
    try {
      const isDoneNow = await contract.isJobFinalized(answerMessageId);
      if (isDoneNow) {
        console.log(`  ℹ️ Skipped: Prompt ${promptMessageId} was cancelled during AI processing.`);
        return;
      }
    } catch (err) {
      console.warn(
        `  ⚠️ Could not check isJobFinalized status (RPC error?), proceeding anyway.`,
        err.message,
      );
    }

    const now = Date.now();

    const answerMessageCID = await encryptAndUpload(
      createMessageFile({
        id: answerMessageId.toString(),
        conversationId: conversationId.toString(),
        parentId: promptMessageId.toString(),
        parentCID: promptMessageCID ? promptMessageCID.toString() : "",
        createdAt: now,
        role: "assistant",
        content: answerText,
      }),
      sessionKey,
    );

    const cidBundle = {
      conversationCID: "",
      metadataCID: "",
      promptMessageCID: "",
      answerMessageCID,
      searchDeltaCID: "",
    };

    // We lock the wallet to ensure Nonces are used sequentially.
    await txMutex.runExclusive(async () => {
      // Double-check finalization on-chain right before sending
      // This catches race conditions where user cancelled while we were uploading
      const isFinalized = await contract.isJobFinalized(answerMessageId);
      if (isFinalized) {
        console.log(
          `  ℹ️ Skipped (in mutex): Prompt ${promptMessageId} finalized or cancelled just now.`,
        );
        return;
      }

      console.log(`  Submitting transaction for prompt ${promptMessageId}...`);
      const tx = await contract.submitAnswer(promptMessageId, answerMessageId, cidBundle);
      const receipt = await tx.wait();
      console.log(
        `  ✅ Success! Regeneration for prompt ${promptMessageId} submitted. Tx: ${receipt.hash}`,
      );
    });
  } catch (error) {
    if (isContractError(error, "JobAlreadyFinalized")) {
      console.log(
        `  ℹ️ Skipped: Transaction reverted with 'JobAlreadyFinalized'. The user likely cancelled this prompt.`,
      );

      return; // Exit gracefully
    }

    // --- Fallback State Check ---
    try {
      const isFinalized = await contract.isJobFinalized(answerMessageId);
      if (isFinalized) {
        console.log(
          `  ℹ️ Transaction failed but job ${answerMessageId} is finalized on-chain. Treating as cancelled/completed.`,
        );

        return; // Exit gracefully
      }
    } catch (checkErr) {
      console.warn("  ⚠️ Could not verify job finalization status after error.");
    }

    console.error(`Error in handleRegeneration for promptId ${promptMessageId}:`, error);
    throw error;
  }
}

async function handleBranch(
  user,
  originalConversationId,
  branchPointMessageId,
  newConversationId,
  payload,
  roflEncryptedKey,
  event,
) {
  console.log(
    `[EVENT] Processing BranchRequested for original convId: ${originalConversationId} in block ${event.blockNumber}`,
  );

  try {
    const sessionKey = await getSessionKey(
      payload,
      roflEncryptedKey,
      originalConversationId.toString(),
    );

    const decryptedData = isSapphire
      ? payload
      : decryptSymmetrically(ethers.toUtf8String(payload), sessionKey);

    const clientPayload = validatePayload(decryptedData, "BranchRequested");

    const { originalTitle } = clientPayload;
    const now = Date.now();

    const newTitle = `Branch of ${originalTitle}`;

    const { chainId } = await provider.getNetwork();
    const newKeyFileTags = [
      { name: "Content-Type", value: "application/rofl-key" },
      { name: "SenseAI-Key-For-Conversation", value: `${chainId}-${newConversationId}` },
    ];
    // For Sapphire, the sessionKey is received raw in the payload.
    // We must now encrypt it for persistent storage.
    let keyToStore;
    if (isSapphire) {
      const AI_AGENT_PUBLIC_KEY = ethCrypto.publicKeyByPrivateKey(AI_AGENT_PRIVATE_KEY);

      const encryptedKeyObject = await ethCrypto.encryptWithPublicKey(
        AI_AGENT_PUBLIC_KEY,
        sessionKey, // Encrypt the raw session key
      );
      keyToStore = ethCrypto.cipher.stringify(encryptedKeyObject);
    } else {
      keyToStore = ethers.toUtf8String(roflEncryptedKey); // For EVM, we already have it.
    }

    // Stringify the eth-crypto object before saving
    await uploadData(Buffer.from(keyToStore), newKeyFileTags);

    const [conversationCID, metadataCID] = await Promise.all([
      encryptAndUpload(
        createConversationFile({
          id: newConversationId.toString(),
          ownerAddress: user,
          createdAt: now,
          branchedFromConversationId: originalConversationId.toString(),
          branchedAtMessageId: branchPointMessageId.toString(),
        }),
        sessionKey,
      ),
      encryptAndUpload(
        createConversationMetadataFile({ title: newTitle, isDeleted: false, lastUpdatedAt: now }),
        sessionKey,
      ),
    ]);

    await txMutex.runExclusive(async () => {
      console.log(`  Submitting branch ${newConversationId}...`);
      const tx = await contract.submitBranch(
        user,
        originalConversationId,
        branchPointMessageId,
        newConversationId,
        conversationCID,
        metadataCID,
      );
      const receipt = await tx.wait();
      console.log(
        `  ✅ Success! Branch submitted. New convId: ${newConversationId}. Tx: ${receipt.hash}`,
      );
    });
  } catch (error) {
    console.error(`Error in handleBranch for convId ${originalConversationId}:`, error);
    throw error;
  }
}

async function handleMetadataUpdate(user, conversationId, payload, roflEncryptedKey, event) {
  console.log(
    `[EVENT] Processing MetadataUpdateRequested for convId: ${conversationId} in block ${event.blockNumber}`,
  );
  try {
    const sessionKey = await getSessionKey(payload, roflEncryptedKey, conversationId.toString());

    const decryptedData = isSapphire
      ? payload
      : decryptSymmetrically(ethers.toUtf8String(payload), sessionKey);

    const clientPayload = validatePayload(decryptedData, "MetadataUpdateRequested");

    const { title, isDeleted } = clientPayload; // Explicitly destructured for clarity

    const now = Date.now();

    const metadataCID = await encryptAndUpload(
      createConversationMetadataFile({
        title,
        isDeleted,
        lastUpdatedAt: now,
      }),
      sessionKey,
    );

    await txMutex.runExclusive(async () => {
      console.log(`  Submitting metadata update for ${conversationId}...`);
      const tx = await contract.submitConversationMetadata(conversationId, metadataCID);
      const receipt = await tx.wait();
      console.log(
        `  ✅ Success! Metadata updated for conversation ${conversationId}. Tx: ${receipt.hash}`,
      );
    });
  } catch (error) {
    console.error(`Error in handleMetadataUpdate for convId ${conversationId}:`, error);

    throw error;
  }
}

// --- Main Service Logic ---

/**
 * Ensures the oracle's address is correctly registered in the smart contract.
 * For Sapphire, this can be a TEE-signed transaction to securely update the key.
 * For EVM, this is a critical health check, as the function is owner-only.
 */
async function setOracleAddress() {
  const onChainOracle = await contract.oracle();
  if (onChainOracle.toLowerCase() === signer.address.toLowerCase()) {
    console.log(`Oracle address is correctly set: ${signer.address}`);
    return;
  }
  console.log(`Updating on-chain oracle address from ${onChainOracle} to ${signer.address}`);

  try {
    if (isSapphire) {
      const isLocalnet = NETWORK_NAME === "sapphire-localnet";

      if (isLocalnet) {
        // On localnet, we can send a direct transaction as we control the TEE simulation.
        const tx = await contract.setOracle(signer.address, { gasLimit: 1000000 });
        await tx.wait();
      } else {
        // On testnet/mainnet, the transaction must be signed by the ROFL TEE.
        console.log("Populating setOracle transaction...");
        const txUnsigned = await contract.setOracle.populateTransaction(signer.address);

        const txParams = {
          to: AI_AGENT_CONTRACT_ADDRESS,
          gas: 2000000, // setOracle is a simple transaction, a fixed high limit is safe
          value: 0,
          data: txUnsigned.data,
        };

        const txHash = await submitTx(txParams);
        console.log(`setOracle transaction submitted: ${txHash}`);
      }

      console.log(`Successfully updated oracle address to ${signer.address}`);
    } else {
      // For EVM, this is a health check. The contract's owner must set the address.
      // This oracle process does not have the permissions.
      const errorMessage = `FATAL: Oracle address mismatch on EVM chain. On-chain oracle is ${onChainOracle}, but this oracle's key is for ${signer.address}. The contract owner must call setOracle().`;

      await sendAlert("CRITICAL: Oracle Address Mismatch", errorMessage);

      throw new Error(errorMessage);
    }
  } catch (err) {
    const errorMessage = `FATAL: Failed to update oracle address. The on-chain oracle is ${onChainOracle}, but this oracle's address is ${signer.address}. Error: ${err.message}`;

    await sendAlert("CRITICAL: Oracle Setup Failed", errorMessage);

    throw new Error(errorMessage); // Halt the oracle if it can't verify its identity.
  }
}

/**
 * A wrapper for event handlers that distinguishes between retryable and fatal errors.
 * Retryable errors are saved to a queue for later processing.
 * @param {string} eventName - The name of the event being processed.
 * @param {Function} handler - The async event handler function to execute.
 * @param  {...any} args - The arguments passed by the ethers.js event listener.
 */
async function handleAndRecord(eventName, handler, ...args) {
  const event = args[args.length - 1];

  try {
    const eventTimestamp = (await event.getBlock()).timestamp;

    const nowTimestamp = Math.floor(Date.now() / 1000);
    const lagInSeconds = nowTimestamp - eventTimestamp;
    const lagThreshold = 300; // 5 minutes

    if (lagInSeconds > lagThreshold) {
      await sendAlert(
        "High Oracle Processing Lag Detected",
        `The oracle is currently processing events that are over ${Math.floor(lagInSeconds / 60)} minutes old. The system is under heavy load and may not be keeping up. Consider deploying additional oracle instances to handle the demand.`,
      );
    }

    await handler(...args);
    await fs.writeFile(STATE_FILE_PATH, JSON.stringify({ lastProcessedBlock: event.blockNumber }));
  } catch (error) {
    // 1. MALICIOUS / BAD INPUT ERRORS (Drop silently or log warning, DO NOT RETRY)
    // "Validation Failed" covers all schema mismatches from payloadValidator.js
    if (
      error.message.includes("Validation Failed") ||
      error.message.includes("Invalid encrypted data format") ||
      error.message.includes("Unexpected token") // JSON parse error
    ) {
      console.warn(
        `[Security] Dropping malformed/invalid payload for ${eventName} in block ${event.blockNumber}. Error: ${error.message}`,
      );
      // We do NOT throw, we do NOT alert, we do NOT queue for retry.
      // We update state and move on.
      await fs.writeFile(
        STATE_FILE_PATH,
        JSON.stringify({ lastProcessedBlock: event.blockNumber }),
      );

      return;
    }

    // 2. RETRYABLE ERRORS (Network, API limits)
    // For now, we'll treat most I/O errors (like from Irys) as retryable.
    // We can add more specific checks here later (e.g., based on error codes).
    const isRetryable =
      error.message.includes("Irys") ||
      error.message.includes("fetch") ||
      error.message.includes("insufficient funds") ||
      error.message.includes("Autonomys") ||
      error.message.includes("Bad Gateway") ||
      error.message.includes("502") ||
      error.message.includes("503") ||
      error.message.includes("ETIMEDOUT");

    if (isRetryable) {
      console.warn(
        `Encountered a retryable error for ${eventName}. Adding to retry queue. Error: ${error.message}`,
      );

      let failedJobs = [];
      try {
        const fileContent = await fs.readFile(FAILED_JOBS_FILE_PATH, "utf-8");
        const parsed = JSON.parse(fileContent);

        // Ensure what we read is actually an array. If it's {}, treat as [].
        if (Array.isArray(parsed)) {
          failedJobs = parsed;
        }
      } catch (e) {
        /* File doesn't exist or is corrupt, start with empty array */
      }

      failedJobs.push({
        eventName,
        event: {
          args: event.args,
          blockNumber: event.blockNumber,
          transactionHash: event.transactionHash,
        },
        retryCount: 0,
        nextAttemptAt: Date.now() + BASE_RETRY_DELAY_MS,
      });

      await fs.writeFile(FAILED_JOBS_FILE_PATH, JSON.stringify(failedJobs, null, 2));

      // Still save the block progress, because we have successfully QUEUED the failed job.
      // This prevents it from being picked up again by the catch-up scanner.
      await fs.writeFile(
        STATE_FILE_PATH,
        JSON.stringify({ lastProcessedBlock: event.blockNumber }),
      );
    } else {
      const alertMessage = `Encountered a FATAL, non-retryable error for event '${eventName}' in block ${event.blockNumber}. Manual intervention required. Error: ${error.message}`;
      console.error(alertMessage, error);

      await sendAlert("CRITICAL: Oracle Fatal Error", alertMessage);
    }
  }
}

/**
 * Periodically checks for and retries failed jobs from a persistent queue file.
 * Uses exponential backoff to space out retries.
 */
async function retryFailedJobs() {
  let failedJobs = [];
  try {
    const fileContent = await fs.readFile(FAILED_JOBS_FILE_PATH, "utf-8");
    const parsed = JSON.parse(fileContent);
    // Ensure failedJobs is iterable (Array). If it's an object {}, ignore it.
    if (Array.isArray(parsed)) {
      failedJobs = parsed;
    } else {
      // If the file contains {}, we treat it as empty.
      // We don't write back immediately to avoid disk thrashing,
      // but the next write will correct the file format.
      failedJobs = [];
    }
  } catch (e) {
    return; // No failed jobs file, nothing to do.
  }

  if (failedJobs.length === 0) return;

  console.log(`[Retry] Checking ${failedJobs.length} failed job(s)...`);
  const remainingJobs = [];
  let processed = false;
  for (const job of failedJobs) {
    if (Date.now() >= job.nextAttemptAt) {
      // An attempt is being made, so we know the file will need to be updated
      processed = true;

      console.log(
        `[Retry] Retrying job for event: ${job.eventName} from block ${job.event.blockNumber}`,
      );
      try {
        // Re-fetch the full event object to pass to the handler
        const receipt = await provider.getTransactionReceipt(job.event.transactionHash);
        if (!receipt) {
          throw new Error(
            `Could not find transaction receipt for hash ${job.event.transactionHash}`,
          );
        }

        const fullEvent = receipt.logs
          .map((log) => {
            try {
              if (log.address.toLowerCase() === contract.target.toLowerCase()) {
                // Return a combined object that includes the transactionHash for the find filter
                const parsed = contract.interface.parseLog(log);
                if (parsed) {
                  return { ...parsed, transactionHash: log.transactionHash };
                }
              }
              return null;
            } catch (e) {
              return null;
            }
          })
          .find(
            (parsedLog) =>
              parsedLog &&
              parsedLog.name === job.eventName &&
              parsedLog.transactionHash === job.event.transactionHash,
          );

        if (!fullEvent) {
          throw new Error(`Could not re-parse event '${job.eventName}' from transaction receipt.`);
        }

        const eventWithBlock = {
          ...fullEvent,
          blockNumber: receipt.blockNumber,
          getBlock: () => provider.getBlock(receipt.blockNumber),
        };

        // Add the retry to the concurrency queue as well
        await queue.add(async () => {
          switch (job.eventName) {
            case "PromptSubmitted":
              await handlePrompt(...eventWithBlock.args, eventWithBlock);

              break;
            case "RegenerationRequested":
              await handleRegeneration(...eventWithBlock.args, eventWithBlock);

              break;
            case "BranchRequested":
              await handleBranch(...eventWithBlock.args, eventWithBlock);

              break;
            case "MetadataUpdateRequested":
              await handleMetadataUpdate(...eventWithBlock.args, eventWithBlock);

              break;
          }
        });
        console.log(`[Retry] Successfully re-queued job.`);
        // On success, we DON'T add it to remainingJobs, so it's removed from the queue.
      } catch (error) {
        console.error(
          `[Retry] Attempt #${job.retryCount + 1} failed for event ${job.eventName}. Error: ${error.message}`,
        );

        job.retryCount += 1;
        if (job.retryCount >= MAX_RETRIES) {
          await sendAlert(
            "CRITICAL: Job Failed Permanently",
            `A job for event ${job.eventName} from block ${job.event.blockNumber} has failed all ${MAX_RETRIES} retries and has been dropped. Manual intervention required. Final error: ${error.message}`,
          );
          // On permanent failure, we also DON'T add it to remainingJobs.
        } else {
          const delay = BASE_RETRY_DELAY_MS * Math.pow(2, job.retryCount);
          job.nextAttemptAt = Date.now() + delay;
          remainingJobs.push(job); // Add it back to the queue for the next attempt
        }
      }
    } else {
      remainingJobs.push(job); // Not time to retry yet, keep it in the queue
    }
  }

  // If we processed any jobs, this means the queue has changed (either by removing a job
  // or by updating its retry count), so we must write the new state back to the file.
  if (processed) {
    await fs.writeFile(FAILED_JOBS_FILE_PATH, JSON.stringify(remainingJobs, null, 2));
  }
}

/**
 * Scans for and processes any events that were missed while the oracle was offline.
 * Uses batching to respect RPC limits on block ranges.
 * @param {number} fromBlock - The block number to start scanning from.
 * @param {number} toBlock - The latest block number to scan up to.
 */
async function processPastEvents(fromBlock, toBlock) {
  if (fromBlock > toBlock) {
    return;
  }
  console.log(`Catching up on missed events from block ${fromBlock} to ${toBlock}...`);

  // BATCHING CONFIGURATION
  // Use a very safe, small batch size to respect restrictive RPCs (QuickNode Free is 5 blocks).
  const BATCH_SIZE = parseInt(process.env.EVENT_BATCH_SIZE) || 2000;

  let currentStart = fromBlock;

  while (currentStart <= toBlock) {
    const currentEnd = Math.min(currentStart + BATCH_SIZE - 1, toBlock);

    console.log(`  -> Scanning batch: ${currentStart} to ${currentEnd}`);

    try {
      const eventPromises = [
        contract.queryFilter(contract.filters.PromptSubmitted(), currentStart, currentEnd),
        contract.queryFilter(contract.filters.RegenerationRequested(), currentStart, currentEnd),
        contract.queryFilter(contract.filters.BranchRequested(), currentStart, currentEnd),
        contract.queryFilter(contract.filters.MetadataUpdateRequested(), currentStart, currentEnd),
      ];

      const allEventsNested = await Promise.all(eventPromises);

      // Sort events strictly by their on-chain order to ensure correct processing.
      const allEvents = allEventsNested.flat();
      allEvents.sort((a, b) => {
        if (a.blockNumber !== b.blockNumber) {
          return a.blockNumber - b.blockNumber;
        }

        return a.transactionIndex - b.transactionIndex;
      });

      if (allEvents.length > 0) {
        console.log(`     Found ${allEvents.length} events in batch. Queueing...`);

        // Map all events to queue tasks
        const tasks = allEvents.map((event) => {
          return queue.add(async () => {
            // Use a switch on the event name to call the correct handler
            switch (event.eventName) {
              case "PromptSubmitted":
                await handleAndRecord("PromptSubmitted", handlePrompt, ...event.args, event);

                break;
              case "RegenerationRequested":
                await handleAndRecord(
                  "RegenerationRequested",
                  handleRegeneration,
                  ...event.args,
                  event,
                );

                break;
              case "BranchRequested":
                await handleAndRecord("BranchRequested", handleBranch, ...event.args, event);

                break;
              case "MetadataUpdateRequested":
                await handleAndRecord(
                  "MetadataUpdateRequested",
                  handleMetadataUpdate,
                  ...event.args,
                  event,
                );

                break;
              default:
                console.warn(`Unknown event encountered during catch-up: ${event.eventName}`);
            }
          });
        });

        // Wait for ALL tasks in this batch to complete before updating state.
        // This ensures if the process crashes, we re-process this batch rather than skipping it.
        await Promise.all(tasks);
      }

      // Update checkpoint after every successful batch to avoid re-processing
      await fs.writeFile(STATE_FILE_PATH, JSON.stringify({ lastProcessedBlock: currentEnd }));

      // Move window forward
      currentStart = currentEnd + 1;

      // Optional: Small delay to be nice to the RPC
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (error) {
      const alertMessage = `Failed during historical event catch-up process between blocks ${currentStart}-${currentEnd}. The oracle may need intervention. Error: ${error.message}`;
      console.error(alertMessage, error);

      // Critical failure in catch-up stops the oracle startup
      await sendAlert("Oracle Catch-up Failed", alertMessage);

      throw error; // Throw to stop the oracle from starting in a potentially broken state.
    }
  }

  console.log("Catch-up complete.");
}

/**
 * Continuously polls the blockchain for new events in specific block ranges.
 * Updates the state file after every batch to ensure progress is saved even during periods of inactivity.
 * @param {number} startBlock - The block to start polling from.
 */
async function pollEvents(startBlock) {
  console.log(`✅ Oracle is running and listening for new events from block ${startBlock}.`);

  // Use the same batch size config as catch-up to respect RPC limits
  const BATCH_SIZE = parseInt(process.env.EVENT_BATCH_SIZE) || 2000;

  const filters = [
    contract.filters.PromptSubmitted(),
    contract.filters.RegenerationRequested(),
    contract.filters.BranchRequested(),
    contract.filters.MetadataUpdateRequested(),
  ];

  let currentBlock = startBlock;
  while (true) {
    try {
      const latestBlock = await provider.getBlockNumber();

      // Only proceed if there are new blocks to check
      if (latestBlock > currentBlock) {
        // Determine the end of the batch (don't exceed RPC limit or latest block)
        const toBlock = Math.min(currentBlock + BATCH_SIZE, latestBlock);
        const fromQueryBlock = currentBlock + 1; // For logging clarity

        // Query all filters in parallel for the specific range
        const promises = filters.map((filter) =>
          contract.queryFilter(filter, fromQueryBlock, toBlock),
        );

        const results = await Promise.all(promises);
        const allEvents = results.flat();

        // Sort by block and transaction index to process in order
        allEvents.sort((a, b) => {
          if (a.blockNumber !== b.blockNumber) {
            return a.blockNumber - b.blockNumber;
          }

          return a.index - b.index;
        });

        // Process any found events
        const tasks = allEvents.map((event) => {
          return queue.add(async () => {
            switch (event.eventName) {
              case "PromptSubmitted":
                await handleAndRecord("PromptSubmitted", handlePrompt, ...event.args, event);

                break;
              case "RegenerationRequested":
                await handleAndRecord(
                  "RegenerationRequested",
                  handleRegeneration,
                  ...event.args,
                  event,
                );

                break;
              case "BranchRequested":
                await handleAndRecord("BranchRequested", handleBranch, ...event.args, event);

                break;
              case "MetadataUpdateRequested":
                await handleAndRecord(
                  "MetadataUpdateRequested",
                  handleMetadataUpdate,
                  ...event.args,
                  event,
                );

                break;
            }
          });
        });

        // Wait for the queue to accept and process the batch
        await Promise.all(tasks);

        // Update the state file to the block we just finished checking (toBlock).
        // This happens even if allEvents.length is 0.
        currentBlock = toBlock;
        await fs.writeFile(STATE_FILE_PATH, JSON.stringify({ lastProcessedBlock: currentBlock }));

        // This confirms the oracle is moving forward and saving state.
        if (allEvents.length > 0) {
          console.log(
            `  ✓ Polled ${fromQueryBlock} to ${currentBlock} -> Processed ${allEvents.length} events.`,
          );
        } else {
          console.log(`  ✓ Polled ${fromQueryBlock} to ${currentBlock}`);
        }

        // If we are lagging far behind (e.g. more batches needed), don't wait. Loop immediately.
        if (toBlock < latestBlock) {
          // Optional: Small delay to be nice to the RPC
          await new Promise((resolve) => setTimeout(resolve, 500));

          continue;
        }
      }
    } catch (error) {
      console.error(`Error in polling loop: ${error.message}`);
      // Wait a bit longer before retrying if RPC is erroring
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    // Wait before next poll (Base block time is ~2s, so 2s-4s is healthy)
    await new Promise((resolve) => setTimeout(resolve, 4000));
  }
}

/**
 * The entry point for the oracle service.
 */
async function start() {
  console.log("--- INITIALIZING ORACLE SERVICE ---");

  // Initialize the connection to the decentralised storage provider.
  await initializeStorage();

  // Ensure the on-chain oracle address is correctly set to this wallet.
  await setOracleAddress();

  // Process any failed jobs from previous runs before catching up on past events.
  await retryFailedJobs();

  // Catch up on any events that were missed while the oracle was offline.
  let state;
  try {
    state = JSON.parse(await fs.readFile(STATE_FILE_PATH, "utf-8"));
  } catch (e) {
    // If the state file doesn't exist or is invalid, create a default state.
    state = { lastProcessedBlock: 0 };
    console.log("No valid state file found. Will start processing from a recent block.");
  }

  const latestBlock = await provider.getBlockNumber();
  // On a fresh start, look back ~1 hour (1800 blocks on Base).
  // Otherwise, start from the next block after the last processed one.
  const lookback = 1800;
  const fromBlock =
    state.lastProcessedBlock === 0
      ? Math.max(0, latestBlock - lookback)
      : state.lastProcessedBlock + 1;

  // 1. Catch Up Phase
  // Note: processPastEvents will update the state file as it goes.
  await processPastEvents(fromBlock, latestBlock);

  // Ensure state is synced to latest before starting poll (redundant safety save)
  await fs.writeFile(STATE_FILE_PATH, JSON.stringify({ lastProcessedBlock: latestBlock }));

  // Start background retry mechanism
  setInterval(retryFailedJobs, RETRY_INTERVAL_MS);

  // 2. Listening Phase
  await pollEvents(latestBlock);
}

module.exports = {
  start,
  initForTest,
  // Expose internal functions for testing purposes
  handlePrompt,
  handleRegeneration,
  handleBranch,
  handleMetadataUpdate,
  reconstructHistory,
  getSessionKey,
  encryptSymmetrically,
  decryptSymmetrically,
  handleAndRecord,
  setOracleAddress,
  processPastEvents,
  retryFailedJobs,
};
