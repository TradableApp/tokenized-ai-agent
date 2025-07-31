const hre = require("hardhat");
const { Wallet } = require("ethers");
const dotenv = require("dotenv");
const path = require("path");

// Load the specific environment file first for precedence.
if (process.env.ENV_FILE) {
  dotenv.config({ path: process.env.ENV_FILE });
}
// Load the base .env file to fill in any missing non-secret variables.
dotenv.config({ path: path.resolve(__dirname, ".env") });

// Define which networks are Sapphire-based.
const SAPPHIRE_NETWORKS = new Set(["sapphire", "sapphire-testnet", "sapphire-localnet"]);

async function main() {
  const networkName = hre.network.name;
  const isSapphire = SAPPHIRE_NETWORKS.has(networkName);
  const contractName = isSapphire ? "SapphireChatBot" : "EVMChatBot";

  console.log(`Deploying ${contractName}.sol to the ${networkName} network...`);

  // These constructor arguments are consistent for both contracts.
  const domain = process.env.DOMAIN || "example.com";
  // The roflAppID is not used on-chain for the EVM version but is kept for consistency.
  const roflAppID = hre.ethers.zeroPadBytes("0x", 21);

  const wallet = new Wallet(process.env.PRIVATE_KEY);
  const oracle = wallet.address;

  console.log("Constructor arguments:");
  console.log("  - Oracle Address:", oracle);
  console.log("  - Domain:", domain);

  const ChatBotFactory = await hre.ethers.getContractFactory(contractName);
  const chatBot = await ChatBotFactory.deploy(domain, roflAppID, oracle);
  await chatBot.waitForDeployment();

  const contractAddress = await chatBot.getAddress();
  console.log(`✅ ${contractName}.sol deployed to: ${contractAddress}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
