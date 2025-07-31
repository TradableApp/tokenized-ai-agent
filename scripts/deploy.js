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
  const domain = process.env.DOMAIN;
  const privateKey = process.env.PRIVATE_KEY;

  // Validate that all necessary parameters are present.
  if (!domain || !privateKey) {
    throw new Error("Missing required environment variables. Please check DOMAIN and PRIVATE_KEY.");
  }

  // The roflAppID is not used on-chain for the EVM version but is kept for consistency.
  const roflAppID = hre.ethers.zeroPadBytes("0x", 21);

  // The oracle address is the public address of the deployer wallet.
  const oracle = new Wallet(privateKey).address;

  console.log("\nConstructor Arguments:");
  console.log(`  - Domain:        ${domain}`);
  console.log(`  - Oracle Address:  ${oracle}`);

  const ChatBotFactory = await hre.ethers.getContractFactory(contractName);
  const chatBot = await ChatBotFactory.deploy(domain, roflAppID, oracle);
  await chatBot.waitForDeployment();

  const contractAddress = await chatBot.getAddress();
  console.log(`✅ ${contractName}.sol deployed to: ${contractAddress}`);

  // --- 4. VERIFY CONTRACT (for public EVM chains only) ---
  // Verification is not applicable to Sapphire or local Hardhat networks.
  if (!isSapphire && networkName !== "hardhat") {
    if (!process.env.ETHERSCAN_API_KEY) {
      console.warn(
        chalk.yellow("\n⚠️  Skipping verification: ETHERSCAN_API_KEY not found in .env file."),
      );
      return;
    }

    console.log(
      chalk.blue(
        "\nWaiting for 60 seconds before starting verification to allow for block propagation...",
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 60000)); // 60-second delay

    try {
      console.log("Verifying contract on Basescan/Etherscan...");
      await hre.run("verify:verify", {
        address: contractAddress,
        constructorArguments: constructorArguments,
      });
      console.log(chalk.green("✅ Contract verified successfully!"));
    } catch (error) {
      console.error(chalk.red("Verification failed:", error.message));
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
