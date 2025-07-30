const hre = require("hardhat");
// Import the official ethers wrapper for Sapphire
const { wrapEthersSigner } = require("@oasisprotocol/sapphire-ethers-v6");

async function main() {
  // Load environment variables from .env.testnet
  const userPrivateKey = process.env.USER_PRIVATE_KEY;
  const contractAddress = process.env.ORACLE_CONTRACT_ADDRESS;
  const prompt = "Is my confidential prompt readable by the oracle?";

  if (!userPrivateKey || !contractAddress) {
    throw new Error(
      "Please set USER_PRIVATE_KEY and ORACLE_CONTRACT_ADDRESS in your .env.testnet file",
    );
  }

  console.log("Preparing to send an encrypted prompt...");

  // 1. Create a standard ethers signer for the user.
  const userSigner = new hre.ethers.Wallet(userPrivateKey, hre.ethers.provider);

  // 2. Wrap the signer with the Sapphire wrapper.
  //    Any transaction sent with this `confidentialSigner` will be automatically encrypted.
  const confidentialSigner = wrapEthersSigner(userSigner);

  // 3. Get the ChatBot contract instance, attached to our confidential signer.
  const chatBot = await hre.ethers.getContractAt("ChatBot", contractAddress, confidentialSigner);

  console.log(`Sending prompt: "${prompt}"`);
  console.log(`To contract: ${contractAddress}`);

  // 4. Call appendPrompt. The wrapper will encrypt the `prompt` argument before sending.
  const tx = await chatBot.appendPrompt(prompt);

  console.log("Transaction sent. Waiting for receipt...");
  const receipt = await tx.wait();

  console.log("\n--- TRANSACTION SENT ---");
  console.log("This transaction hash proves the prompt was submitted.");
  console.log("Copy this hash to verify encryption on the block explorer.");
  console.log(`Transaction Hash: ${receipt.hash}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
