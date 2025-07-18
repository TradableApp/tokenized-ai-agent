const { ethers } = require("ethers");
const { SiweMessage } = require("siwe");
const { setupProviderAndSigner, getContractArtifacts } = require("./contractUtility");
const { submitTx, fetchKey } = require("./roflUtility"); // Kept for future ROFL integration
require("dotenv").config({ path: process.env.ENV_FILE || "./oracle/.env.oracle" });

console.log({
  ENV_FILE: process.env.ENV_FILE,
  PRIVATE_KEY: process.env.PRIVATE_KEY?.slice(0, 6) + "...", // Don't log the full private key!
  NETWORK_NAME: process.env.NETWORK_NAME,
  CONTRACT_ADDRESS: process.env.CONTRACT_ADDRESS,
  OLLAMA_URL: process.env.OLLAMA_URL,
});

const { provider: wrappedProvider, signer: wrappedSigner } = setupProviderAndSigner(
  process.env.NETWORK_NAME,
  process.env.PRIVATE_KEY,
);
const { abi } = getContractArtifacts("ChatBot");
const contract = new ethers.Contract(process.env.CONTRACT_ADDRESS, abi, wrappedSigner);
const provider = wrappedSigner.provider;

console.log("Oracle signer address:", wrappedSigner.address);
console.log("ChatBot contract address:", contract.target);

/**
 * Ensure the Oracle address is correctly set on the contract.
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
 * Creates a "Sign-In with Ethereum" (SIWE) authToken to authenticate oracle.
 * @returns {Promise<string>} The ABI-encoded authentication token.
 */
async function createSiweAuthToken() {
  const { chainId } = await wrappedProvider.getNetwork();
  const domain = process.env.DOMAIN || "example.com";
  const siweMessage = new SiweMessage({
    domain,
    address: wrappedSigner.address,
    statement: "Oracle authentication for ChatBot",
    uri: `http://${domain}`,
    version: "1",
    chainId: Number(chainId),
    nonce: ethers.hexlify(ethers.randomBytes(32)),
  });
  const messageToSign = await siweMessage.prepareMessage();
  // Use the wrapped signer to create a standard, verifiable signature
  const signature = await wrappedSigner.signMessage(messageToSign);
  return ethers.AbiCoder.defaultAbiCoder().encode(
    [
      "tuple(string domain, address addr, string statement, string uri, string version, uint256 chainId, uint256 nonce, uint256 issuedAt, bytes recap)",
      "bytes",
    ],
    [
      {
        domain: siweMessage.domain,
        addr: siweMessage.address,
        statement: siweMessage.statement,
        uri: siweMessage.uri,
        version: siweMessage.version,
        chainId: siweMessage.chainId,
        nonce: siweMessage.nonce,
        issuedAt: Date.parse(siweMessage.issuedAt),
        recap: ethers.toUtf8Bytes(siweMessage.recap ?? ""),
      },
      signature,
    ],
  );
}

/**
 * Retrieve prompts from the contract for the given address.
 * @param {string} address
 * @returns {Promise<string[]>}
 */
async function retrievePrompts(address) {
  try {
    const authToken = await createSiweAuthToken();
    return await contract.getPrompts(authToken, address);
  } catch (e) {
    console.error("Error retrieving prompts:", e);
    return [];
  }
}

/**
 * Retrieve answers from the contract for the given address.
 * @param {string} address
 * @returns {Promise<Array<[number, string]>>}
 */
async function retrieveAnswers(address) {
  try {
    const authToken = await createSiweAuthToken();
    return await contract.getAnswers(authToken, address);
  } catch (e) {
    console.error("Error retrieving answers:", e);
    return [];
  }
}

/**
 * Query Ollama with the collected prompts.
 * @param {string[]} prompts
 * @returns {Promise<string>}
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
    console.error("Error calling Ollama:", e);
    return "Error generating response";
  }
}

/**
 * Submit the AI answer to the Oracle contract on-chain.
 * @param {string} answer
 * @param {number} promptId
 * @param {string} address
 */
async function submitAnswer(answer, promptId, address) {
  const gasLimit = Math.max(3000000, 1500 * answer.length);
  const tx = await contract.submitAnswer(answer, promptId, address, { gasLimit });
  await tx.wait();
  console.log(`Submitted answer for prompt ${promptId} to ${address}`);
}

/**
 * Poll the blockchain for new prompts, generate answers, and submit.
 */
async function pollPrompts() {
  console.log("Listening for prompts...");
  while (true) {
    try {
      const latestBlock = await wrappedProvider.getBlockNumber();
      const logs = await contract.queryFilter(contract.filters.PromptSubmitted(), latestBlock);

      for (const log of logs) {
        const submitter = log.args.sender;
        console.log(`New prompt submitted by ${submitter}`);
        const prompts = await retrievePrompts(submitter);
        const answers = await retrieveAnswers(submitter);

        if (!prompts || prompts.length === 0) {
          console.log(`No prompts found for ${submitter}, skipping...`);
          continue;
        }

        if (answers.length > 0 && answers[answers.length - 1][0] === prompts.length - 1) {
          console.log("Last prompt already answered, skipping");
          continue;
        }

        console.log(`Got ${prompts.length} prompts. Asking chat bot...`);
        const answer = await askChatBot(prompts);
        console.log(`Storing chat bot answer for ${submitter}...`);
        await submitAnswer(answer, prompts.length - 1, submitter);
      }
    } catch (err) {
      console.error("Error in poll loop:", err);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

/**
 * Entry point: ensure Oracle is configured, then start polling.
 */
async function start() {
  await setOracleAddress();
  await pollPrompts();
}

module.exports = {
  start,
};
