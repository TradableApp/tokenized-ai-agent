const dotenv = require("dotenv");
const ethCrypto = require("eth-crypto");
const { ethers } = require("ethers");
const path = require("path");
const fs = require("fs/promises");
const { v5: uuidv5 } = require("uuid");

const { initializeOracle } = require("./contractUtility");
const { initializeIrys } = require("./arweaveUtility");
const formatters = require("./formatters");
const { submitTx } = require("./roflUtility");
const { sendAlert } = require("./alerting");

// --- Configuration & Initialization ---

// Load the specific environment file first for precedence.
if (process.env.ENV_FILE) {
  dotenv.config({ path: process.env.ENV_FILE });
}
// Load the base .env.oracle file to fill in any missing non-secret variables.
dotenv.config({ path: path.resolve(__dirname, "../.env.oracle") });

const NAMESPACE_UUID = "f7e8a6a0-8d5d-4f7d-8f8a-8c7d6e5f4a3b";
const NETWORK_NAME = process.env.NETWORK_NAME;
const AI_AGENT_PRIVATE_KEY = process.env.PRIVATE_KEY;
const AI_AGENT_CONTRACT_ADDRESS = process.env.AI_AGENT_CONTRACT_ADDRESS;
const STATE_FILE_PATH = path.resolve(__dirname, "../oracle-state.json");
const FAILED_JOBS_FILE_PATH = path.resolve(__dirname, "../failed-jobs.json");
const RETRY_INTERVAL_MS = 60 * 1000; // Check for failed jobs every 60 seconds
const MAX_RETRIES = 10;
const BASE_RETRY_DELAY_MS = 30 * 1000; // Start with a 30-second delay

// This single function from our utility handles all environment-specific setup.
const { provider, signer, contract, isSapphire } = initializeOracle(
  NETWORK_NAME,
  AI_AGENT_PRIVATE_KEY,
  AI_AGENT_CONTRACT_ADDRESS,
);

console.log(`--- AI AGENT ORACLE STARTING ON: ${NETWORK_NAME.toUpperCase()} ---`);
console.log(`Oracle signer address: ${signer.address}`);
console.log(`Contract address: ${contract.target}`);
console.log(
  `Operating in ${isSapphire ? "Sapphire (confidential)" : "Public EVM (encrypted)"} mode.`,
);

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

// --- TEE & Cryptography Utilities ---

/**
 * [EVM ONLY] Removes the '0x' prefix from a hex string, which is required by eth-crypto.
 * @param {string} hexString - The hex string, which may or may not have a '0x' prefix.
 * @returns {string} The raw hex string without the '0x' prefix.
 */
function strip0xPrefix(hexString) {
  return hexString.startsWith("0x") ? hexString.slice(2) : hexString;
}

/**
 * Decrypts an encrypted payload from the contract.
 * For Sapphire, it simply parses the plaintext string payload.
 * For EVM, it performs the full cryptographic decryption.
 * @param {string} payload - The payload from the event (`string` for Sapphire, `bytes` for EVM).
 * @param {string} roflEncryptedKey - The encrypted session key (EVM only).
 * @returns {Promise<{payload: object | string, sessionKey: string | null}>} The decrypted object/string, and the sessionKey if one was used.
 */
async function decryptPayload(payload, roflEncryptedKey) {
  if (isSapphire) {
    // On Sapphire, the payload is already plaintext JSON.
    return { payload: JSON.parse(payload), sessionKey: null };
  }

  // On EVM, perform decryption.
  // By convention, if the key fields are empty, the content is treated as plaintext.
  if (!roflEncryptedKey || roflEncryptedKey === "0x") {
    return {
      payload: ethers.toUtf8String(payload),
      sessionKey: null,
    };
  }

  const parsedRoflKey = ethCrypto.cipher.parse(strip0xPrefix(roflEncryptedKey));
  const sessionKey = await ethCrypto.decryptWithPrivateKey(AI_AGENT_PRIVATE_KEY, parsedRoflKey);

  const parsedContent = ethCrypto.cipher.parse(strip0xPrefix(payload));
  const decrypted = await ethCrypto.decryptWithPrivateKey(sessionKey, parsedContent);

  return {
    payload: JSON.parse(decrypted),
    sessionKey,
  };
}

// --- Event Handlers (Stubs for Phase 4) ---

async function handlePrompt(
  user,
  promptMessageId,
  answerMessageId,
  conversationId,
  payload, // This is `bytes` on EVM, `string` on Sapphire
  roflEncryptedKey,
  event,
) {
  console.log(
    `[EVENT] Processing PromptSubmitted for convId: ${conversationId} in block ${event.blockNumber}`,
  );
  // TODO: Implement Phase 4 logic.
  // 1. Decrypt payload to get prompt, session key, and isNewConversation flag.
  // 2. Retrieve conversation history from Arweave.
  // 3. Query AI model.
  // 4. Format, encrypt, and upload files to Arweave.
  // 5. Construct CidBundle.
  // 6. Call contract.submitAnswer().
}

async function handleRegeneration(
  user,
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
  // TODO: Implement Phase 4 logic.
  // 1. Decrypt payload to get instructions and session key.
  // 2. Retrieve history up to the original prompt from Arweave.
  // 3. Query AI.
  // 4. Format, encrypt, and upload the new AnswerMessageFile.
  // 5. Call contract.submitAnswer() with only the answerMessageCID.
}

async function handleBranch(user, originalConversationId, branchPointMessageId, event) {
  console.log(
    `[EVENT] Processing BranchRequested for convId: ${originalConversationId} in block ${event.blockNumber}`,
  );
  // TODO: Implement Phase 4 logic.
  // 1. Format new ConversationFile and ConversationMetadataFile.
  // 2. Encrypt and upload both to Arweave.
  // 3. Call contract.submitBranch() with the new CIDs.
}

async function handleMetadataUpdate(user, conversationId, payload, roflEncryptedKey, event) {
  console.log(
    `[EVENT] Processing MetadataUpdateRequested for convId: ${conversationId} in block ${event.blockNumber}`,
  );
  // TODO: Implement Phase 4 logic.
  // 1. Decrypt payload to get new title/status and session key.
  // 2. Format new ConversationMetadataFile.
  // 3. Encrypt and upload to Arweave.
  // 4. Call contract.submitConversationMetadata() with the new CID.
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

    await sendAlert("Oracle Address Mismatch", errorMessage);

    throw new Error(errorMessage); // Halt the oracle if it can't verify its identity.
  }
}

/**
 * Periodically checks for and retries failed jobs from a persistent queue file.
 * Uses exponential backoff to space out retries.
 */
async function retryFailedJobs() {
  let failedJobs;
  try {
    failedJobs = JSON.parse(await fs.readFile(FAILED_JOBS_FILE_PATH, "utf-8"));
  } catch (e) {
    return; // No failed jobs file, nothing to do.
  }

  if (failedJobs.length === 0) return;

  console.log(`[Retry] Checking ${failedJobs.length} failed job(s)...`);
  const remainingJobs = [];
  let processed = false;

  for (const job of failedJobs) {
    if (Date.now() >= job.nextAttemptAt) {
      console.log(
        `[Retry] Retrying job for event: ${job.eventName} from block ${job.event.blockNumber}`,
      );
      try {
        // Re-run the original handler with the stored event data
        switch (job.eventName) {
          case "PromptSubmitted":
            await handlePrompt(...job.event.args, job.event);
            break;
          // ... add cases for other events
        }
        console.log(`[Retry] Successfully processed job for event: ${job.eventName}`);
        processed = true;
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
          processed = true; // Remove it from the queue
        } else {
          const delay = BASE_RETRY_DELAY_MS * Math.pow(2, job.retryCount);
          job.nextAttemptAt = Date.now() + delay;
          remainingJobs.push(job);
        }
      }
    } else {
      remainingJobs.push(job); // Not time to retry yet, keep it in the queue
    }
  }

  // If we processed any jobs (successfully or by dropping them), update the file.
  if (processed) {
    await fs.writeFile(FAILED_JOBS_FILE_PATH, JSON.stringify(remainingJobs, null, 2));
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
    // ERROR CLASSIFICATION
    // For now, we'll treat most I/O errors (like from Irys) as retryable.
    // We can add more specific checks here later (e.g., based on error codes).
    const isRetryable = error.message.includes("Irys") || error.message.includes("fetch");

    if (isRetryable) {
      console.warn(`Encountered a retryable error for ${eventName}. Adding to retry queue.`);
      let failedJobs = [];
      try {
        failedJobs = JSON.parse(await fs.readFile(FAILED_JOBS_FILE_PATH, "utf-8"));
      } catch (e) {
        /* File doesn't exist, will be created */
      }

      failedJobs.push({
        eventName,
        event: { args: event.args, blockNumber: event.blockNumber }, // Store minimal event data
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
 * Scans for and processes any events that were missed while the oracle was offline.
 * This function is critical for ensuring no user requests are ever lost.
 * @param {number} fromBlock - The block number to start scanning from.
 * @param {number} toBlock - The latest block number to scan up to.
 */
async function processPastEvents(fromBlock, toBlock) {
  if (fromBlock > toBlock) return;
  console.log(`Catching up on missed events from block ${fromBlock} to ${toBlock}...`);

  try {
    const eventPromises = [
      contract.queryFilter(contract.filters.PromptSubmitted(), fromBlock, toBlock),
      contract.queryFilter(contract.filters.RegenerationRequested(), fromBlock, toBlock),
      contract.queryFilter(contract.filters.BranchRequested(), fromBlock, toBlock),
      contract.queryFilter(contract.filters.MetadataUpdateRequested(), fromBlock, toBlock),
    ];

    const allEventsNested = await Promise.all(eventPromises);
    const allEvents = allEventsNested.flat();

    // Sort events strictly by their on-chain order to ensure correct processing.
    allEvents.sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) {
        return a.blockNumber - b.blockNumber;
      }
      return a.transactionIndex - b.transactionIndex;
    });

    if (allEvents.length > 0) {
      console.log(`Found ${allEvents.length} missed events to process.`);
      for (const event of allEvents) {
        // Use a switch on the event name to call the correct handler
        switch (event.eventName) {
          case "PromptSubmitted":
            await handlePrompt(...event.args, event);
            break;
          case "RegenerationRequested":
            await handleRegeneration(...event.args, event);
            break;
          case "BranchRequested":
            await handleBranch(...event.args, event);
            break;
          case "MetadataUpdateRequested":
            await handleMetadataUpdate(...event.args, event);
            break;
          default:
            console.warn(`Unknown event encountered during catch-up: ${event.eventName}`);
        }
        // After each historical event is processed, save the state.
        await fs.writeFile(
          STATE_FILE_PATH,
          JSON.stringify({ lastProcessedBlock: event.blockNumber }),
        );
      }
    } else {
      console.log("No missed events found.");
    }
  } catch (error) {
    const alertMessage = `Failed during historical event catch-up process between blocks ${fromBlock}-${toBlock}. The oracle may need intervention. Error: ${error.message}`;
    console.error(alertMessage, error);
    await sendAlert("Oracle Catch-up Failed", alertMessage);
    throw error; // Throw to stop the oracle from starting in a potentially broken state.
  }
}

/**
 * The entry point for the oracle service.
 */
async function start() {
  console.log("--- INITIALIZING ORACLE SERVICE ---");

  // Step 1: Initialize the connection to the Arweave/Irys storage provider.
  await initializeIrys();

  // Step 2: Ensure the on-chain oracle address is correctly set to this wallet.
  await setOracleAddress();

  // Step 3: Catch up on any events that were missed while the oracle was offline.
  let state;
  try {
    state = JSON.parse(await fs.readFile(STATE_FILE_PATH, "utf-8"));
  } catch (e) {
    // If the state file doesn't exist or is invalid, create a default state.
    state = { lastProcessedBlock: 0 };
    console.log("No valid state file found. Will start processing from a recent block.");
  }

  const latestBlock = await provider.getBlockNumber();
  // On a fresh start, look back ~1 hour (Sapphire ~6000 blocks, Base ~1800 blocks). Otherwise, start from the next block.
  const fromBlock =
    state.lastProcessedBlock === 0 ? Math.max(0, latestBlock - 6000) : state.lastProcessedBlock + 1;

  await processPastEvents(fromBlock, latestBlock);
  await fs.writeFile(STATE_FILE_PATH, JSON.stringify({ lastProcessedBlock: latestBlock }));

  // Step 4: Attach persistent listeners for all relevant on-chain events.
  console.log("Attaching contract event listeners for live events...");
  contract.on("PromptSubmitted", (...args) =>
    handleAndRecord("PromptSubmitted", handlePrompt, ...args),
  );
  contract.on("RegenerationRequested", (...args) =>
    handleAndRecord("RegenerationRequested", handleRegeneration, ...args),
  );
  contract.on("BranchRequested", (...args) =>
    handleAndRecord("BranchRequested", handleBranch, ...args),
  );
  contract.on("MetadataUpdateRequested", (...args) =>
    handleAndRecord("MetadataUpdateRequested", handleMetadataUpdate, ...args),
  );

  // Step 5: Start the background retry mechanism.
  setInterval(retryFailedJobs, RETRY_INTERVAL_MS);

  console.log(`✅ Oracle is running and listening for new events from block ${latestBlock + 1}.`);
}

module.exports = {
  start,
};
