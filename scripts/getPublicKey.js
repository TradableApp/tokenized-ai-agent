const { ethers } = require("ethers");
const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");

// --- Environment Loading ---
// This script derives the public key from the PRIVATE_KEY in a given .env file.
// It uses the same robust, two-step loading strategy as the rest of the project.

const envFile = process.env.ENV_FILE;
const baseEnvFile = path.resolve(__dirname, "../.env");

// 1. Load the base .env file first to establish default values.
// We use `quiet` to prevent warnings if this file is optional for the user.
dotenv.config({ path: baseEnvFile });

// 2. Load the specific environment file, if provided.
// Its values will override any values from the base file.
if (envFile) {
  if (!fs.existsSync(envFile)) {
    console.error(`\n❌ Error: Environment file not found at: ${envFile}`);
    process.exit(1);
  }
  console.log(`\n🔐 Loading secrets from: ${envFile}`);
  dotenv.config({ path: envFile, override: true });
}

// --- Key Derivation ---
const privateKey = process.env.PRIVATE_KEY;

if (!privateKey) {
  console.error("\n❌ Error: PRIVATE_KEY not found in the environment.");
  console.error("   Please ensure PRIVATE_KEY is set in your .env file or the specified ENV_FILE.");
  process.exit(1);
}

try {
  // Ethers.js requires the private key to have a '0x' prefix.
  const formattedPrivateKey = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;

  // Create a wallet instance from the private key.
  const wallet = new ethers.Wallet(formattedPrivateKey);

  // Derive the corresponding address and uncompressed public key.
  const evmAddress = wallet.address;
  const uncompressedPublicKey = wallet.signingKey.publicKey;

  console.log("\n--- Derived EVM Details ---");
  console.log(`  🔑 EVM Address:          ${evmAddress}`);
  console.log(`  🔷 Uncompressed Public Key: ${uncompressedPublicKey}`);
  console.log("---------------------------\n");
  console.log(
    "💡 The Uncompressed Public Key is what you should use for the PUBLIC_KEY variable.\n",
  );
} catch (error) {
  console.error("\n❌ Error: Failed to derive keys. The provided PRIVATE_KEY is likely invalid.");
  console.error("   Please ensure it is a valid 64-character hex string.");
  process.exit(1);
}
