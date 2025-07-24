const { ethers } = require("ethers");
const { SiweMessage } = require("siwe");
const { setupProviderAndSigner, getContractArtifacts } = require("./contractUtility");
const { submitTx } = require("./roflUtility");
require("dotenv").config({ path: process.env.ENV_FILE || "./oracle/.env.oracle" });

console.log({
  ENV_FILE: process.env.ENV_FILE,
  PRIVATE_KEY: process.env.PRIVATE_KEY?.slice(0, 6) + "...", // For security, only log a prefix.
  NETWORK_NAME: process.env.NETWORK_NAME,
  CONTRACT_ADDRESS: process.env.CONTRACT_ADDRESS,
  OLLAMA_URL: process.env.OLLAMA_URL,
});

// Setup provider and signer using the Sapphire wrapper for confidential execution.
const { provider: wrappedProvider, signer: wrappedSigner } = setupProviderAndSigner(
  process.env.NETWORK_NAME,
  process.env.PRIVATE_KEY,
);
const { abi } = getContractArtifacts("ChatBot");
const contract = new ethers.Contract(process.env.CONTRACT_ADDRESS, abi, wrappedSigner);

console.log("Oracle signer address:", wrappedSigner.address);
console.log("ChatBot contract address:", contract.target);

/**
 * Ensures the oracle's address is correctly registered in the smart contract.
 */
async function setOracleAddress() {
  const oracleAddress = await contract.oracle();
  console.log("ChatBot on-chain oracle address:", oracleAddress);

  if (oracleAddress.toLowerCase() !== wrappedSigner.address.toLowerCase()) {
    console.log(`Updating oracle address from ${oracleAddress} to ${wrappedSigner.address}`);
    const tx = await contract.setOracle(wrappedSigner.address, {
      gasLimit: 1000000,
    });
    await tx.wait();
    console.log(`Updated oracle address to ${wrappedSigner.address}`);
  } else {
    console.log(`Oracle address already correct: ${oracleAddress}`);
  }
}

/**
 * Performs a SIWE login against the contract to receive an encrypted authentication token.
 * This token is used to authenticate view calls, as `msg.sender` is not reliable for those on Sapphire.
 * @returns {Promise<{token: string, expiresAt: number}>} An object containing the session token and its expiration timestamp.
 */
async function loginToContract() {
  console.log("Performing SIWE login to get a new session token...");
  const { chainId } = await wrappedProvider.getNetwork();
  const domain = process.env.DOMAIN || "example.com";

  // Define the token's validity period. 24 hours is a sensible default for a production service.
  const expirationTime = new Date();
  expirationTime.setHours(expirationTime.getHours() + 24);

  const siweMessage = new SiweMessage({
    domain,
    address: wrappedSigner.address,
    statement: "Oracle authentication for ChatBot",
    uri: `http://${domain}`,
    version: "1",
    chainId: Number(chainId),
    nonce: ethers.hexlify(ethers.randomBytes(32)), // A unique nonce prevents replay attacks.
    expirationTime: expirationTime.toISOString(), // Set the token expiration time.
  });

  const messageToSign = siweMessage.prepareMessage();
  const signature = await wrappedSigner.signMessage(messageToSign);

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
 * @param {string} authToken - The signer's encrypted SIWE token.
 * @param {string} address - The address to retrieve prompts for.
 * @returns {Promise<string[]>} An array of prompts.
 */
async function retrievePrompts(authToken, address) {
  try {
    // For Sapphire `view` calls (`eth_call`), `msg.sender` is always `address(0x0)`.
    // Therefore, we must use an `authToken` for authentication.
    // The `{ from: ... }`parameter is ignored and has been omitted.
    return await contract.getPrompts(authToken, address);
  } catch (e) {
    console.error("Error retrieving prompts:", e);
    return [];
  }
}

/**
 * Retrieve answers from the contract for the given address.
 * @param {string} authToken - The signer's encrypted SIWE token.
 * @param {string} address - The address to retrieve answers for.
 * @returns {Promise<Array<[number, string]>>} An array of answers.
 */
async function retrieveAnswers(authToken, address) {
  try {
    // For Sapphire `view` calls (`eth_call`), `msg.sender` is always `address(0x0)`.
    // Therefore, we must use an `authToken` for authentication.
    // The `{ from: ... }`parameter is ignored and has been omitted.
    return await contract.getAnswers(authToken, address);
  } catch (e) {
    console.error("Error retrieving answers:", e);
    return [];
  }
}

/**
 * Query Ollama with the collected prompts.
 * @param {string[]} prompts - The array of prompts forming the addresses conversation history.
 * @returns {Promise<string>} The content of the AI's response.
 */
async function askChatBot(prompts) {
  try {
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

    const json = await res.json();
    return json.message?.content || "Error generating response";
  } catch (e) {
    console.error("Error calling Ollama service:", e);
    return "Error: Could not generate a response from the AI service.";
  }
}

/**
 * Submit the AI answer to the Oracle contract on-chain.
 * This is a state-changing transaction and requires gas.
 * Falls back to standard transaction submission for localnet.
 * @param {string} answer - The AI's response text.
 * @param {number} promptId - The ID of the prompt being answered.
 * @param {string} address - The user’s address associated with the prompt.
 */
async function submitAnswer(answer, promptId, address) {
  console.log(`Submitting answer for prompt ${promptId} to ${address}...`);

  // Set a dynamic gas limit to prevent 'out of gas' errors for long answers.
  // Use a high base minimum plus a buffer per character of the answer.
  const gasLimit = Math.max(3000000, 1500 * answer.length);
  const isLocalnet = process.env.NETWORK_NAME === "sapphire-localnet";

  try {
    if (isLocalnet) {
      const tx = await contract.submitAnswer(answer, promptId, address, { gasLimit });
      const receipt = await tx.wait();
      console.log(`Tx confirmed: ${receipt.hash}`);
    } else {
      const txUnsigned = await contract.submitAnswer.populateTransaction(answer, promptId, address);
      const txParams = {
        to: process.env.CONTRACT_ADDRESS.replace(/^0x/, ""),
        gas: gasLimit,
        value: "0",
        data: txUnsigned.data.replace(/^0x/, ""),
      };

      const responseHex = await submitTx(txParams);
      console.log(`Tx confirmed: ${responseHex}`);
    }

    console.log(`Submitted answer for prompt ${promptId} to address ${address}`);
  } catch (err) {
    console.error(`Failed to submit answer for prompt ${promptId}:`, err);
  }
}

/**
 * The main polling loop that listens for new prompts and orchestrates the response flow.
 */
async function pollPrompts() {
  console.log("Listening for prompts...");

  // Get the initial session, which contains the token and its expiration.
  let session = await loginToContract();

  while (true) {
    try {
      // Proactively refresh the auth token if it's about to expire.
      // Check against a 5-minute buffer to avoid race conditions.
      const nowInSeconds = Math.floor(Date.now() / 1000);
      if (nowInSeconds >= session.expiresAt - 300) {
        console.log("Auth token is nearing expiration. Refreshing proactively...");
        session = await loginToContract();
      }

      const latestBlock = await wrappedProvider.getBlockNumber();
      const logs = await contract.queryFilter(contract.filters.PromptSubmitted(), latestBlock);

      for (const log of logs) {
        const submitter = log.args.sender;
        console.log(`Processing new prompt from ${submitter}...`);

        const prompts = await retrievePrompts(session.token, submitter);
        const answers = await retrieveAnswers(session.token, submitter);

        if (!prompts || prompts.length === 0) {
          console.log(`No prompts found for ${submitter}, skipping.`);
          continue;
        }

        // Check if the latest prompt has already been answered.
        if (answers.length > 0 && answers[answers.length - 1][0] >= prompts.length - 1) {
          console.log(`Last prompt for ${submitter} already answered, skipping.`);
          continue;
        }

        console.log(`Got ${prompts.length} prompts. Querying AI model...`);
        const answer = await askChatBot(prompts);
        console.log(`Storing chat bot answer for ${submitter}...`);
        await submitAnswer(answer, prompts.length - 1, submitter);
      }
    } catch (err) {
      // Catch errors in the main loop to prevent the entire service from crashing.
      console.error("An unexpected error occurred in the polling loop:", err);
    }
    // Wait for a short period before polling again to avoid spamming the RPC node.
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

/**
 * The entry point for the oracle service.
 */
async function start() {
  await setOracleAddress();
  await pollPrompts();
}

module.exports = {
  start,
};
