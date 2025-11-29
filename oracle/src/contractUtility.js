const dotenv = require("dotenv");
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const { wrapEthersProvider, wrapEthersSigner } = require("@oasisprotocol/sapphire-ethers-v6");

// Load the specific environment file first for precedence.
if (process.env.ENV_FILE) {
  dotenv.config({ path: process.env.ENV_FILE });
}
// Load the base .env.oracle file to fill in any missing non-secret variables.
dotenv.config({ path: path.resolve(__dirname, "../.env.oracle") });

// A Set for easy and efficient checking of Sapphire network names.
const SAPPHIRE_NETWORKS = new Set(["sapphire", "sapphire-testnet", "sapphire-localnet"]);

// A map of all supported networks to their corresponding RPC URL from the .env file.
const RPC_URL_MAP = {
  sapphire: process.env.SAPPHIRE_MAINNET_RPC,
  "sapphire-testnet": process.env.SAPPHIRE_TESTNET_RPC,
  "sapphire-localnet": process.env.SAPPHIRE_LOCALNET_RPC,
  base: process.env.BASE_MAINNET_RPC,
  baseSepolia: process.env.BASE_SEPOLIA_TESTNET_RPC,
};

/**
 * An internal helper to load a contract's ABI from the artifacts directory.
 * @param {string} contractName The name of the contract (e.g., 'EVMAIAgent').
 * @returns {{abi: object}} An object containing the contract's ABI.
 * @throws {Error} If the contract artifact file cannot be found.
 */
function loadContractArtifact(contractName) {
  const contractPath = path.resolve(
    __dirname,
    "../../artifacts/contracts",
    `${contractName}.sol`,
    `${contractName}.json`,
  );
  if (!fs.existsSync(contractPath)) {
    throw new Error(
      `Contract artifacts not found for "${contractName}" at: ${contractPath}. Please compile the contracts first.`,
    );
  }
  const { abi } = JSON.parse(fs.readFileSync(contractPath, "utf-8"));
  return { abi };
}

/**
 * Initializes and configures the provider, signer, and contract instance for the oracle.
 * This is the single, unified entry point for all environment-specific setup, encapsulating
 * the logic for handling different blockchain environments.
 *
 * @param {string} networkName - The name of the target network (e.g., 'sapphire-testnet', 'baseSepolia').
 * @param {string} privateKey - The private key of the oracle's wallet.
 * @param {string} contractAddress - The address of the deployed AIAgent contract.
 * @returns {{
 *   provider: ethers.Provider,
 *   signer: ethers.Signer,
 *   contract: ethers.Contract,
 *   isSapphire: boolean
 * }} A comprehensive setup object containing everything the oracle needs to operate.
 */
function initializeOracle(networkName, privateKey, contractAddress) {
  if (!privateKey) {
    throw new Error("Missing required env variable: PRIVATE_KEY");
  }

  if (!contractAddress) {
    throw new Error("Missing required env variable: AI_AGENT_CONTRACT_ADDRESS");
  }

  const networkRpc = RPC_URL_MAP[networkName];
  if (!networkRpc) {
    throw new Error(
      `RPC URL for network "${networkName}" not found. Check your .env configuration.`,
    );
  }

  const isSapphire = SAPPHIRE_NETWORKS.has(networkName);
  const contractName = isSapphire ? "SapphireAIAgent" : "EVMAIAgent";
  const { abi } = loadContractArtifact(contractName);

  let provider = new ethers.JsonRpcProvider(networkRpc);

  // Force polling instead of filters to avoid "filter not found" errors.
  provider.pollingInterval = 4000; // Check every 4 seconds (adjust based on chain block time)

  let signer = new ethers.Wallet(privateKey, provider);

  // Conditionally wrap the signer and provider for Sapphire networks.
  if (isSapphire) {
    provider = wrapEthersProvider(provider);
    signer = wrapEthersSigner(signer);
  }

  const contract = new ethers.Contract(contractAddress, abi, signer);

  return { provider, signer, contract, isSapphire };
}

module.exports = {
  initializeOracle,
  // Export internal functions for testing purposes
  loadContractArtifact,
};
