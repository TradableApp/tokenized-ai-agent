const { ethers, Contract, Signature } = require("ethers");
const { wrapEthersSigner } = require("@oasisprotocol/sapphire-ethers-v6");
const inquirer = require("inquirer");
const ora = require("ora");
const chalk = require("chalk");
const { SiweMessage } = require("siwe");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

// --- Configuration ---
const baseEnvPath = path.resolve(__dirname, "../.env");
const ENV_FILES = {
  testnet: path.resolve(__dirname, "../.env.testnet"),
  mainnet: path.resolve(__dirname, "../.env.mainnet"),
  localnet: path.resolve(__dirname, "../.env.localnet"),
};
const RPC_URLS = {
  testnet: "SAPPHIRE_TESTNET_RPC",
  mainnet: "SAPPHIRE_MAINNET_RPC",
  localnet: "http://localhost:8545",
};
const POLLING_INTERVAL_MS = 5000;
// ---

// --- Global State ---
let confidentialSigner;
let chatBotContract;
let authInfo;
let networkName;
// ---

/**
 * @description Loads the contract ABI from the project's artifacts directory.
 * @returns {{abi: object}} The contract's Application Binary Interface (ABI).
 * @throws {Error} If the artifact JSON file cannot be found.
 */
function getContractArtifacts() {
  const contractPath = path.resolve(__dirname, "../artifacts/contracts/ChatBot.sol/ChatBot.json");
  if (!fs.existsSync(contractPath)) {
    throw new Error(
      `Contract artifacts not found at: ${contractPath}. Please run 'npm run compile'.`,
    );
  }
  return JSON.parse(fs.readFileSync(contractPath, "utf-8"));
}

/**
 * @description Authenticates with the smart contract using Sign-In with Ethereum (SIWE).
 * This provides a session token required for subsequent contract interactions.
 * @param {number} chainId - The chain ID of the connected network.
 * @returns {Promise<string>} The authentication token from the contract.
 * @throws {Error} If the SIWE login process fails.
 */
async function loginSiwe(chainId) {
  const spinner = ora("Authenticating with contract via Sign-In with Ethereum (SIWE)...").start();
  try {
    const domain = await chatBotContract.domain();
    const address = await confidentialSigner.getAddress();
    const siweMessage = new SiweMessage({
      domain,
      address,
      uri: `http://${domain}`,
      version: "1",
      chainId,
    }).toMessage();
    const signatureString = await confidentialSigner.signMessage(siweMessage);
    const signature = Signature.from(signatureString);
    const retrievedAuthInfo = await chatBotContract.login(siweMessage, signature);
    spinner.succeed(chalk.green("Successfully authenticated with the contract."));
    return retrievedAuthInfo;
  } catch (error) {
    spinner.fail(chalk.red("SIWE Authentication failed!"));
    throw error;
  }
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
    if (key && key.name === "s") userSkipped = true;
    if (key && key.ctrl && key.name === "c") process.exit();
  };

  const spinner = ora(chalk.yellow(`Waiting for AI response... (Press 's' to skip)`)).start();

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on("keypress", keypressHandler);
  process.stdin.resume();

  try {
    while (true) {
      if (userSkipped) break;

      const address = await confidentialSigner.getAddress();
      const rawAnswers = await chatBotContract.getAnswers(authInfo, address);
      const foundAnswer = rawAnswers.find((answer) => Number(answer.promptId) === promptId);

      if (foundAnswer) {
        const cleanAnswer = foundAnswer.answer.replaceAll(/<think>.*<\/think>/gs, "").trim();
        spinner.succeed(chalk.green("AI response received!"));
        console.log(`   ${chalk.green.bold("Answer:")} ${chalk.green(cleanAnswer)}`);
        return;
      }

      // Use the interruptible sleep to allow for a responsive skip.
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
    const tx = await chatBotContract.appendPrompt(prompt);
    spinner.text = "Waiting for transaction to be mined...";
    const receipt = await tx.wait();

    // Determine the ID of the prompt we just sent by checking the new array length.
    const address = await confidentialSigner.getAddress();
    const currentPrompts = await chatBotContract.getPrompts(authInfo, address);
    const newPromptId = currentPrompts.length - 1;

    spinner.succeed(chalk.green("Prompt sent successfully!"));
    console.log(`   - Transaction Hash: ${chalk.cyan(receipt.hash)}`);

    await waitForAnswer(newPromptId);
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
    const address = await confidentialSigner.getAddress();
    const [prompts, rawAnswers] = await Promise.all([
      chatBotContract.getPrompts(authInfo, address),
      chatBotContract.getAnswers(authInfo, address),
    ]);

    spinner.succeed(chalk.green("Data fetched successfully."));
    console.log("\n--- Your Prompts and Answers ---");

    if (prompts.length === 0) {
      console.log(chalk.yellow("You haven't sent any prompts yet."));
      return;
    }

    // Use a Map to efficiently align answers with their prompts by ID.
    const answersMap = new Map();
    rawAnswers.forEach((answer) => {
      const cleanAnswer = answer.answer.replaceAll(/<think>.*<\/think>/gs, "").trim();
      answersMap.set(Number(answer.promptId), cleanAnswer);
    });

    prompts.forEach((prompt, index) => {
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
    const tx = await chatBotContract.clearPrompt({ gasLimit: 10_000_000 });
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
    const address = await confidentialSigner.getAddress();
    const balanceWei = await confidentialSigner.provider.getBalance(address);
    const balance = ethers.formatEther(balanceWei);
    const currency =
      networkName === "localnet" ? "TEST" : networkName === "testnet" ? "TEST" : "ROSE";

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
  console.log("\n\nWelcome to the ChatBot CLI!");
  console.log("===========================");
  console.log("");

  try {
    // Load base .env file for shared configuration like RPC URLs.
    if (fs.existsSync(baseEnvPath)) {
      require("dotenv").config({ path: baseEnvPath, quiet: true });
    }

    const networkChoice = await inquirer.prompt([
      {
        type: "list",
        name: "networkName",
        message: "Choose a network to connect to:",
        choices: Object.keys(ENV_FILES),
      },
    ]);
    networkName = networkChoice.networkName;

    const envFilePath = ENV_FILES[networkName];
    if (!fs.existsSync(envFilePath)) {
      throw new Error(
        `Environment file not found at: ${envFilePath}\nPlease create it before proceeding.`,
      );
    }
    // Load environment-specific .env file to override with secrets.
    require("dotenv").config({ path: envFilePath, override: true, quiet: true });
    console.log(`> Loaded configuration for: ${networkName}`);

    console.log("\n--- Wallet Login ---");
    const privateKey = process.env.USER_PRIVATE_KEY;
    if (!privateKey)
      throw new Error(`'USER_PRIVATE_KEY' not found in ${path.basename(envFilePath)}.`);

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

    const rpcUrl =
      networkName === "localnet" ? RPC_URLS.localnet : process.env[RPC_URLS[networkName]];
    if (!rpcUrl) throw new Error(`RPC URL variable '${RPC_URLS[networkName]}' not found.`);

    const spinner = ora(`Connecting to ${networkName}...`).start();
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const signer = new ethers.Wallet(privateKey, provider);
    confidentialSigner = wrapEthersSigner(signer);

    const { chainId } = await provider.getNetwork();

    const { abi } = getContractArtifacts();
    let contractAddress = process.env.CONTRACT_ADDRESS;
    if (!contractAddress) {
      spinner.stop();
      ({ contractAddress } = await inquirer.prompt([
        {
          type: "input",
          name: "contractAddress",
          message: "Contract address not found in .env file. Please enter it here:",
        },
      ]));
    }
    if (!contractAddress) throw new Error("Contract address is required.");

    chatBotContract = new Contract(contractAddress, abi, confidentialSigner);

    const address = await confidentialSigner.getAddress();
    const balanceWei = await confidentialSigner.provider.getBalance(address);
    const balance = ethers.formatEther(balanceWei);
    const currency =
      networkName === "localnet" ? "TEST" : networkName === "testnet" ? "TEST" : "ROSE";

    spinner.succeed(chalk.green(`Connected successfully!`));
    console.log(`   - Network: ${chalk.bold(networkName)} (Chain ID: ${chainId})`);
    console.log(`   - Wallet Address: ${chalk.yellow(address)}`);
    console.log(`   - Contract Address: ${chalk.cyan(contractAddress)}`);
    console.log(`   - Balance: ${chalk.bold(balance)} ${currency}`);

    authInfo = await loginSiwe(Number(chainId));
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
