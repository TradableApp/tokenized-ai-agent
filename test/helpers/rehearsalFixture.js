const { ethers, upgrades } = require("hardhat");

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
 * network and chain they were read from, and the steps recorded so far.
 */
async function snapshotText(contracts, state, extra = {}) {
  return JSON.stringify({
    version: 2,
    network: "hardhat",
    chainId: "31337",
    pair: await pairOf(contracts),
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
  const lines = [];
  const log = (line) => lines.push(String(line));
  return {
    contracts,
    state,
    lines,
    log,
    deployer,
    oracle,
    treasury,
    safe,
    safeContractAddress,
    stranger,
  };
}

module.exports = {
  PROMPT_FEE,
  REHEARSAL_FEE,
  asText,
  pairOf,
  snapshotText,
  versionOneText,
  deployRehearsalFixture,
};
