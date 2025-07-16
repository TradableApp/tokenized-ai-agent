const { ethers } = require("ethers");
const fetch = require("node-fetch");
const { setupProviderAndSigner, getContractArtifacts } = require("./contractUtility");
const { submitTx } = require("./roflUtility");
require("dotenv").config({ path: process.env.ENV_FILE || "./oracle/.env.oracle" });

// Set up signer, provider, and contract from contract artifacts
const signer = setupProviderAndSigner(
  process.env.NETWORK_NAME || "sapphire-testnet",
  process.env.PRIVATE_KEY,
);
const { abi } = getContractArtifacts("Oracle");
const contract = new ethers.Contract(process.env.CONTRACT_ADDRESS, abi, signer);
const provider = signer.provider;

/**
 * Ensure the Oracle address is correctly set on the contract.
 */
async function setOracleAddress() {
  const oracleAddress = await contract.oracle();
  if (oracleAddress.toLowerCase() !== signer.address.toLowerCase()) {
    console.log(`Updating oracle address from ${oracleAddress} to ${signer.address}`);
    const tx = await contract.setOracle(signer.address, {
      gasLimit: 1000000,
    });
    await tx.wait();
    console.log(`Updated oracle address to ${signer.address}`);
  } else {
    console.log(`Oracle address already correct: ${oracleAddress}`);
  }
}

/**
 * Retrieve prompts from the contract for the given address.
 * @param {string} address
 * @returns {Promise<string[]>}
 */
async function retrievePrompts(address) {
  try {
    return await contract.getPrompts("0x", address);
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
    return await contract.getAnswers("0x", address);
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
      const latestBlock = await provider.getBlockNumber();
      const logs = await contract.queryFilter(contract.filters.PromptSubmitted(), latestBlock);

      for (const log of logs) {
        const submitter = log.args.sender;
        console.log(`New prompt submitted by ${submitter}`);
        const prompts = await retrievePrompts(submitter);
        const answers = await retrieveAnswers(submitter);

        if (answers.length > 0 && answers[answers.length - 1][0] === prompts.length - 1) {
          console.log("Last prompt already answered, skipping");
          continue;
        }

        console.log("Asking chat bot...");
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
