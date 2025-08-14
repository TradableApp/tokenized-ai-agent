const hre = require("hardhat");
const dotenv = require("dotenv");
const path = require("path");
const chalk = require("chalk");

// Load the specific environment file first for precedence.
if (process.env.ENV_FILE) {
  dotenv.config({ path: process.env.ENV_FILE });
}
// Load the base .env file to fill in any missing non-secret variables.
dotenv.config({ path: path.resolve(__dirname, "../.env") });

// Define which networks are Sapphire-based.
const SAPPHIRE_NETWORKS = new Set(["sapphire", "sapphire-testnet", "sapphire-localnet"]);

async function main() {
  const networkName = hre.network.name;
  const isSapphire = SAPPHIRE_NETWORKS.has(networkName);

  console.log(`\n--- Starting deployment to ${chalk.bold(networkName)} ---`);

  // Required env
  const domain = process.env.DOMAIN;
  const privateKey = process.env.PRIVATE_KEY;
  if (!domain || !privateKey) {
    throw new Error("Missing required environment variables. Please check DOMAIN or PRIVATE_KEY.");
  }

  // Use the idiomatic Hardhat way to get the deployer signer.
  const [deployer] = await hre.ethers.getSigners();

  // Derive addresses
  const oracleAddress = deployer.address;
  const treasuryAddress = process.env.TREASURY_ADDRESS || deployer.address;
  console.log(`Deploying contracts with the account: ${chalk.yellow(deployer.address)}`);
  console.log(`This address will be set as the Oracle and default Treasury.`);

  // The roflAppID is not used on-chain for the EVM version but is kept for consistency.
  const roflAppID = hre.ethers.zeroPadBytes("0x", 21);

  // --- helpers ---
  async function getSafeFees(provider) {
    const fd = await provider.getFeeData();
    // sensible floors/headroom for busy testnets (adjust if needed)
    const minPrio = hre.ethers.parseUnits("1.5", "gwei");
    const minMax = hre.ethers.parseUnits("50", "gwei");

    const maxPriorityFeePerGas =
      fd.maxPriorityFeePerGas && fd.maxPriorityFeePerGas > minPrio
        ? fd.maxPriorityFeePerGas
        : minPrio;

    // add headroom over suggested max (covers base fee spikes)
    const maxFeePerGas =
      fd.maxFeePerGas && fd.maxFeePerGas > minMax
        ? (fd.maxFeePerGas * 12n) / 10n // +20%
        : minMax;

    return { maxFeePerGas, maxPriorityFeePerGas };
  }

  async function sendWithBump(sendFn, args, opts, bumps = [1.2, 1.5]) {
    try {
      const tx = await sendFn(...args, opts);
      return await tx.wait();
    } catch (e) {
      if (!/replacement transaction underpriced/i.test(e.message || "")) throw e;
    }
    let { nonce, maxFeePerGas, maxPriorityFeePerGas } = opts;
    for (const f of bumps) {
      maxFeePerGas = (maxFeePerGas * BigInt(Math.round(f * 100))) / 100n;
      maxPriorityFeePerGas = (maxPriorityFeePerGas * BigInt(Math.round(f * 100))) / 100n;
      try {
        const tx = await sendFn(...args, { nonce, maxFeePerGas, maxPriorityFeePerGas });
        return await tx.wait();
      } catch (e) {
        if (!/replacement transaction underpriced/i.test(e.message || "")) throw e;
      }
    }
    throw new Error("Could not replace tx with a sufficiently higher fee.");
  }

  // Hardhat's ethers provider doesn't implement waitForTransaction; poll receipt instead.
  async function waitDeployed(contract) {
    await contract.waitForDeployment();
    const tx = await contract.deploymentTransaction?.();
    if (!tx?.hash) return;
    // poll until we get a receipt
    let receipt = null;
    while (!receipt) {
      receipt = await hre.ethers.provider.getTransactionReceipt(tx.hash);
      if (!receipt) await new Promise((r) => setTimeout(r, 1000));
    }
    // (optional) ensure at least 1 confirmation
    while ((await hre.ethers.provider.getBlockNumber()) < (receipt.blockNumber || 0) + 1) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  let aiAgent, aiAgentEscrow, aiAgentAddress, aiAgentEscrowAddress;

  if (isSapphire) {
    // --- SAPPHIRE DEPLOYMENT (Standard, Non-Upgradable, Two-Step Link) ---
    console.log("\nDeploying Sapphire contracts...");

    const SapphireAIAgent = await hre.ethers.getContractFactory("SapphireAIAgent", deployer);
    const SapphireAIAgentEscrow = await hre.ethers.getContractFactory(
      "SapphireAIAgentEscrow",
      deployer,
    );

    // Step 1: Deploy the AIAgent contract. It does not know about the escrow yet.
    aiAgent = await SapphireAIAgent.deploy(domain, roflAppID, oracleAddress, deployer.address);
    await waitDeployed(aiAgent);
    aiAgentAddress = await aiAgent.getAddress();
    console.log(`✅ SapphireAIAgent deployed to: ${chalk.cyan(aiAgentAddress)}`);

    // Step 2: Deploy the Escrow contract, passing the agent's address.
    aiAgentEscrow = await SapphireAIAgentEscrow.deploy(
      aiAgentAddress,
      treasuryAddress,
      oracleAddress,
      deployer.address,
    );
    await waitDeployed(aiAgentEscrow);
    aiAgentEscrowAddress = await aiAgentEscrow.getAddress();
    console.log(`✅ SapphireAIAgentEscrow deployed to: ${chalk.cyan(aiAgentEscrowAddress)}`);

    // Step 3: Complete the link by calling the setter on the AIAgent.
    console.log("Linking AI Agent to Escrow contract...");
    const nonce = await hre.ethers.provider.getTransactionCount(deployer.address, "pending");
    const fees = await getSafeFees(hre.ethers.provider);
    await sendWithBump(aiAgent.setAgentEscrow, [aiAgentEscrowAddress], { nonce, ...fees });
    console.log("✅ Link successful.");
  } else {
    // --- PUBLIC EVM DEPLOYMENT (Upgradable Proxies, Two-Step Link) ---
    console.log("\nDeploying or upgrading upgradable EVM contracts...");

    const EVMAIAgent = await hre.ethers.getContractFactory("EVMAIAgent", deployer);
    const EVMAIAgentEscrow = await hre.ethers.getContractFactory("EVMAIAgentEscrow", deployer);

    // Read existing proxy addresses from the .env file.
    const existingAIAgentAddress = process.env.AI_AGENT_CONTRACT_ADDRESS;
    const existingAIAgentEscrowAddress = process.env.AI_AGENT_ESCROW_CONTRACT_ADDRESS;

    // --- Logic for AI Agent Contract ---
    if (existingAIAgentAddress) {
      console.log(`Found existing EVMAIAgent at: ${chalk.yellow(existingAIAgentAddress)}`);
      console.log("Checking for EVMAIAgent upgrade...");
      aiAgent = await hre.upgrades.upgradeProxy(existingAIAgentAddress, EVMAIAgent);
      await waitDeployed(aiAgent);
      aiAgentAddress = await aiAgent.getAddress();
      console.log(`✅ EVMAIAgent is up-to-date at: ${chalk.cyan(aiAgentAddress)}`);
    } else {
      console.log("Deploying EVMAIAgent proxy...");
      aiAgent = await hre.upgrades.deployProxy(
        EVMAIAgent,
        [domain, roflAppID, oracleAddress, deployer.address],
        { initializer: "initialize", kind: "uups" },
      );
      await waitDeployed(aiAgent);
      aiAgentAddress = await aiAgent.getAddress();
      console.log(`✅ EVMAIAgent proxy deployed to: ${chalk.cyan(aiAgentAddress)}`);
    }

    // --- Logic for AI Agent Escrow Contract ---
    if (existingAIAgentEscrowAddress) {
      console.log(
        `Found existing EVMAIAgentEscrow at: ${chalk.yellow(existingAIAgentEscrowAddress)}`,
      );
      console.log("Checking for EVMAIAgentEscrow upgrade...");
      aiAgentEscrow = await hre.upgrades.upgradeProxy(
        existingAIAgentEscrowAddress,
        EVMAIAgentEscrow,
      );
      await waitDeployed(aiAgentEscrow);
      aiAgentEscrowAddress = await aiAgentEscrow.getAddress();
      console.log(`✅ EVMAIAgentEscrow is up-to-date at: ${chalk.cyan(aiAgentEscrowAddress)}`);
    } else {
      console.log("Deploying EVMAIAgentEscrow proxy...");
      const tokenAddress = process.env.TOKEN_CONTRACT_ADDRESS;
      if (!tokenAddress)
        throw new Error("TOKEN_CONTRACT_ADDRESS is required for a new EVM deployment.");

      aiAgentEscrow = await hre.upgrades.deployProxy(
        EVMAIAgentEscrow,
        [tokenAddress, aiAgentAddress, treasuryAddress, oracleAddress, deployer.address],
        { initializer: "initialize", kind: "uups" },
      );
      await waitDeployed(aiAgentEscrow);
      aiAgentEscrowAddress = await aiAgentEscrow.getAddress();
      console.log(`✅ EVMAIAgentEscrow proxy deployed to: ${chalk.cyan(aiAgentEscrowAddress)}`);

      // The linking step only needs to be done once during the initial deployment of the agent.
      // We check if the agent's escrow address is already set.
      const currentEscrow = await aiAgent.aiAgentEscrow();
      if (currentEscrow === hre.ethers.ZeroAddress) {
        console.log("Linking AI Agent to Escrow contract...");
        const nonce = await hre.ethers.provider.getTransactionCount(deployer.address, "pending");
        const fees = await getSafeFees(hre.ethers.provider);
        await sendWithBump(aiAgent.setAgentEscrow, [aiAgentEscrowAddress], { nonce, ...fees });
        console.log("✅ Link successful.");
      }
    }
  }

  // --- 4. VERIFY CONTRACT (for public EVM chains only) ---
  if (!isSapphire && networkName !== "hardhat") {
    if (!process.env.ETHERSCAN_API_KEY) {
      console.warn(
        chalk.yellow("\n⚠️  Skipping verification: ETHERSCAN_API_KEY not found in .env file."),
      );
    } else {
      console.log(
        chalk.blue(
          "\nWaiting for 60 seconds before starting verification to allow for block propagation...",
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 60000));

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
  }

  console.log("\n--- Deployment Finished ---");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
