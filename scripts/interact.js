const { ethers, Contract, Signature } = require("ethers");

const { wrapEthersSigner } = require("@oasisprotocol/sapphire-ethers-v6");
const ethCrypto = require("eth-crypto");
const inquirer = require("inquirer");
const ora = require("ora");
const chalk = require("chalk");
const { SiweMessage } = require("siwe");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const dotenv = require("dotenv");

// --- Configuration ---
const envPath = path.resolve(__dirname, "../.env");
const CHAINS = {
  Sapphire: {
    isSapphire: true,
    networks: {
      testnet: { envFile: "../.env.testnet", rpcEnvVar: "SAPPHIRE_TESTNET_RPC" },
      mainnet: { envFile: "../.env.mainnet", rpcEnvVar: "SAPPHIRE_MAINNET_RPC" },
      localnet: { envFile: "../.env.localnet", rpcEnvVar: "SAPPHIRE_LOCALNET_RPC" },
    },
  },
  Base: {
    isSapphire: false,
    networks: {
      testnet: { envFile: "../.env.base-testnet", rpcEnvVar: "BASE_SEPOLIA_TESTNET_RPC" },
      mainnet: { envFile: "../.env.base-mainnet", rpcEnvVar: "BASE_MAINNET_RPC" },
    },
  },
};
const POLLING_INTERVAL_MS = 5000;

// --- Global State ---
let signer;
let contract;
let isSapphire;
let networkName;
let roflPublicKey;
let sapphireAuthToken; // Only used by the Sapphire workflow

// --- Utility Functions ---

/**
 * @description Loads the contract's ABI from the artifacts directory.
 * @param {string} contractName The name of the contract (e.g., 'EVMChatBot').
 * @returns {{abi: object}} An object containing the contract's ABI.
 * @throws {Error} If the artifact JSON file cannot be found.
 */
function loadContractArtifact(contractName) {
  const contractPath = path.resolve(
    __dirname,
    `../artifacts/contracts/${contractName}.sol/${contractName}.json`,
  );
  if (!fs.existsSync(contractPath)) {
    throw new Error(
      `Contract artifacts for "${contractName}" not found. Please run 'npm run compile'.`,
    );
  }
  return JSON.parse(fs.readFileSync(contractPath, "utf-8"));
}

/**
 * [SAPPHIRE ONLY]
 * @description Authenticates with the smart contract using Sign-In with Ethereum (SIWE).
 * This provides a session token required for subsequent contract interactions.
 * @param {number} chainId - The chain ID of the connected network.
 * @returns {Promise<string>} The authentication token from the contract.
 * @throws {Error} If the SIWE login process fails.
 */
async function loginSiwe(chainId) {
  const spinner = ora("Authenticating with contract via Sign-In with Ethereum (SIWE)...").start();
  try {
    const domain = await contract.domain();
    const address = await signer.getAddress();
    const siweMessage = new SiweMessage({
      domain,
      address,
      uri: `http://${domain}`,
      version: "1",
      chainId,
    }).toMessage();
    const signatureString = await signer.signMessage(siweMessage);
    const signature = Signature.from(signatureString);
    const retrievedAuthToken = await contract.login(siweMessage, signature);
    spinner.succeed(chalk.green("Successfully authenticated with the contract."));
    return retrievedAuthToken;
  } catch (error) {
    spinner.fail(chalk.red("SIWE Authentication failed!"));
    throw error;
  }
}

/**
 * [EVM ONLY]
 * @description A helper to remove the '0x04' or '04' prefix from a public key string,
 * preparing it for use with the eth-crypto library.
 * @param {string} publicKey - The public key string.
 * @returns {string} The cleaned, raw public key.
 */
function cleanPublicKey(publicKey) {
  if (publicKey.startsWith("0x04")) {
    return publicKey.slice(4);
  }
  if (publicKey.startsWith("04")) {
    return publicKey.slice(2);
  }
  return publicKey;
}

/**
 * [EVM ONLY]
 * @description Ensures a hex string has a '0x' prefix, which is required by ethers.js for `bytes` types.
 * @param {string} hexString - The hex string.
 * @returns {string} The hex string with a '0x' prefix.
 */
function ensure0xPrefix(hexString) {
  return hexString.startsWith("0x") ? hexString : `0x${hexString}`;
}

/**
 * [EVM ONLY]
 * @description Removes the '0x' prefix from a hex string, which is required by eth-crypto.
 * @param {string} hexString - The hex string, which may or may not have a '0x' prefix.
 * @returns {string} The raw hex string without the '0x' prefix.
 */
function strip0xPrefix(hexString) {
  return hexString.startsWith("0x") ? hexString.slice(2) : hexString;
}

/**
 * [EVM ONLY]
 * @description Encrypts a plaintext prompt for the user and the ROFL oracle.
 * @param {string} plaintext - The user's prompt.
 * @returns {Promise<object>} An object containing the three encrypted parts for the contract call.
 */
async function encryptPrompt(plaintext) {
  const sessionKey = ethCrypto.createIdentity().privateKey;
  const sessionPublicKey = ethCrypto.publicKeyByPrivateKey(sessionKey);

  // Use the helper functions to safely clean the keys.
  const userPublicKeyClean = cleanPublicKey(signer.signingKey.publicKey);
  const roflPublicKeyClean = cleanPublicKey(roflPublicKey);
  const sessionPublicKeyClean = cleanPublicKey(sessionPublicKey);

  const encryptedContent = await ethCrypto.encryptWithPublicKey(sessionPublicKeyClean, plaintext);
  const userEncryptedKey = await ethCrypto.encryptWithPublicKey(userPublicKeyClean, sessionKey);
  const roflEncryptedKey = await ethCrypto.encryptWithPublicKey(roflPublicKeyClean, sessionKey);

  // Use the helper function to safely format the output for ethers.js.
  return {
    encryptedContent: ensure0xPrefix(ethCrypto.cipher.stringify(encryptedContent)),
    userEncryptedKey: ensure0xPrefix(ethCrypto.cipher.stringify(userEncryptedKey)),
    roflEncryptedKey: ensure0xPrefix(ethCrypto.cipher.stringify(roflEncryptedKey)),
  };
}

/**
 * [EVM ONLY]
 * @description Decrypts an EncryptedMessage or EncryptedAnswer struct.
 * @param {object} encryptedMessage - The struct fetched from the contract.
 * @returns {Promise<string>} The decrypted plaintext.
 */
async function decryptMessage(encryptedMessage) {
  const userPrivateKey = signer.privateKey;
  // Use the helper to safely remove the "0x" prefix before parsing.
  const parsedUserKey = ethCrypto.cipher.parse(strip0xPrefix(encryptedMessage.userEncryptedKey));
  const parsedContent = ethCrypto.cipher.parse(strip0xPrefix(encryptedMessage.encryptedContent));

  const sessionKey = await ethCrypto.decryptWithPrivateKey(userPrivateKey, parsedUserKey);
  return await ethCrypto.decryptWithPrivateKey(sessionKey, parsedContent);
}

/**
 * @description Creates a delay that can be interrupted by a condition.
 * It checks the condition frequently, allowing for a responsive exit.
 * @param {number} ms - The total milliseconds to wait.
 * @param {() => boolean} shouldStop - A function that returns true to interrupt the sleep.
 * @returns {Promise<boolean>} True if the sleep was interrupted, false otherwise.
 */
async function interruptibleSleep(ms, shouldStop) {
  const interval = 100; // Check for interruption every 100ms
  const loops = ms / interval;
  for (let i = 0; i < loops; i++) {
    if (shouldStop()) return true;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return shouldStop();
}

/**
 * @description Polls the contract for an answer to a specific prompt and allows the user
 * to skip waiting by pressing the 's' key.
 * @param {number} promptId - The ID of the prompt to wait for.
 */
async function waitForAnswer(promptId) {
  let userSkipped = false;
  const keypressHandler = (_, key) => {
    if (key?.name === "s") userSkipped = true;
    if (key?.ctrl && key?.name === "c") process.exit();
  };

  const spinner = ora(chalk.yellow(`Waiting for AI response... (Press 's' to skip)`)).start();

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on("keypress", keypressHandler);
  process.stdin.resume();

  try {
    while (!userSkipped) {
      const address = await signer.getAddress();
      const rawAnswers = isSapphire
        ? await contract.getAnswers(sapphireAuthToken, address)
        : await contract.getAnswers(address);

      const answerStruct = rawAnswers.find((answer) => Number(answer.promptId) === promptId);
      if (answerStruct) {
        let cleanAnswer;
        if (isSapphire) {
          cleanAnswer = answerStruct.answer.replaceAll(/<think>.*<\/think>/gs, "").trim();
        } else {
          spinner.text = "Decrypting response...";
          cleanAnswer = await decryptMessage(answerStruct.message);
        }

        spinner.succeed(chalk.green("AI response received!"));
        console.log(`   ${chalk.green.bold("Answer:")} ${chalk.green(cleanAnswer)}`);

        return;
      }

      // CORRECTED: Call the superior interruptibleSleep function.
      const wasSkipped = await interruptibleSleep(POLLING_INTERVAL_MS, () => userSkipped);
      if (wasSkipped) break;
    }
  } finally {
    // Critical cleanup: always restore the terminal to its normal state.
    process.stdin.removeListener("keypress", keypressHandler);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
  }

  if (userSkipped) {
    spinner.stopAndPersist({
      symbol: "➡️",
      text: chalk.bold(" Skipped. You can check for the answer later."),
    });
  }
}

/**
 * @description Prompts the user for a new message, sends it to the contract,
 * and then waits for the AI's response.
 */
async function handleSendPrompt() {
  console.log("");
  const { prompt } = await inquirer.prompt([
    {
      type: "input",
      name: "prompt",
      message: "Enter your confidential prompt:",
      validate: (input) => (input ? true : "Prompt cannot be empty."),
    },
  ]);

  const spinner = ora("Sending encrypted prompt to the contract...").start();

  try {
    let tx;
    if (isSapphire) {
      tx = await contract.appendPrompt(prompt);
    } else {
      const { encryptedContent, userEncryptedKey, roflEncryptedKey } = await encryptPrompt(prompt);

      tx = await contract.appendPrompt(encryptedContent, userEncryptedKey, roflEncryptedKey);
    }

    spinner.text = "Waiting for transaction to be mined...";

    const receipt = await tx.wait();

    const promptsCount = isSapphire
      ? await contract.getPromptsCount(sapphireAuthToken, signer.address)
      : await contract.getPromptsCount(signer.address);
    const newPromptId = promptsCount - 1n;

    spinner.succeed(chalk.green("Prompt sent successfully!"));
    console.log(`   - Transaction Hash: ${chalk.cyan(receipt.hash)}`);

    await waitForAnswer(Number(newPromptId));
  } catch (error) {
    spinner.fail(chalk.red("Failed to send prompt."));
    console.error(error.message);
  }
}

/**
 * @description Fetches and displays all of the user's past prompts and any available answers.
 */
async function handleCheckAnswers() {
  const spinner = ora("Fetching prompts and answers...").start();
  try {
    const address = await signer.getAddress();
    const [prompts, answers] = await Promise.all([
      isSapphire ? contract.getPrompts(sapphireAuthToken, address) : contract.getPrompts(address),
      isSapphire ? contract.getAnswers(sapphireAuthToken, address) : contract.getAnswers(address),
    ]);

    spinner.succeed(chalk.green("Data fetched successfully."));
    console.log("\n--- Your Prompts and Answers ---");

    if (prompts.length === 0) {
      console.log(chalk.yellow("You haven't sent any prompts yet."));
      return;
    }

    spinner.start("Decrypting conversation history...");
    const plaintextPrompts = isSapphire ? prompts : await Promise.all(prompts.map(decryptMessage));

    // Use a Map to efficiently align answers with their prompts by ID.
    const answersMap = new Map();

    if (isSapphire) {
      answers.forEach((a) =>
        answersMap.set(Number(a.promptId), a.answer.replaceAll(/<think>.*<\/think>/gs, "").trim()),
      );
    } else {
      const decryptedAnswers = await Promise.all(
        answers.map(async (a) => ({
          promptId: Number(a.promptId),
          answer: await decryptMessage(a.message),
        })),
      );

      decryptedAnswers.forEach((a) => answersMap.set(a.promptId, a.answer));
    }

    spinner.stop();

    plaintextPrompts.forEach((prompt, index) => {
      const answer = answersMap.get(index);
      console.log(`\n #${index + 1}:`);
      console.log(`   ${chalk.bold("Prompt:")} ${prompt}`);

      if (answer) {
        console.log(`   ${chalk.green.bold("Answer:")} ${chalk.green(answer)}`);
      } else {
        console.log(
          `   ${chalk.yellow.bold("Answer:")} ${chalk.yellow("(Awaiting response from oracle...)")}`,
        );
      }
    });
  } catch (error) {
    spinner.fail(chalk.red("Failed to fetch data."));
    console.error(error.message);
  }
}

/**
 * @description Sends a transaction to clear all of the user's prompts and answers from the contract.
 */
async function handleClearPrompts() {
  console.log("");
  const { confirmed } = await inquirer.prompt([
    {
      type: "confirm",
      name: "confirmed",
      message: chalk.yellow(
        "Are you sure you want to permanently clear all your prompts and answers from the contract?",
      ),
      default: false,
    },
  ]);

  if (!confirmed) {
    console.log("Operation cancelled.");
    return;
  }

  const spinner = ora("Sending transaction to clear your data...").start();
  try {
    // Manually set a high gas limit to overcome potential estimation issues.
    const tx = await contract.clearPrompt({ gasLimit: 10_000_000 });
    spinner.text = "Waiting for transaction to be mined...";
    const receipt = await tx.wait();
    spinner.succeed(chalk.green("Your prompts and answers have been cleared."));
    console.log(`   - Transaction Hash: ${chalk.cyan(receipt.hash)}`);
  } catch (error) {
    spinner.fail(chalk.red("Failed to clear data."));
    console.error(error);
  }
}

/**
 * @description Fetches and displays the user's current wallet balance.
 */
async function handleCheckBalance() {
  const spinner = ora("Fetching wallet balance...").start();
  try {
    const address = await signer.getAddress();
    const balanceWei = await signer.provider.getBalance(address);
    const balance = ethers.formatEther(balanceWei);

    // This logic was already correctly implemented in main(), we bring it here for consistency.
    const chainName = Object.keys(CHAINS).find((cn) => CHAINS[cn].isSapphire === isSapphire);
    const CURRENCY_SYMBOLS = {
      Sapphire: { mainnet: "ROSE", default: "TEST" },
      Base: { default: "ETH" },
    };
    const currency =
      CURRENCY_SYMBOLS[chainName]?.[networkName] || CURRENCY_SYMBOLS[chainName]?.default || "TOKEN";

    spinner.succeed(chalk.green("Balance updated:"));
    console.log(`   - Wallet: ${chalk.yellow(address)}`);
    console.log(`   - Balance: ${chalk.bold(balance)} ${currency}`);
  } catch (error) {
    spinner.fail(chalk.red("Failed to fetch balance."));
    console.error(error.message);
  }
}

/**
 * @description Displays the main interactive menu and handles user selections in a loop.
 */
async function mainMenu() {
  while (true) {
    console.log("");
    const { action } = await inquirer.prompt([
      {
        type: "list",
        name: "action",
        message: "What would you like to do?",
        choices: [
          "Send a new prompt",
          "Check for new answers",
          "Check wallet balance",
          "Clear my prompts and answers",
          new inquirer.Separator(),
          "Exit",
        ],
      },
    ]);

    switch (action) {
      case "Send a new prompt":
        await handleSendPrompt();
        break;
      case "Check for new answers":
        await handleCheckAnswers();
        break;
      case "Check wallet balance":
        await handleCheckBalance();
        break;
      case "Clear my prompts and answers":
        await handleClearPrompts();
        break;
      case "Exit":
        console.log(chalk.bold("\nGoodbye!\n"));
        return;
    }
  }
}

/**
 * @description Main entry point for the CLI application. Handles setup, login,
 * contract instantiation, and kicks off the main menu.
 */
async function main() {
  console.log("\nWelcome to the Tradable AI Agent CLI!");
  console.log("=====================================");

  try {
    // Load base .env file for shared configuration like RPC URLs.
    if (fs.existsSync(envPath)) {
      require("dotenv").config({ path: envPath, quiet: true });
    }

    // --- Step 1: Network Selection ---
    const { chainName } = await inquirer.prompt([
      {
        type: "list",
        name: "chainName",
        message: "Choose a chain:",
        choices: Object.keys(CHAINS),
      },
    ]);
    const selectedChain = CHAINS[chainName];
    isSapphire = selectedChain.isSapphire;

    const { networkChoice } = await inquirer.prompt([
      {
        type: "list",
        name: "networkChoice",
        message: `Choose a network for ${chainName}:`,
        choices: Object.keys(selectedChain.networks),
      },
    ]);
    networkName = networkChoice;
    const selectedNetwork = selectedChain.networks[networkName];

    // --- Step 2: Environment and Wallet Setup ---
    const envFilePath = path.resolve(__dirname, selectedNetwork.envFile);
    if (!fs.existsSync(envFilePath)) {
      throw new Error(
        `Environment file not found at: ${envFilePath}\nPlease create it before proceeding.`,
      );
    }
    // Load the specific environment file, which will override any base values.
    dotenv.config({ path: envFilePath, override: true, quiet: true });
    console.log(`> Loaded configuration for: ${chalk.bold(networkName)}`);

    console.log("\n--- Wallet Login ---");
    let privateKey = process.env.USER_PRIVATE_KEY;
    if (!privateKey) {
      console.log(chalk.yellow(`'USER_PRIVATE_KEY' not found in ${path.basename(envFilePath)}.`));
      ({ privateKey } = await inquirer.prompt([
        {
          type: "password",
          name: "privateKey",
          message: "Please enter your private key to continue:",
        },
      ]));
    } else {
      const { confirmed } = await inquirer.prompt([
        {
          type: "confirm",
          name: "confirmed",
          message: `Login using the 'USER_PRIVATE_KEY' from your ${path.basename(envFilePath)} file?`,
          default: true,
        },
      ]);
      if (!confirmed) {
        console.log("\nLogin cancelled by user.");
        return;
      }
    }

    if (!privateKey) {
      throw new Error("A private key is required to proceed.");
    }

    // --- Step 3: Provider, Signer, and Contract Initialization ---
    let rpcUrl = process.env[selectedNetwork.rpcEnvVar];
    if (!rpcUrl) {
      console.log(chalk.yellow(`RPC URL for '${networkName}' not found in .env file.`));
      ({ rpcUrl } = await inquirer.prompt([
        { type: "input", name: "rpcUrl", message: `Please enter the RPC URL for ${networkName}:` },
      ]));
    }

    if (!rpcUrl) {
      throw new Error("An RPC URL is required to connect.");
    }

    const spinner = ora(`Connecting to ${networkName}...`).start();
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const baseSigner = new ethers.Wallet(privateKey, provider);
    signer = isSapphire ? wrapEthersSigner(baseSigner) : baseSigner;

    const { chainId } = await provider.getNetwork();
    const contractName = isSapphire ? "SapphireChatBot" : "EVMChatBot";

    const { abi } = loadContractArtifact(contractName);

    let contractAddress = process.env.ORACLE_CONTRACT_ADDRESS;
    if (!contractAddress) {
      spinner.stop();
      console.log(chalk.yellow("Contract address not found in .env file."));
      ({ contractAddress } = await inquirer.prompt([
        { type: "input", name: "contractAddress", message: "Please enter the contract address:" },
      ]));
    }

    if (!contractAddress) {
      throw new Error("A contract address is required.");
    }

    contract = new Contract(contractAddress, abi, signer);

    // --- Step 4: Display Connection Info ---
    const address = signer.address;
    const balanceWei = await provider.getBalance(address);
    const balance = ethers.formatEther(balanceWei);

    // Correctly determine the native currency symbol based on the selected chain.
    const CURRENCY_SYMBOLS = {
      Sapphire: { mainnet: "ROSE", default: "TEST" },
      Base: { default: "ETH" },
    };
    const currency =
      CURRENCY_SYMBOLS[chainName]?.[networkName] || CURRENCY_SYMBOLS[chainName]?.default || "TOKEN";

    spinner.succeed(chalk.green("Connected successfully!"));
    console.log(`   - Network: ${chalk.bold(networkName)} (Chain ID: ${chainId})`);
    console.log(`   - Wallet Address: ${chalk.yellow(address)}`);
    console.log(`   - Contract Address: ${chalk.cyan(contract.target)}`);
    console.log(`   - Balance: ${chalk.bold(balance)} ${currency}`);

    // --- Step 5: Environment-Specific Login/Setup ---
    if (isSapphire) {
      sapphireAuthToken = await loginSiwe(Number(chainId));
    } else {
      roflPublicKey = process.env.PUBLIC_KEY;
      if (!roflPublicKey) {
        console.log(chalk.yellow("PUBLIC_KEY for ROFL worker not found in your .env file."));
        ({ roflPublicKey } = await inquirer.prompt([
          {
            type: "input",
            name: "roflPublicKey",
            message: "Please enter the ROFL worker's public key:",
          },
        ]));
      }

      if (!roflPublicKey) {
        throw new Error("ROFL worker's public key is required for encryption.");
      }
    }

    // --- Step 6: Start the Main Application Loop ---
    await mainMenu();
  } catch (error) {
    // Gracefully handle Ctrl+C interruptions from inquirer.
    if (error.isTtyError) {
      console.log("\nCLI interaction cancelled. Exiting.");
    } else {
      console.error(`\n❌ ${chalk.red("Error:")} ${error.message}`);
      process.exitCode = 1;
    }
  }
}

main();
