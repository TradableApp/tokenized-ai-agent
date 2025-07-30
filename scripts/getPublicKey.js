const { ethers } = require("ethers");
const dotenv = require("dotenv");
const fs = require("fs");

// --- Environment Loading Logic ---
// This mimics the logic in your hardhat.config.js for consistency.

// 1. Load the environment-specific file first, if specified.
const envFile = process.env.ENV_FILE;
if (envFile) {
  if (!fs.existsSync(envFile)) {
    console.error(`\n[ERROR] Environment file not found at: ${envFile}`);
    console.error("Please ensure the path is correct.\n");
    process.exit(1);
  }
  console.log(`\nLoading environment variables from: ${envFile}`);
  dotenv.config({ path: envFile });
}

// 2. Load the base .env file as a fallback.
// This will fill in any variables that were not defined in the specific file.
dotenv.config({ path: ".env" });

// --- Key Derivation Logic ---

// 3. Get the private key from the loaded environment variables.
const privateKey = process.env.PRIVATE_KEY;

// 4. Validate that the private key exists.
if (!privateKey) {
  console.error("\n[ERROR] PRIVATE_KEY not found in the environment.");
  if (envFile) {
    console.error(`Please check for PRIVATE_KEY in '${envFile}' and/or '.env'.\n`);
  } else {
    console.error("Please ensure PRIVATE_KEY is set in your .env file.\n");
  }
  process.exit(1);
}

try {
  // 5. Ensure the private key has the '0x' prefix for ethers.js.
  const formattedPrivateKey = privateKey.startsWith("0x") ? privateKey : "0x" + privateKey;

  // 6. Create a wallet instance and derive the keys.
  const wallet = new ethers.Wallet(formattedPrivateKey);

  const evmAddress = wallet.address;
  const uncompressedPublicKey = wallet.signingKey.publicKey;

  // 7. Print the results clearly.
  console.log("\n--- Derived EVM Details ---");
  console.log("  EVM Address:", evmAddress);
  console.log("  Uncompressed Public Key:", uncompressedPublicKey);
  console.log("---------------------------\n");
} catch (error) {
  console.error("\n[ERROR] Failed to derive keys. The PRIVATE_KEY may be invalid.");
  console.error("        Please ensure it is a valid 64-character hex string.\n");
  console.error("Raw Error:", error.message);
  process.exit(1);
}
