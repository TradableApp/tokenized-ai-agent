const hre = require("hardhat");
const { ethers, upgrades } = require("hardhat");
const dotenv = require("dotenv");
const path = require("path");
const chalk = require("chalk");

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

  console.log(`\n--- Starting deployment to ${chalk.bold(networkName)} ---`);

  const [deployer] = await ethers.getSigners();
  console.log(`Deploying contracts with the account: ${deployer.address}`);

  // These constructor arguments are consistent for all contracts.
  const domain = process.env.DOMAIN;
  const treasuryAddress = process.env.TREASURY_ADDRESS;
  const oracleAddress = process.env.ORACLE_ADDRESS;

  // Validate that all necessary parameters are present.
  if (!domain || !treasuryAddress || !oracleAddress) {
    throw new Error(
      "Missing required environment variables. Please check DOMAIN, TREASURY_ADDRESS, or ORACLE_ADDRESS.",
    );
  }

  // The roflAppID is not used on-chain for the EVM version but is kept for consistency.
  const roflAppID = hre.ethers.zeroPadBytes("0x", 21);

  let aiAgent, aiAgentEscrow, aiAgentAddress, escrowAddress;
  if (isSapphire) {
    // --- SAPPHIRE DEPLOYMENT (Standard, Non-Upgradable, Two-Step Link) ---
    console.log("\nDeploying Sapphire contracts...");

    const SapphireAIAgent = await ethers.getContractFactory("SapphireAIAgent");
    const SapphireAIAgentEscrow = await ethers.getContractFactory("SapphireAIAgentEscrow");

    // Step 1: Deploy the AIAgent contract. It does not know about the escrow yet.
    aiAgent = await SapphireAIAgent.deploy(domain, roflAppID, oracleAddress, deployer.address);
    await aiAgent.waitForDeployment();
    aiAgentAddress = await aiAgent.getAddress();
    console.log(`✅ SapphireAIAgent deployed to: ${chalk.cyan(aiAgentAddress)}`);

    // Step 2: Deploy the Escrow contract, passing the agent's address.
    aiAgentEscrow = await SapphireAIAgentEscrow.deploy(
      aiAgentAddress,
      treasuryAddress,
      oracleAddress,
      deployer.address,
    );
    await aiAgentEscrow.waitForDeployment();
    escrowAddress = await aiAgentEscrow.getAddress();
    console.log(`✅ SapphireAIAgentEscrow deployed to: ${chalk.cyan(escrowAddress)}`);

    // Step 3: Complete the link by calling the setter on the AIAgent.
    console.log("Linking AI Agent to Escrow contract...");
    await aiAgent.connect(deployer).setAgentEscrow(escrowAddress);
    console.log("✅ Link successful.");
  } else {
    // --- PUBLIC EVM DEPLOYMENT (Upgradable Proxies, Two-Step Link) ---
    console.log("\nDeploying upgradable EVM contracts...");

    const EVMAIAgent = await ethers.getContractFactory("EVMAIAgent");
    const EVMAIAgentEscrow = await ethers.getContractFactory("EVMAIAgentEscrow");
    const tokenAddress = process.env.TOKEN_CONTRACT_ADDRESS;
    if (!tokenAddress) throw new Error("TOKEN_CONTRACT_ADDRESS is required for EVM deployments.");

    // Step 1: Deploy the EVMAIAgent proxy. It does not know about the escrow yet.
    console.log("Deploying EVMAIAgent proxy...");
    aiAgent = await upgrades.deployProxy(
      EVMAIAgent,
      [domain, roflAppID, oracleAddress, deployer.address],
      { initializer: "initialize", kind: "uups" },
    );
    await aiAgent.waitForDeployment();
    aiAgentAddress = await aiAgent.getAddress();
    console.log(`✅ EVMAIAgent proxy deployed to: ${chalk.cyan(aiAgentAddress)}`);

    // Step 2: Deploy the AgentEscrow proxy, passing the AI Agent's address.
    console.log("Deploying EVMAIAgentEscrow proxy...");
    aiAgentEscrow = await upgrades.deployProxy(
      EVMAIAgentEscrow,
      [tokenAddress, aiAgentAddress, treasuryAddress, oracleAddress, deployer.address],
      { initializer: "initialize", kind: "uups" },
    );
    await aiAgentEscrow.waitForDeployment();
    escrowAddress = await aiAgentEscrow.getAddress();
    console.log(`✅ EVMAIAgentEscrow proxy deployed to: ${chalk.cyan(escrowAddress)}`);

    // Step 3: Complete the link by calling the setter on the AI Agent.
    console.log("Linking AI Agent to Escrow contract...");
    await aiAgent.connect(deployer).setAgentEscrow(escrowAddress);
    console.log("✅ Link successful.");
  }

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
      console.log(`Verifying EVMAIAgent proxy on Etherscan...`);
      await hre.run("verify:verify", { address: aiAgentAddress });
      console.log(chalk.green("✅ EVMAIAgent verified successfully!"));

      console.log(`Verifying EVMAIAgentEscrow proxy on Etherscan...`);
      await hre.run("verify:verify", { address: aiAgentEscrowAddress });
      console.log(chalk.green("✅ EVMAIAgentEscrow verified successfully!"));
    } catch (error) {
      console.error(chalk.red("Verification failed:", error.message));
    }
  }

  console.log("\n--- Deployment Finished ---");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
