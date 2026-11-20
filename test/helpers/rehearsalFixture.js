const fs = require("fs");
const os = require("os");
const path = require("path");
const { ethers, upgrades } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const { readState } = require("../../scripts/admin-rehearsal");

const DOMAIN = "tradable.app";
const PROMPT_FEE = ethers.parseEther("1");
const REHEARSAL_FEE = ethers.parseEther("2");

const asText = (state) => Object.fromEntries(Object.entries(state).map(([k, v]) => [k, String(v)]));

async function pairOf(contracts) {
  return {
    agent: await contracts.aiAgent.getAddress(),
    escrow: await contracts.escrow.getAddress(),
  };
}

/**
 * A snapshot file's text as the script writes it (version 2): the baseline values, the pair,
 * network and chain they were read from, the Safe, and the steps recorded so far.
 */
async function snapshotText(contracts, state, safe, extra = {}) {
  if (!safe) throw new Error("snapshotText needs the Safe the snapshot names");
  return JSON.stringify({
    version: 2,
    network: "hardhat",
    chainId: "31337",
    pair: await pairOf(contracts),
    safe,
    rehearsalPromptFee: String(REHEARSAL_FEE),
    baseline: asText(state),
    steps: {},
    confirmed: false,
    ...extra,
  });
}

/** A snapshot as versions before steps were recorded wrote it: the values beside the pair. */
async function versionOneText(contracts, state, extra = {}) {
  return JSON.stringify({ ...asText(state), pair: await pairOf(contracts), ...extra });
}

/** Step records of a forward run that offered both proxies to the Safe. */
const OFFERS_DONE = Object.freeze({
  "agent-owner-to-safe": { status: "done", txHash: `0x${"a1".repeat(32)}`, blockNumber: 1 },
  "escrow-owner-to-safe": { status: "done", txHash: `0x${"a2".repeat(32)}`, blockNumber: 1 },
});

/** An agent and escrow owned by the deploy wallet, and a contract to stand in for the Safe. */
async function deployRehearsalFixture() {
  const [deployer, oracle, treasury, safe, stranger] = await ethers.getSigners();

  const token = await (await ethers.getContractFactory("MockAbleToken")).deploy();
  await token.waitForDeployment();

  const aiAgent = await upgrades.deployProxy(
    await ethers.getContractFactory("EVMAIAgent"),
    [DOMAIN, oracle.address, deployer.address],
    { initializer: "initialize", kind: "uups" },
  );
  await aiAgent.waitForDeployment();

  const escrow = await upgrades.deployProxy(
    await ethers.getContractFactory("EVMAIAgentEscrow"),
    [
      await token.getAddress(),
      await aiAgent.getAddress(),
      treasury.address,
      deployer.address,
      PROMPT_FEE,
      ethers.parseEther("0.1"),
      ethers.parseEther("0.1"),
      ethers.parseEther("0.5"),
    ],
    { initializer: "initialize", kind: "uups" },
  );
  await escrow.waitForDeployment();
  await aiAgent.connect(deployer).setAgentEscrow(await escrow.getAddress());

  const safeContract = await (await ethers.getContractFactory("MockAbleToken")).deploy();
  await safeContract.waitForDeployment();
  const safeContractAddress = await safeContract.getAddress();

  const contracts = { aiAgent, escrow };
  const state = await readState(contracts);
  return {
    contracts,
    state,
    deployer,
    oracle,
    treasury,
    safe,
    safeContractAddress,
    stranger,
  };
}

/**
 * The fixture with a log of its own: the deployed state is shared between tests, a log kept in
 * the fixture would be too.
 */
async function loadRehearsal() {
  const fixture = await loadFixture(deployRehearsalFixture);
  const lines = [];
  return { ...fixture, lines, log: (line) => lines.push(String(line)) };
}

const scratchDirs = [];

/** A new folder under the system's temporary folder, removed by `removeScratchDirs`. */
function scratchDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

/** Removes every folder `scratchDir` made, and only those. */
function removeScratchDirs() {
  for (const dir of scratchDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = {
  loadRehearsal,
  scratchDir,
  removeScratchDirs,
  OFFERS_DONE,
  PROMPT_FEE,
  REHEARSAL_FEE,
  asText,
  pairOf,
  snapshotText,
  versionOneText,
  deployRehearsalFixture,
};
