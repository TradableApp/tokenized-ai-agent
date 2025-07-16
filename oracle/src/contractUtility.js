const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env.oracle") });

// Sapphire RPC URLs (mirroring their Python defaults)
const NETWORKS = {
  sapphire: "https://sapphire.oasis.io",
  "sapphire-testnet": "https://testnet.sapphire.oasis.io",
  "sapphire-localnet": "http://localhost:8545",
};

/**
 * Sets up the ethers.js provider and signer.
 * @param {string} networkName
 * @param {string} secret
 * @returns {ethers.Wallet}
 */
function setupProviderAndSigner(networkName, secret) {
  if (!secret) {
    throw new Error("Missing required environment variable: PRIVATE_KEY");
  }

  const networkRpc = NETWORKS[networkName] || networkName;
  const provider = new ethers.JsonRpcProvider(networkRpc);
  return new ethers.Wallet(secret, provider);
}

/**
 * Loads contract ABI and bytecode from ./contracts/out/{ContractName}.sol/{ContractName}.json
 * @param {string} contractName
 * @returns {{ abi: any, bytecode: string }}
 */
function getContractArtifacts(contractName) {
  const contractPath = path.resolve(
    __dirname,
    "../../contracts/out",
    `${contractName}.sol`,
    `${contractName}.json`,
  );

  if (!fs.existsSync(contractPath)) {
    throw new Error(`Contract artifacts not found: ${contractPath}`);
  }

  const contractData = JSON.parse(fs.readFileSync(contractPath, "utf-8"));
  const { abi, bytecode } = contractData;
  return { abi, bytecode: bytecode.object };
}

module.exports = {
  setupProviderAndSigner,
  getContractArtifacts,
};
