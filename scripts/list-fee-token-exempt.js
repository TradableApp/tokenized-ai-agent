/**
 * Lists the escrow and its treasury on a fee token that moves only to or from addresses its
 * owner has listed (a transfer passes when either end is listed). Unlisted, the escrow cannot
 * take or pay out a prompt's payment, and every fee a user pays straight to the treasury (a
 * cancellation, a branch, a rename or delete) is refused. The treasury is listed by name even
 * when it is the token's owner.
 *
 * It checks that the escrow pays in TOKEN_CONTRACT_ADDRESS, then lists whichever of the two is
 * not listed yet and reads both back. When the signer is not the token's owner (the Safe owns it
 * on mainnet), it sends nothing and prints the calls as Safe Transaction Builder JSON. With
 * --check it only reads, and fails while either is unlisted. A token that keeps no list needs
 * nothing.
 *
 *   ENV_FILE=.env.base-testnet HARDHAT_NETWORK=baseSepolia node scripts/list-fee-token-exempt.js [--check]
 *
 * (or `bun run list-fee-token-exempt:<network> [--check]`). Reads TOKEN_CONTRACT_ADDRESS and
 * AI_AGENT_ESCROW_CONTRACT_ADDRESS; the treasury is read from the escrow. On Base mainnet,
 * sending needs DEPLOY_MAINNET_CONFIRMED=1.
 */
const chalk = require("chalk");
const { ethers } = require("ethers");

const { describeShape, isSet } = require("./lib/settingShape");
const { isEmptyRevert } = require("./rehearsal/token");

const MAINNET_NETWORK = "base";
const CONFIRM_VAR = "DEPLOY_MAINNET_CONFIRMED";
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const TOKEN_ABI = [
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

/** Whether the token keeps a list, and if it does whether each address is on it. */
async function readListing({ token, accounts }) {
  try {
    const listed = {};
    for (const [name, address] of Object.entries(accounts)) {
      listed[name] = (await token.isTransferExempt(address)) === true;
    }
    return { restricted: true, listed };
  } catch (error) {
    if (isEmptyRevert(error)) return { restricted: false, listed: null };
    throw error;
  }
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
  log,
  now = Date.now,
}) {
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
  const before = await readListing({ token, accounts });
  if (!before.restricted) {
    log(
      `The fee token ${tokenAddress} does not restrict who it moves between: nothing to list. Nothing was sent.`,
    );
    return { restricted: false, listed: null, sent: [], safeBatch: null };
  }
  for (const [name, address] of Object.entries(accounts)) {
    log(`The ${name} ${address} is ${before.listed[name] ? "already listed" : "not listed"}.`);
  }
  const missing = Object.keys(accounts).filter((name) => !before.listed[name]);

  if (check) {
    if (missing.length > 0) {
      throw new ListingError(
        `${missing.map((name) => `The ${name} ${accounts[name]} is not listed`).join("; ")} on the fee token ${tokenAddress}. While it is not, fees on this pair are refused. Run this script without --check (as the token's owner, or through the Safe batch it prints).`,
      );
    }
    log(chalk.green("Both the escrow and the treasury are listed."));
    return { restricted: true, listed: before.listed, sent: [], safeBatch: null };
  }
  if (missing.length === 0) {
    log(chalk.green("Both are already listed. Nothing was sent."));
    return { restricted: true, listed: before.listed, sent: [], safeBatch: null };
  }

  const owner = await token.owner();
  if (!same(owner, signer.address)) {
    const { chainId } = await provider.getNetwork();
    const batch = safeBatch({
      chainId,
      safe: owner,
      token: tokenAddress,
      accounts: missing.map((name) => accounts[name]),
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
  for (const name of missing) {
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

async function main() {
  const hre = require("hardhat");
  const { env } = process;
  for (const name of ["TOKEN_CONTRACT_ADDRESS", "AI_AGENT_ESCROW_CONTRACT_ADDRESS"]) {
    if (!isSet(env[name]) || !ADDRESS_RE.test(env[name])) {
      throw new ListingError(
        `${name} must be an address (it is ${describeShape(env[name])}). Nothing was sent.`,
      );
    }
  }
  const unknown = process.argv.slice(2).filter((arg) => arg !== "--check");
  if (unknown.length > 0) {
    throw new ListingError("The only option is --check. Nothing was sent.");
  }
  const check = process.argv.includes("--check");
  const [signer] = await hre.ethers.getSigners();
  const escrow = await hre.ethers.getContractAt(
    "EVMAIAgentEscrow",
    env.AI_AGENT_ESCROW_CONTRACT_ADDRESS,
  );
  const log = (line) => console.log(line);
  log(
    `--- Fee token listing on ${chalk.bold(hre.network.name)}${check ? " · --check (read only)" : ""} · signer=${signer.address} ---`,
  );
  await listFeeTokenExempt({
    tokenAddress: env.TOKEN_CONTRACT_ADDRESS,
    escrow,
    signer,
    provider: hre.ethers.provider,
    check,
    env,
    networkName: hre.network.name,
    log,
  });
}

module.exports = { listFeeTokenExempt, safeBatch, ListingError, TOKEN_ABI };

if (require.main === module) {
  main().catch((error) => {
    console.error(chalk.red(error instanceof ListingError ? error.message : error?.stack));
    process.exitCode = 1;
  });
}
