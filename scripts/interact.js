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
const { format } = require("date-fns");

inquirer.registerPrompt("datetime", require("inquirer-datepicker-prompt"));

// --- Configuration ---
const envPath = path.resolve(__dirname, "../.env");
const CHAINS = {
  Sapphire: {
    isSapphire: true,
    networks: {
      localnet: { envFile: "../.env.localnet", rpcEnvVar: "SAPPHIRE_LOCALNET_RPC" },
      testnet: { envFile: "../.env.testnet", rpcEnvVar: "SAPPHIRE_TESTNET_RPC" },
      mainnet: { envFile: "../.env.mainnet", rpcEnvVar: "SAPPHIRE_MAINNET_RPC" },
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
let aiAgentContract;
let aiAgentEscrowContract;
let tokenContract;
let isSapphire;
let networkName;
let roflPublicKey;
let sapphireAuthToken; // Only used by the Sapphire workflow

// --- Utility Functions ---

/**
 * @description Loads the contract's ABI from the artifacts directory.
 * @param {string} contractName The name of the contract (e.g., 'EVMAIAgent').
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
 */
async function loginSiwe(chainId) {
  const spinner = ora("Authenticating with contract via Sign-In with Ethereum (SIWE)...").start();

  try {
    const domain = await aiAgentContract.domain();
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
    const retrievedAuthToken = await aiAgentContract.login(siweMessage, signature);
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
 *              It handles a special case for cancelled prompts where the content is plaintext.
 * @param {object} encryptedMessage - The struct fetched from the contract.
 * @returns {Promise<string>} The decrypted plaintext.
 */
async function decryptMessage(encryptedMessage) {
  // By convention, if the key fields are empty, the content is treated as plaintext.
  // This handles messages like "Prompt cancelled by user."
  if (!encryptedMessage.userEncryptedKey || encryptedMessage.userEncryptedKey === "0x") {
    return ethers.toUtf8String(encryptedMessage.encryptedContent);
  }

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
      const address = signer.address;
      const rawAnswers = isSapphire
        ? await aiAgentContract.getAnswers(sapphireAuthToken, address)
        : await aiAgentContract.getAnswers(address);

      const answerStruct = rawAnswers.find((answer) => Number(answer.promptId) === promptId);

      if (answerStruct) {
        let cleanAnswer;
        if (isSapphire) {
          cleanAnswer = answerStruct.answer.replaceAll(/<think>.*<\/think>/gs, "").trim();
        } else {
          spinner.text = "Decrypting confidential response...";
          cleanAnswer = await decryptMessage(answerStruct.message);
        }

        spinner.succeed(chalk.green("AI response received!"));
        console.log(`   ${chalk.green.bold("Answer:")} ${chalk.green(cleanAnswer)}`);

        return;
      }

      const wasSkipped = await interruptibleSleep(POLLING_INTERVAL_MS, () => userSkipped);
      if (wasSkipped) break;
    }
  } finally {
    process.stdin.removeListener("keypress", keypressHandler);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
  }

  if (userSkipped) {
    spinner.stopAndPersist({
      symbol: "➡️",
      text: chalk.bold(" Skipped. Check for the answer later using 'Check conversation history'."),
    });
  }
}

/**
 * @description A helper function to pause and wait for the user to press Enter.
 */
async function pressEnterToContinue() {
  console.log("");
  await inquirer.prompt([
    {
      type: "input",
      name: "continue",
      message: `Press Enter to return to the main menu...`,
    },
  ]);
}

// --- CLI HANDLERS ---

/**
 * @description A helper function to check the user's allowance status before they send a prompt.
 * If the allowance is invalid, it guides them through the setup process in a loop.
 * @returns {Promise<boolean>} True if the user is ready to send a prompt, false if they cancel.
 */
async function checkAndGuideAllowance() {
  let skipPressEnter = true;
  // This function now loops until the user is ready or cancels.
  while (true) {
    const sub = await aiAgentEscrowContract.subscriptions(signer.address);

    const expiresAt = isSapphire ? sub : sub.expiresAt;
    const now = Math.floor(Date.now() / 1000);

    const promptFee = await aiAgentEscrowContract.PROMPT_FEE();

    // Check 1: Is the subscription active and not expired?
    if (expiresAt === 0n || now >= expiresAt) {
      console.log(chalk.yellow("\nYour usage allowance is not active or has expired."));

      const { setup } = await inquirer.prompt([
        {
          type: "confirm",
          name: "setup",
          message: "You need an active allowance to send prompts. Set one up now?",
          default: true,
        },
      ]);

      if (setup) {
        await handleManageAllowance(skipPressEnter);
        continue; // Loop back to re-check the status.
      } else {
        return false; // User explicitly cancelled.
      }
    }

    if (isSapphire) {
      const deposit = await aiAgentEscrowContract.deposits(signer.address);

      if (deposit < promptFee) {
        console.log(chalk.yellow("\nYour deposited balance is too low to send a prompt."));

        const { setup } = await inquirer.prompt([
          {
            type: "confirm",
            name: "setup",
            message: "Would you like to deposit more funds now?",
            default: true,
          },
        ]);

        if (setup) {
          await handleManageAllowance(skipPressEnter);
          continue; // Loop back to re-check.
        } else {
          return false;
        }
      }
    } else {
      const allowance = sub.allowance;
      const spent = sub.spentAmount;

      if (spent + promptFee > allowance) {
        console.log(chalk.yellow("\nYour approved allowance is too low to send another prompt."));

        const { setup } = await inquirer.prompt([
          {
            type: "confirm",
            name: "setup",
            message: "Would you like to increase your approval amount now?",
            default: true,
          },
        ]);

        if (setup) {
          await handleManageAllowance(skipPressEnter);
          continue; // Loop back to re-check.
        } else {
          return false;
        }
      }
    }

    return true; // All checks passed, user is ready.
  }
}

/**
 * @description Prompts the user for a new message, sends it to the contract,
 * and then waits for the AI's response.
 */
async function handleSendPrompt() {
  // Proactively check if the user is ready to send a prompt.
  const isReady = await checkAndGuideAllowance();
  if (!isReady) {
    console.log(chalk.yellow("\nAction cancelled. Please set up your allowance to send a prompt."));
    return;
  }

  console.log("");
  const { prompt } = await inquirer.prompt([
    {
      type: "input",
      name: "prompt",
      message: "Enter your confidential prompt:",
      validate: (input) => (input ? true : "Prompt cannot be empty."),
    },
  ]);

  const spinner = ora(`Submitting your prompt${isSapphire ? "" : " confidentially"}...`).start();

  try {
    let tx;
    if (isSapphire) {
      tx = await aiAgentEscrowContract.initiatePrompt(prompt);
    } else {
      const { encryptedContent, userEncryptedKey, roflEncryptedKey } = await encryptPrompt(prompt);

      tx = await aiAgentEscrowContract.initiatePrompt(
        encryptedContent,
        userEncryptedKey,
        roflEncryptedKey,
      );
    }

    spinner.text = "Waiting for transaction to be mined...";

    const receipt = await tx.wait();

    // Find the PromptSubmitted event in the transaction logs to get the new promptId.
    const aiAgentInterface = new ethers.Interface(
      loadContractArtifact(isSapphire ? "SapphireAIAgent" : "EVMAIAgent").abi,
    );
    const eventTopic = aiAgentInterface.getEvent("PromptSubmitted").topicHash;
    const log = receipt.logs.find(
      (l) => l.address === aiAgentContract.target && l.topics[0] === eventTopic,
    );

    if (!log) {
      throw new Error("Could not find PromptSubmitted event in transaction receipt.");
    }

    const parsedLog = aiAgentInterface.parseLog({ topics: log.topics, data: log.data });
    const newPromptId = Number(parsedLog.args.promptId);

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
async function handleCheckHistory() {
  const spinner = ora("Fetching conversation history...").start();

  try {
    const address = signer.address;
    const [prompts, answers] = await Promise.all([
      isSapphire
        ? aiAgentContract.getPrompts(sapphireAuthToken, address)
        : aiAgentContract.getPrompts(address),
      isSapphire
        ? aiAgentContract.getAnswers(sapphireAuthToken, address)
        : aiAgentContract.getAnswers(address),
    ]);

    spinner.succeed(chalk.green("Data fetched successfully."));
    console.log("\n--- Your Conversation History ---");

    if (prompts.length === 0) {
      console.log(chalk.yellow("You haven't sent any prompts yet."));
      return;
    }

    spinner.start("Decrypting conversation history...");

    // The prompts array now contains structs with { promptId, message/prompt }.
    const plaintextPrompts = isSapphire
      ? prompts.map((p) => ({ promptId: Number(p.promptId), prompt: p.prompt }))
      : await Promise.all(
          prompts.map(async (p) => ({
            promptId: Number(p.promptId),
            prompt: await decryptMessage(p.message),
          })),
        );

    // Use a Map to efficiently align answers with their prompts by ID.
    const answersMap = new Map();

    if (isSapphire) {
      answers.forEach((a) => answersMap.set(Number(a.promptId), a.answer));
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

    // Iterate through the processed prompts to display them in order.
    plaintextPrompts.forEach((p) => {
      const answer = answersMap.get(p.promptId);
      console.log(`\n #${p.promptId}:`);
      console.log(`   ${chalk.bold("Prompt:")} ${p.prompt}`);

      if (answer) {
        // Check for the specific cancellation message and format it differently.
        if (answer === "Prompt cancelled by user.") {
          console.log(`   ${chalk.yellow.bold("Answer:")} ${chalk.yellow("(Cancelled by user)")}`);
        } else {
          const cleanAnswer = answer.replaceAll(/<think>.*<\/think>/gs, "").trim();
          console.log(`   ${chalk.green.bold("Answer:")} ${chalk.green(cleanAnswer)}`);
        }
      } else {
        console.log(
          `   ${chalk.yellow.bold("Answer:")} ${chalk.yellow("(Awaiting response from AI Agent...)")}`,
        );
      }
    });
  } catch (error) {
    spinner.fail(chalk.red("Failed to fetch data."));
    console.error(error.message);
  }
}

/**
 * @description Guides the user through setting up or modifying their usage allowance.
 * The flow is state-aware and adapts based on whether an allowance is already active.
 */
async function handleManageAllowance(skipPressEnter) {
  console.log("");
  const spinner = ora("Checking current allowance status...").start();

  // First, determine the current state of the user's allowance.
  const sub = await aiAgentEscrowContract.subscriptions(signer.address);

  const expiresAt = isSapphire ? sub : sub.expiresAt;
  const now = Math.floor(Date.now() / 1000);
  const isActive = expiresAt > 0 && expiresAt > now;

  spinner.stop();

  if (!isActive) {
    // --- ONBOARDING FLOW: User has no active allowance ---
    console.log(chalk.yellow("Your usage allowance is not active. Let's set one up."));
    await setupNewAllowance();
  } else {
    // --- MANAGEMENT FLOW: User has an active allowance ---
    await updateExistingAllowance();
  }

  // Show the user their updated status after any action.
  await handleCheckBalance();

  if (!skipPressEnter) {
    await pressEnterToContinue();
  }
}

/**
 * @description A helper function to guide a user through the initial setup or a full update
 * of their usage allowance (Amount + Term).
 */
async function setupNewAllowance() {
  if (isSapphire) {
    // --- Sapphire: Deposit + Set Term ---
    const chainName = Object.keys(CHAINS).find((cn) => CHAINS[cn].isSapphire === isSapphire);
    const CURRENCY_SYMBOLS = {
      Sapphire: { mainnet: "ROSE", default: "TEST" },
      Base: { default: "ETH" },
    };
    const currency =
      CURRENCY_SYMBOLS[chainName]?.[networkName] || CURRENCY_SYMBOLS[chainName]?.default || "TOKEN";

    const { amount } = await inquirer.prompt([
      {
        type: "input",
        name: "amount",
        message: `Enter amount of ${currency} to deposit for your allowance (e.g., 5.0):`,
        validate: (input) => !isNaN(parseFloat(input)) && parseFloat(input) >= 0,
      },
    ]);

    if (parseFloat(amount) > 0) {
      await handleDeposit(amount);
    }

    await setExpiryTerm();
  } else {
    // --- EVM: Approve + Set Subscription ---
    const tokenSymbol = await tokenContract.symbol();
    const { amount } = await inquirer.prompt([
      {
        type: "input",
        name: "amount",
        message: `Enter the total amount of ${tokenSymbol} to approve for your allowance:`,
        validate: (input) => !isNaN(parseFloat(input)) && parseFloat(input) >= 0,
      },
    ]);

    const spinner = ora(`1/2: Approving ${amount} ${tokenSymbol} for payments...`).start();

    try {
      const tx = await tokenContract.approve(
        aiAgentEscrowContract.target,
        ethers.parseEther(amount),
      );

      const receipt = await tx.wait();

      spinner.succeed(chalk.green(`1/2: Approval successful.`));
      console.log(`   - Transaction Hash: ${chalk.cyan(receipt.hash)}`);

      // Pass the approved amount to the next step
      await setExpiryTerm(ethers.parseEther(amount));
    } catch (e) {
      spinner.fail(chalk.red("Approval failed."));
      console.error(e.message);
    }
  }
}

/**
 * @description A guided flow for users who already have an active allowance to modify it.
 */
async function updateExistingAllowance() {
  if (isSapphire) {
    const chainName = Object.keys(CHAINS).find((cn) => CHAINS[cn].isSapphire === isSapphire);
    const CURRENCY_SYMBOLS = {
      Sapphire: { mainnet: "ROSE", default: "TEST" },
      Base: { default: "ETH" },
    };
    const currency =
      CURRENCY_SYMBOLS[chainName]?.[networkName] || CURRENCY_SYMBOLS[chainName]?.default || "TOKEN";

    const currentDeposit = await aiAgentEscrowContract.deposits(signer.address);
    console.log(
      `Your current deposited amount is ${chalk.bold(ethers.formatEther(currentDeposit))} ${currency}.`,
    );

    const { action } = await inquirer.prompt([
      {
        type: "list",
        name: "action",
        message: "How would you like to manage the allowance?",
        choices: ["Update", "Cancel"],
      },
    ]);

    switch (action) {
      case "Update": {
        const { newAmount } = await inquirer.prompt([
          {
            type: "input",
            name: "newAmount",
            message: "Enter your new desired total deposit amount:",
            default: ethers.formatEther(currentDeposit),
            validate: (input) => !isNaN(parseFloat(input)) && parseFloat(input) >= 0,
          },
        ]);

        const newAmountWei = ethers.parseEther(newAmount);
        const difference = newAmountWei - currentDeposit;

        if (difference > 0) {
          await handleDeposit(ethers.formatEther(difference));
        } else if (difference < 0) {
          await handleWithdraw(ethers.formatEther(-difference));
        } else {
          console.log(chalk.yellow("No change in deposit amount."));
        }
        await setExpiryTerm();

        break;
      }
      case "Cancel": {
        await cancelAllowance();

        break;
      }
    }
  } else {
    // EVM: The flow is the same as setting up a new allowance.
    await setupNewAllowance();
  }
}

/**
 * @description A helper function specifically for Sapphire deposits.
 * @param {string} amount - The amount to deposit as a string.
 */
async function handleDeposit(amount) {
  const spinner = ora(`Depositing ${amount} tokens into escrow...`).start();

  try {
    const tx = await aiAgentEscrowContract.deposit({ value: ethers.parseEther(amount) });
    const receipt = await tx.wait();
    spinner.succeed(chalk.green(`Successfully deposited ${amount} tokens.`));
    console.log(`   - Transaction Hash: ${chalk.cyan(receipt.hash)}`);
  } catch (e) {
    spinner.fail(chalk.red("Deposit failed."));
    console.error(e.message);
  }
}

/**
 * @description A helper function specifically for Sapphire withdrawals.
 * @param {string} amount - The amount to withdraw as a string.
 */
async function handleWithdraw(amount) {
  const spinner = ora(`Withdrawing ${amount} tokens from escrow...`).start();

  try {
    const tx = await aiAgentEscrowContract.withdraw(ethers.parseEther(amount));
    const receipt = await tx.wait();
    spinner.succeed(chalk.green(`Successfully withdrew ${amount} tokens.`));
    console.log(`   - Transaction Hash: ${chalk.cyan(receipt.hash)}`);
  } catch (e) {
    spinner.fail(chalk.red("Withdrawal failed."));
    console.error(e.message);
  }
}

/**
 * @description A helper function to set or update the expiry term of the allowance/subscription.
 * @param {ethers.BigNumber} [evmAllowance] - (EVM only) The allowance amount to pass to the contract.
 */
async function setExpiryTerm(evmAllowance) {
  const timeInOneMonth = new Date();
  timeInOneMonth.setMonth(timeInOneMonth.getMonth() + 1);

  const { dt } = await inquirer.prompt([
    {
      type: "datetime",
      name: "dt",
      message: "Set the exact date and time for the allowance to expire:",
      initial: timeInOneMonth, // Default to 1 month from now
      format: ["d", "/", "m", "/", "yyyy", " ", "h", ":", "MM", " ", "TT"],
      filter: (dt) => {
        // Set seconds to 0
        dt.setSeconds(0);
        return dt;
      },
    },
  ]);

  // The contract expects a Unix timestamp in seconds.
  const expiresAt = Math.floor(dt.getTime() / 1000);

  const spinner = ora("Setting new expiry term...").start();

  try {
    const tx = isSapphire
      ? await aiAgentEscrowContract.setSubscription(expiresAt)
      : await aiAgentEscrowContract.setSubscription(evmAllowance, expiresAt);

    const receipt = await tx.wait();

    spinner.succeed(
      chalk.green(
        `Allowance term set, expires on ${format(new Date(expiresAt * 1000), "d/M/yyyy h:mm a")}`,
      ),
    );
    console.log(`   - Transaction Hash: ${chalk.cyan(receipt.hash)}`);
  } catch (e) {
    spinner.fail(chalk.red("Failed to set expiry term."));
    console.error(e.message);
  }
}

/**
 * @description A helper function to cancel the user's allowance/subscription.
 */
async function cancelAllowance() {
  const spinner = ora("Cancelling usage allowance...").start();

  try {
    const tx = await aiAgentEscrowContract.cancelSubscription();

    const receipt = await tx.wait();

    spinner.succeed(chalk.green("Usage allowance cancelled."));
    console.log(`   - Transaction Hash: ${chalk.cyan(receipt.hash)}`);
  } catch (e) {
    spinner.fail(chalk.red("Failed to cancel allowance."));
    console.error(e.message);
  }
}

/**
 * @description Allows a user to cancel a pending prompt that has exceeded the cancellation timeout.
 */
async function handleCancelPrompt() {
  console.log("");
  const spinner = ora("Finding cancellable prompts...").start();

  try {
    const address = signer.address;
    const [prompts, answers] = await Promise.all([
      isSapphire
        ? aiAgentContract.getPrompts(sapphireAuthToken, address)
        : aiAgentContract.getPrompts(address),
      isSapphire
        ? aiAgentContract.getAnswers(sapphireAuthToken, address)
        : aiAgentContract.getAnswers(address),
    ]);

    const answeredPromptIds = new Set(answers.map((a) => Number(a.promptId)));
    const pendingPrompts = prompts.filter((p) => !answeredPromptIds.has(Number(p.promptId)));

    if (pendingPrompts.length === 0) {
      spinner.info(chalk.yellow("You have no pending prompts."));
      return;
    }

    const cancellationTimeout = await aiAgentEscrowContract.CANCELLATION_TIMEOUT();
    const now = Math.floor(Date.now() / 1000);
    const cancellablePrompts = [];

    for (const prompt of pendingPrompts) {
      const promptId = Number(prompt.promptId);
      const escrow = await aiAgentEscrowContract.escrows(promptId);
      if (now >= Number(escrow.createdAt) + Number(cancellationTimeout)) {
        const plaintextPrompt = isSapphire ? prompt.prompt : await decryptMessage(prompt.message);
        cancellablePrompts.push({
          name: `#${promptId}: "${plaintextPrompt.substring(0, 50)}..."`,
          value: promptId,
        });
      }
    }

    spinner.stop();

    if (cancellablePrompts.length === 0) {
      console.log(
        chalk.yellow("You have pending prompts, but none are old enough to be cancelled yet."),
      );
      return;
    }

    console.log("");
    const { promptToCancel } = await inquirer.prompt([
      {
        type: "list",
        name: "promptToCancel",
        message: "Choose a prompt to cancel and refund:",
        choices: [...cancellablePrompts, new inquirer.Separator(), "Back"],
      },
    ]);

    if (promptToCancel === "Back") return;

    console.log("");
    const { confirmed } = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirmed",
        message: `Are you sure you want to cancel Prompt #${promptToCancel}? This action is irreversible.`,
        default: false,
      },
    ]);

    if (!confirmed) {
      console.log("Cancellation aborted.");
      return;
    }

    const cancelSpinner = ora(`Cancelling Prompt #${promptToCancel} on-chain...`).start();
    const tx = await aiAgentEscrowContract.cancelAndRefundPrompt(promptToCancel);
    const receipt = await tx.wait();
    cancelSpinner.succeed(
      chalk.green(`Prompt #${promptToCancel} successfully cancelled and refunded.`),
    );
    console.log(`   - Transaction Hash: ${chalk.cyan(receipt.hash)}`);

    await handleCheckBalance();
    await pressEnterToContinue();
  } catch (error) {
    spinner.fail(chalk.red("Failed to find or cancel prompts."));
    console.error(error.message);
  }
}

/**
 * @description Sends a transaction to clear all of the user's prompts and answers from the contract.
 */
async function handleClearHistory() {
  console.log("");

  const { confirmed } = await inquirer.prompt([
    {
      type: "confirm",
      name: "confirmed",
      message: chalk.yellow(
        "Are you sure you want to permanently clear your conversation history? This action is irreversible.",
      ),
      default: false,
    },
  ]);

  if (!confirmed) {
    console.log("Operation cancelled.");
    return;
  }

  const spinner = ora("Clearing conversation history on-chain...").start();

  try {
    // Manually set a high gas limit to overcome potential estimation issues.
    // const tx = await contract.clearPrompt({ gasLimit: 10_000_000 });

    const tx = isSapphire
      ? await aiAgentContract.clearPrompt(sapphireAuthToken, signer.address)
      : await aiAgentContract.clearPrompt(signer.address);

    spinner.text = "Waiting for transaction to be mined...";
    const receipt = await tx.wait();

    spinner.succeed(chalk.green("Your conversation history has been cleared."));
    console.log(`   - Transaction Hash: ${chalk.cyan(receipt.hash)}`);
  } catch (error) {
    spinner.fail(chalk.red("Failed to clear data."));
    console.error(error);
  }

  await pressEnterToContinue();
}

/**
 * @description Fetches and displays the user's current wallet and contract balances/status.
 */
async function handleCheckBalance() {
  console.log("");
  const spinner = ora("Fetching balances and status...").start();

  try {
    const address = signer.address;
    const balanceWei = await signer.provider.getBalance(address);
    const balance = ethers.formatEther(balanceWei);

    const chainName = Object.keys(CHAINS).find((cn) => CHAINS[cn].isSapphire === isSapphire);
    const CURRENCY_SYMBOLS = {
      Sapphire: { mainnet: "ROSE", default: "TEST" },
      Base: { default: "ETH" },
    };
    const currency =
      CURRENCY_SYMBOLS[chainName]?.[networkName] || CURRENCY_SYMBOLS[chainName]?.default || "TOKEN";

    spinner.succeed(chalk.green("Balances and status:"));
    console.log(`   - Wallet Address: ${chalk.yellow(address)}`);
    console.log(`   - Native Balance: ${chalk.bold(balance)} ${currency}`);

    let sub;
    if (isSapphire) {
      const depositWei = await aiAgentEscrowContract.deposits(address);
      sub = await aiAgentEscrowContract.subscriptions(address);

      console.log(
        `   - Deposited for Allowance: ${chalk.bold(ethers.formatEther(depositWei))} ${currency}`,
      );
    } else {
      const tokenSymbol = await tokenContract.symbol();
      const tokenBalance = await tokenContract.balanceOf(address);
      sub = await aiAgentEscrowContract.subscriptions(address);

      console.log(
        `   - Your Token Balance: ${chalk.bold(ethers.formatEther(tokenBalance))} ${tokenSymbol}`,
      );
      console.log(
        `   - Usage Allowance: ${chalk.bold(ethers.formatEther(sub.spentAmount))} / ${chalk.bold(ethers.formatEther(sub.allowance))} ${tokenSymbol} Spent`,
      );
    }

    const expiresAt = isSapphire ? sub : sub.expiresAt;

    if (expiresAt > 0) {
      const date = new Date(Number(expiresAt) * 1000);

      if (date > new Date()) {
        console.log(
          `   - Allowance Term: ${chalk.green("Active")} (Expires: ${format(date, "d/M/yyyy h:mm a")})`,
        );
      } else {
        console.log(
          `   - Allowance Term: ${chalk.red("Expired")} on ${format(date, "d/M/yyyy h:mm a")}`,
        );
      }
    } else {
      console.log(`   - Allowance Term: ${chalk.yellow("Inactive")}`);
    }
  } catch (error) {
    spinner.fail(chalk.red("Failed to fetch balance."));
    console.error(error.message);
  }
}

/**
 * @description Fetches and displays the details of a specific on-chain escrow record.
 */
async function handleCheckEscrowStatus() {
  console.log("");
  const { promptId } = await inquirer.prompt([
    {
      type: "input",
      name: "promptId",
      message: "Enter the Prompt ID to check its payment status:",
      validate: (input) => !isNaN(parseInt(input)) && parseInt(input) >= 0,
    },
  ]);

  const spinner = ora(`Fetching payment status for Prompt #${promptId}...`).start();

  try {
    const escrowData = await aiAgentEscrowContract.escrows(promptId);

    if (escrowData.user === ethers.ZeroAddress) {
      spinner.warn(chalk.yellow(`No payment record found for Prompt ID #${promptId}.`));
      return;
    }

    const STATUS_MAP = ["Pending", "Complete", "Refunded"];
    const status = STATUS_MAP[Number(escrowData.status)] || "Unknown";
    const amount = ethers.formatEther(escrowData.amount);
    const createdAt = new Date(Number(escrowData.createdAt) * 1000);

    const chainName = Object.keys(CHAINS).find((cn) => CHAINS[cn].isSapphire === isSapphire);
    const CURRENCY_SYMBOLS = {
      Sapphire: { mainnet: "ROSE", default: "TEST" },
      Base: { default: "ETH" },
    };
    const currency =
      CURRENCY_SYMBOLS[chainName]?.[networkName] || CURRENCY_SYMBOLS[chainName]?.default || "TOKEN";

    spinner.succeed(chalk.green("Payment status fetched successfully."));
    console.log(`\n--- Payment Status for Prompt #${promptId} ---`);
    console.log(`   - User: ${chalk.yellow(escrowData.user)}`);
    console.log(`   - Amount: ${chalk.bold(amount)} ${currency}`);
    console.log(`   - Created At: ${format(createdAt, "d/M/yyyy h:mm a")}`);
    console.log(`   - Status: ${chalk.bold(status)}`);
  } catch (error) {
    spinner.fail(chalk.red("Failed to fetch payment status."));
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
          "Check conversation history",
          "Clear my conversation history",
          new inquirer.Separator(),

          "Cancel a Pending Prompt",
          "Check a Prompt's Payment Status",
          new inquirer.Separator(),
          "Manage Usage Allowance",
          "Check Balances & Status",
          new inquirer.Separator(),
          "Exit",
        ],
      },
    ]);

    switch (action) {
      case "Send a new prompt":
        await handleSendPrompt();
        break;
      case "Check conversation history":
        await handleCheckHistory();
        break;
      case "Clear my conversation history":
        await handleClearHistory();
        break;
      case "Cancel a Pending Prompt":
        await handleCancelPrompt();
        break;
      case "Check a Prompt's Payment Status":
        await handleCheckEscrowStatus();
        break;
      case "Manage Usage Allowance":
        await handleManageAllowance();
        break;
      case "Check Balances & Status":
        await handleCheckBalance();
        break;
      case "Exit":
        console.log(chalk.bold("\nGoodbye!\n"));
        return;
    }
  }
}

/**
 * @description Main entry point for the CLI application.
 */
async function main() {
  console.log("\nWelcome to the Tradable AI Agent CLI!");
  console.log("=====================================");

  try {
    if (fs.existsSync(envPath)) {
      dotenv.config({ path: envPath, quiet: true });
    }

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

    let rpcUrl = process.env[selectedNetwork.rpcEnvVar];
    if (!rpcUrl) {
      console.log(chalk.yellow(`RPC URL for '${networkName}' not found in .env file.`));
      ({ rpcUrl } = await inquirer.prompt([
        {
          type: "input",
          name: "rpcUrl",
          message: `Please enter the RPC URL for ${networkName}:`,
        },
      ]));
    }

    if (!rpcUrl) {
      throw new Error("An RPC URL is required to connect.");
    }

    const spinner = ora(`Connecting to ${networkName}...`).start();

    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const baseSigner = new ethers.Wallet(privateKey, provider);
    signer = isSapphire ? wrapEthersSigner(baseSigner) : baseSigner;

    const { chainId } = await signer.provider.getNetwork();

    // --- Contract Instantiation ---
    const aiAgentContractName = isSapphire ? "SapphireAIAgent" : "EVMAIAgent";
    const aiAgentEscrowContractName = isSapphire ? "SapphireAIAgentEscrow" : "EVMAIAgentEscrow";

    const aiAgentArtifact = loadContractArtifact(aiAgentContractName);
    const aiAgentEscrowArtifact = loadContractArtifact(aiAgentEscrowContractName);

    let aiAgentAddress = process.env.AI_AGENT_CONTRACT_ADDRESS;
    if (!aiAgentAddress) {
      spinner.stop();
      console.log(chalk.yellow("AI Agent contract address not found in .env file."));
      ({ aiAgentAddress } = await inquirer.prompt([
        {
          type: "input",
          name: "aiAgentAddress",
          message: "Please enter the AI Agent contract address:",
        },
      ]));
    }

    if (!aiAgentAddress) {
      throw new Error("An AI Agent contract address is required.");
    }

    let aiAgentEscrowAddress = process.env.AI_AGENT_ESCROW_CONTRACT_ADDRESS;
    if (!aiAgentEscrowAddress) {
      spinner.stop();
      console.log(chalk.yellow("AI Agent Escrow contract address not found in .env file."));
      ({ aiAgentEscrowAddress } = await inquirer.prompt([
        {
          type: "input",
          name: "aiAgentEscrowAddress",
          message: "Please enter the AI Agent Escrow contract address:",
        },
      ]));
    }

    if (!aiAgentEscrowAddress) {
      throw new Error("An AI Agent Escrow contract address is required.");
    }

    aiAgentContract = new Contract(aiAgentAddress, aiAgentArtifact.abi, signer);
    aiAgentEscrowContract = new Contract(aiAgentEscrowAddress, aiAgentEscrowArtifact.abi, signer);

    spinner.succeed(chalk.green("Connected successfully!"));
    console.log(`\n--- Initial Account Status ---`);
    console.log(`   - Network: ${chalk.bold(networkName)} (Chain ID: ${chainId})`);
    console.log(`   - AI Agent Contract: ${chalk.cyan(aiAgentAddress)}`);
    console.log(`   - Payment Contract: ${chalk.cyan(aiAgentEscrowAddress)}`);

    if (isSapphire) {
      sapphireAuthToken = await loginSiwe(Number(chainId));
    } else {
      // For EVM, also need the token contract and ROFL public key
      const tokenAddress = process.env.TOKEN_CONTRACT_ADDRESS;
      if (!tokenAddress) {
        spinner.stop();
        console.log(chalk.yellow("ERC20 token contract address not found in .env file."));
        ({ tokenAddress } = await inquirer.prompt([
          {
            type: "input",
            name: "tokenAddress",
            message: "Please enter the ERC20 token contract address:",
          },
        ]));
      }

      if (!tokenAddress) {
        throw new Error("An ERC20 token contract address is required.");
      }

      roflPublicKey = process.env.PUBLIC_KEY;
      if (!roflPublicKey) {
        console.log(chalk.yellow("PUBLIC_KEY for the ROFL worker not found in your .env file."));
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

      const tokenArtifact = loadContractArtifact("AbleToken");
      tokenContract = new Contract(tokenAddress, tokenArtifact.abi, signer);
    }

    await handleCheckBalance();

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
