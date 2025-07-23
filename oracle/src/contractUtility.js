const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
const { wrapEthersProvider, wrapEthersSigner } = require("@oasisprotocol/sapphire-ethers-v6");
require("dotenv").config({ path: path.resolve(__dirname, "../.env.oracle") });

// A map of supported network names to their corresponding RPC URLs.
const NETWORKS = {
  sapphire: process.env.SAPPHIRE_MAINNET_RPC,
  "sapphire-testnet": process.env.SAPPHIRE_TESTNET_RPC,
  "sapphire-localnet": process.env.SAPPHIRE_LOCALNET_RPC,
};

/**
 * Sets up and configures the ethers.js provider and signer for Oasis Sapphire.
 *
 * It creates a standard ethers.js provider and signer, then wraps them using the
 * `@oasisprotocol/sapphire-ethers-v6` library. This wrapping is essential to enable
 * automatic encryption and decryption for confidential state and transactions on Sapphire.
 *
 * @param {string} networkName - The name of the target network.
 * @param {string} privateKey - The private key of the wallet to be used as the signer.
 * @returns {{provider: ethers.Provider, signer: ethers.Signer}} An object containing the Sapphire-wrapped provider and signer.
 */
function setupProviderAndSigner(networkName, privateKey) {
  if (!privateKey) {
    throw new Error("Missing required environment variable: PRIVATE_KEY");
  }

  const networkRpc = NETWORKS[networkName];
  if (!networkRpc) {
    throw new Error(`Unknown or unconfigured network: ${networkName}`);
  }

  // Create the standard, unwrapped provider and signer.
  const baseProvider = new ethers.JsonRpcProvider(networkRpc);
  const baseSigner = new ethers.Wallet(privateKey, baseProvider);

  // Wrap the provider and signer with Sapphire-specific functionality.
  const wrappedProvider = wrapEthersProvider(baseProvider);
  const wrappedSigner = wrapEthersSigner(baseSigner);

  return { provider: wrappedProvider, signer: wrappedSigner };
}

/**
 * Loads the ABI and bytecode for a given smart contract from the Hardhat artifacts directory.
 * @param {string} contractName - The name of the contract (e.g., 'ChatBot').
 * @returns {{abi: object, bytecode: string}} An object containing the contract's ABI and bytecode.
 * @throws {Error} If the contract artifact file cannot be found.
 */
function getContractArtifacts(contractName) {
  // Construct the absolute path to the contract's JSON artifact file.
  // Assumes this script is run from a location where `../../artifacts` is the correct path.
  const contractPath = path.resolve(
    __dirname,
    "../../artifacts/contracts",
    `${contractName}.sol`,
    `${contractName}.json`,
  );

  if (!fs.existsSync(contractPath)) {
    throw new Error(
      `Contract artifacts not found at: ${contractPath}. Please ensure contracts are compiled.`,
    );
  }

  const contractData = JSON.parse(fs.readFileSync(contractPath, "utf-8"));
  const { abi, bytecode } = contractData;

  return { abi, bytecode };
}

module.exports = {
  setupProviderAndSigner,
  getContractArtifacts,
};
