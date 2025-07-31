const dotenv = require("dotenv");
const ethCrypto = require("eth-crypto");
const { ethers } = require("ethers");
const path = require("path");
const { SiweMessage } = require("siwe");
const { v5: uuidv5 } = require("uuid");

const { initializeOracle } = require("./contractUtility");
const { submitTx } = require("./roflUtility");

// Load the specific environment file first for precedence.
if (process.env.ENV_FILE) {
  dotenv.config({ path: process.env.ENV_FILE });
}
// Load the base .env.oracle file to fill in any missing non-secret variables.
dotenv.config({ path: path.resolve(__dirname, "./.env.oracle") });

// --- Configuration & Initialization ---
const NAMESPACE_UUID = "f7e8a6a0-8d5d-4f7d-8f8a-8c7d6e5f4a3b";
const NETWORK_NAME = process.env.NETWORK_NAME;
const ORACLE_PRIVATE_KEY = process.env.PRIVATE_KEY;
const ORACLE_PUBLIC_KEY = process.env.PUBLIC_KEY;
const ORACLE_CONTRACT_ADDRESS = process.env.ORACLE_CONTRACT_ADDRESS;

// This single function from our utility handles all environment-specific setup.
const { provider, signer, contract, isSapphire } = initializeOracle(
  NETWORK_NAME,
  ORACLE_PRIVATE_KEY,
  ORACLE_CONTRACT_ADDRESS,
);

// This global session is only used by the Sapphire workflow.
let sapphireSession;

console.log(`--- ORACLE STARTING ON: ${NETWORK_NAME.toUpperCase()} ---`);
console.log(`Oracle signer address: ${signer.address}`);
console.log(`Contract address: ${contract.target}`);
console.log(
  `Operating in ${isSapphire ? "Sapphire (confidential)" : "Public EVM (encrypted)"} mode.`,
);

/**
 * Ensures the oracle's address is correctly registered in the smart contract.
 * For Sapphire, it sends a TEE-signed transaction. For EVM, it sends a standard transaction.
 */
async function setOracleAddress() {
  const onChainOracle = await contract.oracle();
  if (onChainOracle.toLowerCase() === signer.address.toLowerCase()) {
    console.log(`Oracle address already correct: ${signer.address}`);
    return;
  }
  console.log(`Updating on-chain oracle address from ${onChainOracle} to ${signer.address}`);

  try {
    if (isSapphire) {
      const isLocalnet = process.env.NETWORK_NAME === "sapphire-localnet";

      if (isLocalnet) {
        const tx = await contract.setOracle(signer.address, { gasLimit: 1000000 });
        await tx.wait();
      } else {
        // Use the ROFL utility for testnet/mainnet
        console.log("Populating setOracle transaction...");
        const txUnsigned = await contract.setOracle.populateTransaction(signer.address);

        const txParams = {
          to: ORACLE_CONTRACT_ADDRESS.replace(/^0x/, ""),
          gas: 2000000, // setOracle is a simple transaction, a fixed high limit is safe
          value: 0,
          data: txUnsigned.data.replace(/^0x/, ""),
        };

        const txHash = await submitTx(txParams);
        console.log(`setOracle transaction submitted: ${txHash}`);
      }
    } else {
      // On a standard EVM, the oracle sends a regular transaction from its own wallet.
      // Note: This requires the `setOracle` function on the EVMChatBot contract to be
      // either unprotected or callable by the current oracle address.
      const tx = await contract.setOracle(signer.address);
      await tx.wait();
    }

    console.log(`Updated oracle address to ${signer.address}`);
  } catch (err) {
    console.error("Failed to update oracle address:", err);
    throw err; // Throw to prevent the oracle from running in a bad state.
  }
}
/**
 * Performs a SIWE login against the Sapphire contract to receive an encrypted authentication token.
 * This token is used to authenticate view calls, as `msg.sender` is not reliable for those on Sapphire.
 * @returns {Promise<{token: string, expiresAt: number}>} An object containing the session token and its expiration timestamp.
 */
async function loginToContract() {
  if (!isSapphire) return; // This function is a no-op on non-Sapphire chains.

  console.log("Performing SIWE login to get a new session token...");
  const { chainId } = await provider.getNetwork();
  const domain = await contract.domain();

  // Define the token's validity period. 24 hours is a sensible default for a production service.
  const expirationTime = new Date();
  expirationTime.setHours(expirationTime.getHours() + 24);

  const siweMessage = new SiweMessage({
    domain,
    address: signer.address,
    statement: "Oracle authentication for ChatBot",
    uri: `http://${domain}`,
    version: "1",
    chainId: Number(chainId),
    nonce: ethers.hexlify(ethers.randomBytes(32)), // A unique nonce prevents replay attacks.
    expirationTime: expirationTime.toISOString(), // Set the token expiration time.
  });

  const messageToSign = siweMessage.prepareMessage();
  const signature = await signer.signMessage(messageToSign);

  const { r, s, v } = ethers.Signature.from(signature);

  // This is a view call; it costs no gas. The contract verifies the signature
  // and returns an encrypted token that only it can decrypt.
  const encryptedAuthToken = await contract.login(messageToSign, { r, s, v });

  console.log(
    `Successfully received new auth token, valid until ${expirationTime.toLocaleString()}`,
  );

  // Return the token and its expiration time (in seconds) for proactive session management.
  return {
    token: encryptedAuthToken,
    expiresAt: Math.floor(expirationTime.getTime() / 1000),
  };
}

/**
 * Retrieve prompts from the contract for the given address.
 * Handles both Sapphire (with authToken) and public EVM (without authToken) workflows.
 * @param {string} address - The address to retrieve prompts for.
 * @returns {Promise<Array>} An array of prompts (either string[] or EncryptedMessage[]).
 */
async function retrievePrompts(address) {
  try {
    if (isSapphire) {
      // For Sapphire `view` calls (`eth_call`), `msg.sender` is always `address(0x0)`.
      // Therefore, we must use an `authToken` for authentication.
      // The `{ from: ... }`parameter is ignored and has been omitted.
      const authToken = sapphireSession.token;

      return await contract.getPrompts(authToken, address);
    } else {
      return await contract.getPrompts(address);
    }
  } catch (err) {
    console.error(`Error retrieving prompts for ${address}:`, err);
    return []; // Return empty array on failure to prevent crash.
  }
}

/**
 * Retrieve answers from the contract for the given address.
 * Handles both Sapphire (with authToken) and public EVM (without authToken) workflows.
 * @param {string} address - The address to retrieve answers for.
 * @returns {Promise<Array>} An array of answers (either Answer[] or EncryptedAnswer[]).
 */
async function retrieveAnswers(address) {
  try {
    if (isSapphire) {
      // For Sapphire `view` calls (`eth_call`), `msg.sender` is always `address(0x0)`.
      // Therefore, we must use an `authToken` for authentication.
      // The `{ from: ... }`parameter is ignored and has been omitted.
      const authToken = sapphireSession.token;

      return await contract.getAnswers(authToken, address);
    } else {
      return await contract.getAnswers(address);
    }
  } catch (err) {
    console.error(`Error retrieving answers for ${address}:`, err);
    return []; // Return empty array on failure to prevent crash.
  }
}

/**
 * Query the DeepSeek model via a local Ollama server.
 * @param {string[]} prompts - The array of prompts forming the conversation history.
 * @returns {Promise<string>} The content of the AI's response.
 */
async function queryDeepSeek(prompts) {
  if (!process.env.OLLAMA_URL) {
    throw new Error("OLLAMA_URL is not set in the environment file.");
  }

  const messages = prompts.map((p) => ({
    role: "user",
    content: p,
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
 * @param {string[]} prompts - The array of prompts forming the conversation history.
 * @returns {Promise<string>} The content of the AI's response.
 */
async function queryChainGPT(prompts, userAddress) {
  if (!process.env.CHAIN_GPT_API_KEY) {
    throw new Error("CHAIN_GPT_API_KEY is not set in the environment file.");
  }
  if (!prompts || prompts.length === 0) {
    throw new Error("Cannot query with an empty prompt list.");
  }

  // The user's current question is the last prompt.
  const question = prompts[prompts.length - 1];

  // The first prompt defines the unique ID for this entire conversation history.
  const firstPrompt = prompts[0];

  // Generate a deterministic UUID for this conversation.
  // The same user + same first prompt will ALWAYS result in the same UUID.
  const uniqueConversationIdentifier = `${userAddress}:${firstPrompt}`;
  const conversationUUID = uuidv5(uniqueConversationIdentifier, NAMESPACE_UUID);

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
 * @param {string[]} prompts - The array of prompts to send to the AI.
 * @param {string} userAddress - The address of the user submitting the prompt.
 * @returns {Promise<string>} The content of the AI's response.
 */
async function queryAIModel(prompts, userAddress) {
  const aiProvider = process.env.AI_PROVIDER || "DeepSeek";
  console.log(`Querying AI model via: ${aiProvider}`);

  try {
    switch (aiProvider.toLowerCase()) {
      case "chaingpt":
        return await queryChainGPT(prompts, userAddress);
      case "deepseek":
        return await queryDeepSeek(prompts);
      default:
        console.error(`Unknown AI_PROVIDER: "${aiProvider}". Defaulting to DeepSeek.`);
        return await queryDeepSeek(prompts);
    }
  } catch (err) {
    console.error(`Error querying ${aiProvider}:`, err);
    return `Error: Could not generate a response from the ${aiProvider} service.`;
  }
}

/**
 * Submit the AI answer to the Oracle contract on-chain.
 * Handles both plaintext (Sapphire) and encrypted (EVM) answer submission.
 * @param {string} answerText - The plaintext AI response.
 * @param {number} promptId - The ID of the prompt being answered.
 * @param {string} userAddress - The user’s address associated with the prompt.
 * @param {string} [userPublicKey] - (EVM only) The user's public key, recovered from their transaction signature.
 */
async function submitAnswer(answerText, promptId, userAddress, userPublicKey) {
  console.log(`Submitting answer for prompt ${promptId} to ${userAddress}...`);

  try {
    if (isSapphire) {
      // Set a dynamic gas limit to prevent 'out of gas' errors for long answers.
      // Use a high base minimum plus a buffer per character of the answer.
      const gasLimit = Math.max(3000000, 1500 * answerText.length);

      const tx = await contract.submitAnswer(answerText, promptId, userAddress, { gasLimit });
      const receipt = await tx.wait();
      console.log(`Tx confirmed: ${receipt.hash}`);
    } else {
      // For public EVM, we use the provided public key to encrypt the answer.
      if (!userPublicKey) {
        throw new Error(
          `User public key was not provided for user ${userAddress}. Cannot submit answer.`,
        );
      }
      console.log(`Encrypting response for user ${userAddress}...`);

      const sessionKey = ethCrypto.createIdentity().privateKey;

      // The public key is derived from the session's private key.
      const sessionPublicKey = ethCrypto.getPublicKey(sessionKey).slice(2);

      // Clean the keys to remove the '0x04' prefix for eth-crypto.
      const userPublicKeyClean = userPublicKey.startsWith("0x04")
        ? userPublicKey.slice(4)
        : userPublicKey;
      const oraclePublicKeyClean = ORACLE_PUBLIC_KEY.startsWith("0x04")
        ? ORACLE_PUBLIC_KEY.slice(4)
        : ORACLE_PUBLIC_KEY;

      const encryptedContent = await ethCrypto.encryptWithPublicKey(sessionPublicKey, answerText);
      const userEncryptedKey = await ethCrypto.encryptWithPublicKey(userPublicKeyClean, sessionKey);
      const roflEncryptedKey = await ethCrypto.encryptWithPublicKey(
        oraclePublicKeyClean,
        sessionKey,
      );

      const tx = await contract.submitAnswer(
        ethCrypto.cipher.stringify(encryptedContent),
        ethCrypto.cipher.stringify(userEncryptedKey),
        ethCrypto.cipher.stringify(roflEncryptedKey),
        promptId,
        userAddress,
      );
      const receipt = await tx.wait();
      console.log(`Tx confirmed: ${receipt.hash}`);
    }

    console.log(`Answer for prompt #${promptId} submitted successfully.`);
  } catch (err) {
    console.error(`Failed to submit answer for prompt ${promptId}:`, err);
  }
}

/**
 * The main polling loop that listens for new prompts and orchestrates the response flow.
 */
async function pollPrompts() {
  console.log("Listening for prompts...");

  if (isSapphire) {
    // Initialize the session if on Sapphire to be used for the authToken.
    sapphireSession = await loginToContract();

    let lastProcessedBlock = await provider.getBlockNumber();
    console.log(`Starting to process events from block ${lastProcessedBlock}`);

    while (true) {
      try {
        const nowInSeconds = Math.floor(Date.now() / 1000);
        if (nowInSeconds >= sapphireSession.expiresAt - 300) {
          console.log("Auth token is nearing expiration. Refreshing proactively...");
          sapphireSession = await loginToContract();
        }

        const latestBlock = await provider.getBlockNumber();

        if (latestBlock > lastProcessedBlock) {
          // More robust: Query all blocks since the last check
          const logs = await contract.queryFilter(
            contract.filters.PromptSubmitted(),
            lastProcessedBlock + 1,
            latestBlock,
          );

          const uniqueSenders = new Set(logs.map((log) => log.args.sender));

          for (const sender of uniqueSenders) {
            console.log(`Checking for new prompts from ${sender}...`);

            const [prompts, answers] = await Promise.all([
              retrievePrompts(sender),
              retrieveAnswers(sender),
            ]);

            if (!prompts || prompts.length === 0) continue;

            // More robust: Find the *next* unanswered prompt, not just the last one
            const answeredPromptIds = new Set(answers.map((a) => Number(a.promptId)));
            const nextPromptId = prompts.findIndex((_, i) => !answeredPromptIds.has(i));

            if (nextPromptId === -1) {
              console.log(`All prompts for ${sender} have been answered. Skipping.`);
              continue;
            }
            console.log(`Found unanswered prompt #${nextPromptId}. Querying AI model...`);

            const answerText = await queryAIModel(prompts, sender);

            console.log(`Storing AI answer for prompt #${nextPromptId} for ${sender}...`);
            await submitAnswer(answerText, nextPromptId, sender);
          }

          lastProcessedBlock = latestBlock;
        }
      } catch (err) {
        console.error("An unexpected error occurred in the polling loop:", err);
      }
      await new Promise((resolve) => setTimeout(resolve, 5000)); // Increased polling interval slightly
    }
  } else {
    // The public EVM workflow uses an event listener for real-time processing.
    contract.on("PromptSubmitted", async (sender, event) => {
      console.log(`[EVENT] Detected new prompt from: ${sender}`);

      try {
        const tx = await provider.getTransaction(event.transactionHash);
        const userPublicKey = ethers.SigningKey.recoverPublicKey(tx.unsignedHash, tx.signature);

        const [encryptedPrompts, encryptedAnswers] = await Promise.all([
          retrievePrompts(sender),
          retrieveAnswers(sender),
        ]);

        if (!encryptedPrompts || encryptedPrompts.length === 0) return;

        // Decrypt the full prompt history for the AI's context.
        const plaintextPrompts = await Promise.all(
          encryptedPrompts.map((p) => {
            const parsedRoflKey = ethCrypto.cipher.parse(p.roflEncryptedKey);
            const parsedContent = ethCrypto.cipher.parse(p.encryptedContent);

            return ethCrypto
              .decryptWithPrivateKey(ORACLE_PRIVATE_KEY, parsedRoflKey)
              .then((sessionKey) => ethCrypto.decryptWithPrivateKey(sessionKey, parsedContent));
          }),
        );

        const answeredPromptIds = new Set(encryptedAnswers.map((a) => Number(a.promptId)));
        const nextPromptId = plaintextPrompts.findIndex((_, i) => !answeredPromptIds.has(i));

        if (nextPromptId === -1) {
          console.log(`All prompts for ${sender} have been answered. Skipping.`);
          return;
        }
        console.log(`Found unanswered prompt #${nextPromptId}. Querying AI...`);

        const answerText = await queryAIModel(plaintextPrompts, sender);
        await submitAnswer(answerText, nextPromptId, sender, userPublicKey);
      } catch (err) {
        console.error(`Error processing prompt from ${sender}:`, err);
      }
    });

    // Keep the process alive for the listener.
    await new Promise(() => {});
  }
}

/**
 * The entry point for the oracle service.
 */
async function start() {
  console.log("--- CHATBOT ORACLE SCRIPT STARTING ---");

  await setOracleAddress();
  await pollPrompts();
}

module.exports = {
  start,
};
