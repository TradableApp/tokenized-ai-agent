/**
 * Lists the escrow and its treasury on a fee token that moves only to or from addresses its
 * owner has listed (a transfer passes when either end is listed). Unlisted, the escrow cannot
 * take or pay out a prompt's payment, and every fee a user pays straight to the treasury (a
 * cancellation, a branch, a rename or delete) is refused. An account that is the token's owner
 * is exempt only while it stays the owner, and the token cannot say whether it is also listed by
 * name, so such an account is listed again on every run (setTransferExempt is idempotent) and
 * stays listed when ownership moves; --check reports it as exempt as the owner and passes.
 *
 * It checks that the escrow pays in TOKEN_CONTRACT_ADDRESS, then lists whichever of the two is
 * not listed yet, or is the owner, and reads both back. When the signer is not the token's owner
 * (the Safe owns it on mainnet), it sends nothing and prints the calls as Safe Transaction
 * Builder JSON. With
 * --check it only reads, and fails while either is unlisted. A token that keeps no list needs
 * nothing, unless its symbol is that of a token that does (LISTED_TRANSFER_SYMBOLS): then it is not
 * the token it says it is, and the script refuses. The token's symbol must be
 * EXPECTED_FEE_TOKEN_SYMBOL when that is set, and on a live network it must be set.
 *
 *   ENV_FILE=.env.base-testnet HARDHAT_NETWORK=baseSepolia node scripts/list-fee-token-exempt.js [--check]
 *
 * (or `bun run list-fee-token-exempt:<network> [--check]`). Reads TOKEN_CONTRACT_ADDRESS,
 * AI_AGENT_ESCROW_CONTRACT_ADDRESS, AI_AGENT_CONTRACT_ADDRESS and EXPECTED_FEE_TOKEN_SYMBOL, from
 * ENV_FILE alone on a live network, and prints them before anything is read or sent; the
 * treasury is read from the escrow. On Base mainnet, sending needs DEPLOY_MAINNET_CONFIRMED=1.
 */
const chalk = require("chalk");
const { ethers } = require("ethers");

const { describeShape } = require("./lib/settingShape");
const { readEnvFile } = require("./lib/envFile");
const { captureTypedSettings, typedSettings, typedOnlyProblems } = require("./lib/typedSettings");
const { LOCAL_NETWORKS } = require("./lib/networks");
const { PAIR_TARGET_VARS, resolveTarget, shown } = require("./lib/pairTarget");
const { isEmptyRevert } = require("./rehearsal/token");
// The oracle's describer of an error: one line, no address, no configured secret, no stack.
const { describeError } = require("../oracle/src/errorDescription");

const MAINNET_NETWORK = "base";
const CONFIRM_VAR = "DEPLOY_MAINNET_CONFIRMED";
// Symbols of the fee tokens that move only to or from listed addresses: SenseToken (from the
// sense-contracts repository, compiled here by contracts/test/SenseTokenImport.sol). A token with
// one of these symbols that answers as one with no list is not that token.
const LISTED_TRANSFER_SYMBOLS = Object.freeze(["SENSE"]);
const TOKEN_ABI = [
  "function symbol() view returns (string)",
  "function owner() view returns (address)",
  "function isTransferExempt(address account) view returns (bool)",
  "function setTransferExempt(address account, bool exempt)",
];

/** One of the script's own refusals: its message says what happened and what to do. */
class ListingError extends Error {
  constructor(message) {
    super(message);
    this.name = "ListingError";
  }
}

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/**
 * The calls as a Safe Transaction Builder batch, ready to save as a file and load with "Load"
 * in the builder. `createdAt` is milliseconds since the epoch.
 */
function safeBatch({ chainId, safe, token, accounts, createdAt }) {
  const iface = new ethers.Interface(TOKEN_ABI);
  return {
    version: "1.0",
    chainId: String(chainId),
    createdAt,
    meta: {
      name: "List the escrow and treasury on the fee token",
      description: `setTransferExempt(account, true) on ${token} for: ${accounts.join(", ")}`,
      createdFromSafeAddress: safe,
    },
    transactions: accounts.map((account) => ({
      to: token,
      value: "0",
      data: iface.encodeFunctionData("setTransferExempt", [account, true]),
      contractMethod: null,
      contractInputsValues: null,
    })),
  };
}

/**
 * Whether the token keeps a list, and if it does whether each address is on it. A token that
 * answers for one address and reverts with no data for another is neither, and is refused.
 */
async function readListing({ token, accounts }) {
  const listed = {};
  for (const [name, address] of Object.entries(accounts)) {
    try {
      listed[name] = (await token.isTransferExempt(address)) === true;
    } catch (error) {
      if (!isEmptyRevert(error)) throw error;
      const answered = Object.keys(listed);
      if (answered.length === 0) return { restricted: false, listed: null };
      throw new ListingError(
        `token.isTransferExempt answered for the ${answered.map((n) => `${n} ${accounts[n]}`).join(" and ")} but reverted with no data for the ${name} ${address}, so whether it keeps a list cannot be told. Check TOKEN_CONTRACT_ADDRESS and the token.`,
      );
    }
  }
  return { restricted: true, listed };
}

/** The token's symbol, refused when it cannot be read or is not `expectedSymbol` (when set). */
async function readSymbol({ token, tokenAddress, expectedSymbol }) {
  let symbol;
  try {
    symbol = await token.symbol();
  } catch {
    throw new ListingError(
      `token.symbol() could not be read from TOKEN_CONTRACT_ADDRESS ${tokenAddress}. Nothing was sent.`,
    );
  }
  if (expectedSymbol && symbol !== expectedSymbol) {
    throw new ListingError(
      `token.symbol() is ${JSON.stringify(symbol)}, which is not EXPECTED_FEE_TOKEN_SYMBOL: TOKEN_CONTRACT_ADDRESS ${tokenAddress} is not the token this pair was set up for. Nothing was sent.`,
    );
  }
  return symbol;
}

/**
 * Checks, and unless `check` is set lists, the escrow and its treasury on `tokenAddress`.
 * Returns what it found, what it sent, and the Safe batch it printed (or null).
 */
async function listFeeTokenExempt({
  tokenAddress,
  escrow,
  signer,
  provider,
  check,
  env,
  networkName,
  expectedSymbol,
  log,
  now = Date.now,
}) {
  if (!expectedSymbol && !LOCAL_NETWORKS.has(networkName)) {
    throw new ListingError(
      `EXPECTED_FEE_TOKEN_SYMBOL must be set on ${networkName}: the token's symbol is checked against it, so a listing is never judged on the wrong token. Nothing was sent.`,
    );
  }
  const escrowAddress = await escrow.getAddress();
  const escrowToken = await escrow.ableToken();
  if (!same(escrowToken, tokenAddress)) {
    throw new ListingError(
      `escrow.ableToken() is ${escrowToken}, not TOKEN_CONTRACT_ADDRESS ${tokenAddress}: the escrow pays in another token. Nothing was sent.`,
    );
  }
  const treasury = await escrow.treasury();
  const accounts = { escrow: escrowAddress, treasury };
  const token = new ethers.Contract(tokenAddress, TOKEN_ABI, signer ?? provider);
  const symbol = await readSymbol({ token, tokenAddress, expectedSymbol });
  const named = `The fee token ${tokenAddress} (symbol ${JSON.stringify(symbol)})`;
  const before = await readListing({ token, accounts });
  if (!before.restricted) {
    if (LISTED_TRANSFER_SYMBOLS.includes(symbol)) {
      throw new ListingError(
        `${named} answers as a token that keeps no list, but its symbol ${JSON.stringify(symbol)} is that of a token that moves only to or from listed addresses: it is not the token it says it is. Check TOKEN_CONTRACT_ADDRESS and the token. Nothing was sent.`,
      );
    }
    log(`${named} does not restrict who it moves between: nothing to list. Nothing was sent.`);
    return { restricted: false, listed: null, sent: [], safeBatch: null };
  }
  log(`${named} moves only to or from listed addresses.`);
  // The owner is exempt by being the owner, and isTransferExempt cannot tell that from a listing
  // by name (the list itself has no getter). The owner's exemption ends when ownership moves, so
  // an account that is the owner is listed again on every run; setTransferExempt is idempotent.
  const owner = await token.owner();
  const isOwner = (name) => same(accounts[name], owner);
  for (const [name, address] of Object.entries(accounts)) {
    let state = before.listed[name] ? "already listed" : "not listed";
    if (isOwner(name)) {
      state = check
        ? "exempt as the owner; by-name listing cannot be read from the chain"
        : "the token's owner, so its by-name listing cannot be read; listed again";
    }
    log(`The ${name} ${address} is ${state}.`);
  }
  const missing = Object.keys(accounts).filter((name) => !before.listed[name]);
  const toList = Object.keys(accounts).filter((name) => !before.listed[name] || isOwner(name));

  if (check) {
    if (missing.length > 0) {
      throw new ListingError(
        `${missing.map((name) => `The ${name} ${accounts[name]} is not listed`).join("; ")} on the fee token ${tokenAddress}. While it is not, fees on this pair are refused. Run this script without --check (as the token's owner, or through the Safe batch it prints).`,
      );
    }
    log(chalk.green("Both the escrow and the treasury are listed."));
    return { restricted: true, listed: before.listed, sent: [], safeBatch: null };
  }
  if (toList.length === 0) {
    log(chalk.green("Both are already listed. Nothing was sent."));
    return { restricted: true, listed: before.listed, sent: [], safeBatch: null };
  }

  if (!same(owner, signer.address)) {
    const { chainId } = await provider.getNetwork();
    const batch = safeBatch({
      chainId,
      safe: owner,
      token: tokenAddress,
      accounts: toList.map((name) => accounts[name]),
      createdAt: now(),
    });
    log(
      `The token's owner is ${owner}, not the signer ${signer.address}. Nothing was sent. Save the JSON below as a file, load it in the owner Safe's Transaction Builder, simulate, execute, then run this script with --check:`,
    );
    log(JSON.stringify(batch, null, 2));
    return { restricted: true, listed: before.listed, sent: [], safeBatch: batch };
  }

  if (networkName === MAINNET_NETWORK && env[CONFIRM_VAR] !== "1") {
    throw new ListingError(
      `${CONFIRM_VAR} is ${describeShape(env[CONFIRM_VAR])}; listing on ${MAINNET_NETWORK} needs exactly ${CONFIRM_VAR}=1. Nothing was sent.`,
    );
  }
  const sent = [];
  for (const name of toList) {
    const receipt = await (await token.setTransferExempt(accounts[name], true)).wait();
    log(`token.setTransferExempt(${accounts[name]}, true) tx: ${receipt.hash} (the ${name})`);
    sent.push(receipt.hash);
  }
  const after = await readListing({ token, accounts });
  const stillMissing = Object.keys(accounts).filter((name) => !after.listed?.[name]);
  if (stillMissing.length > 0) {
    throw new ListingError(
      `After listing, ${stillMissing.map((name) => `the ${name} ${accounts[name]}`).join(" and ")} still reads as not listed. Check the token before any user prompts.`,
    );
  }
  log(chalk.green("Read back: the escrow and the treasury are listed."));
  return { restricted: true, listed: after.listed, sent, safeBatch: null };
}

const LISTING_VARS = Object.freeze({
  ...PAIR_TARGET_VARS,
  expectedSymbol: "EXPECTED_FEE_TOKEN_SYMBOL",
});

/**
 * The agent, escrow, token and expected symbol this run acts on, or a refusal listing every
 * problem. On a live network all four come from ENV_FILE alone and must be set; locally the
 * escrow and the token are needed.
 */
function resolveListingTarget({ networkName, envFile, fileEnv, processEnv }) {
  const { values, problems } = resolveTarget({
    networkName,
    envFile,
    fileEnv,
    processEnv,
    vars: LISTING_VARS,
    addressKeys: Object.keys(PAIR_TARGET_VARS),
    requiredLive: Object.keys(LISTING_VARS),
    requiredLocal: ["escrow", "token"],
    howToRun:
      "Run it through its package script (for example bun run list-fee-token-exempt:base-testnet).",
  });
  if (problems.length > 0) {
    throw new ListingError(
      `Fee token listing on ${networkName} refused:\n  - ${problems.join("\n  - ")}\nNothing was sent.`,
    );
  }
  return values;
}

/** The run's header: the network, the mode, the signer and the pair it acts on. */
function targetLines({ networkName, envFile, check, signer, target }) {
  const expected = target.expectedSymbol
    ? ` (expected symbol ${target.expectedSymbol})`
    : " (no expected symbol)";
  return [
    `--- Fee token listing on ${chalk.bold(networkName)}${check ? " · --check (read only)" : ""} · signer=${signer} ---`,
    `  Agent: ${shown(target.agent)}`,
    `  Escrow: ${shown(target.escrow)}`,
    `  Fee token: ${shown(target.token)}${expected}`,
    `  Settings from: ${envFile ?? "the environment (ENV_FILE is not set)"}`,
  ];
}

async function main() {
  // What the shell held before Hardhat loads the env files over it (hardhat.config.js): the
  // mainnet confirmation is read from that alone. Taken afresh: this script is run with node.
  captureTypedSettings(process.env, { fresh: true });
  const typedEnv = typedSettings(process.env);
  const hre = require("hardhat");
  const confirmProblems = typedOnlyProblems({
    names: [CONFIRM_VAR],
    typedEnv,
    processEnv: process.env,
    envFile: process.env.ENV_FILE,
  });
  if (confirmProblems.length > 0) {
    throw new ListingError(
      `Fee token listing refused:\n  - ${confirmProblems.join("\n  - ")}\nNothing was sent.`,
    );
  }
  const env = { ...process.env, [CONFIRM_VAR]: typedEnv[CONFIRM_VAR] };
  const networkName = hre.network.name;
  const unknown = process.argv.slice(2).filter((arg) => arg !== "--check");
  if (unknown.length > 0) {
    throw new ListingError("The only option is --check. Nothing was sent.");
  }
  const check = process.argv.includes("--check");
  const target = resolveListingTarget({
    networkName,
    envFile: env.ENV_FILE,
    fileEnv: readEnvFile(env.ENV_FILE),
    processEnv: env,
  });
  const [signer] = await hre.ethers.getSigners();
  const log = (line) => console.log(line);
  for (const line of targetLines({
    networkName,
    envFile: env.ENV_FILE,
    check,
    signer: signer.address,
    target,
  })) {
    log(line);
  }
  const escrow = await hre.ethers.getContractAt("EVMAIAgentEscrow", target.escrow);
  await listFeeTokenExempt({
    tokenAddress: target.token,
    escrow,
    signer,
    provider: hre.ethers.provider,
    check,
    env,
    networkName,
    expectedSymbol: target.expectedSymbol,
    log,
  });
}

/**
 * The one line a failed run prints. A refusal the script wrote itself is printed whole. Any other
 * error is described without its stack and without an address: a provider's error carries the
 * request's address in its message, and that address usually holds the account's access key.
 *
 * @param {unknown} error
 * @returns {string}
 */
function failureLine(error) {
  return error instanceof ListingError ? error.message : describeError(error);
}

module.exports = {
  listFeeTokenExempt,
  resolveListingTarget,
  targetLines,
  safeBatch,
  failureLine,
  ListingError,
  TOKEN_ABI,
  LISTED_TRANSFER_SYMBOLS,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(chalk.red(failureLine(error)));
    process.exitCode = 1;
  });
}
