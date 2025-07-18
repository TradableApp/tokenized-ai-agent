const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
const { wrapEthersProvider, wrapEthersSigner } = require("@oasisprotocol/sapphire-ethers-v6");
require("dotenv").config({ path: path.resolve(__dirname, "../.env.oracle") });

const NETWORKS = {
  sapphire: process.env.SAPPHIRE_MAINNET_RPC,
  "sapphire-testnet": process.env.SAPPHIRE_TESTNET_RPC,
  "sapphire-localnet": process.env.SAPPHIRE_LOCALNET_RPC,
};

/**
 * Sets up the ethers.js provider and signer for a NodeJS backend.
 * @param {string} networkName
 * @param {string} secret
 * @returns {ethers.Wallet}
 */
function setupProviderAndSigner(networkName, secret) {
  if (!secret) {
    throw new Error("Missing required environment variable: PRIVATE_KEY");
  }

  const networkRpc = NETWORKS[networkName];
  if (!networkRpc) throw new Error(`Unknown network: ${networkName}`);

  // Create the base, unwrapped provider and signer
  const baseProvider = new ethers.JsonRpcProvider(networkRpc);
  const baseSigner = new ethers.Wallet(secret, baseProvider);

  // Create the wrapped provider for reading confidential state
  const wrappedProvider = wrapEthersProvider(baseProvider);

  // Create the wrapped signer for sending confidential transactions
  const wrappedSigner = wrapEthersSigner(baseSigner);

  return { provider: wrappedProvider, signer: wrappedSigner };
}

/**
 * Loads contract ABI and bytecode from ./contracts/out/{ContractName}.sol/{ContractName}.json
 * @param {string} contractName
 * @returns {{ abi: any, bytecode: string }}
 */
function getContractArtifacts(contractName) {
  const contractPath = path.resolve(
    __dirname,
    "../../artifacts/contracts",
    `${contractName}.sol`,
    `${contractName}.json`,
  );

  if (!fs.existsSync(contractPath)) {
    throw new Error(`Contract artifacts not found: ${contractPath}`);
  }

  const contractData = JSON.parse(fs.readFileSync(contractPath, "utf-8"));
  const { abi, bytecode } = contractData;

  return { abi, bytecode };
}

module.exports = {
  setupProviderAndSigner,
  getContractArtifacts,
};
