const { expect } = require("chai");
const hre = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const { resolveDeployPlan, deployFreshPair, freshPairProblems } = require("../scripts/deploy");

const { ethers, upgrades } = hre;

// The fresh path of scripts/deploy.js, run on the in-process network with the plan the script
// would build from ENV_FILE. The plan is resolved as for "hardhat", a local network: the treasury
// and the expected symbol are optional there, and set here where a test needs them.
describe("scripts/deploy — a fresh pair", function () {
  async function tokensFixture() {
    const [deployer, , oracle, treasury] = await ethers.getSigners();
    const able = await (await ethers.getContractFactory("MockAbleToken")).deploy();
    await able.waitForDeployment();
    const sense = await upgrades.deployProxy(
      await ethers.getContractFactory("SenseToken"),
      ["SENSE Points", "SENSE", ethers.parseEther("1000000"), deployer.address],
      { initializer: "initialize", kind: "uups" },
    );
    await sense.waitForDeployment();
    return { able, sense, deployer, oracle, treasury };
  }

  function planFor(fileEnv) {
    const full = { DEPLOY_MODE: "fresh", DOMAIN: "tradable.app", ...fileEnv };
    return resolveDeployPlan({
      networkName: "hardhat",
      envFile: ".env.test",
      fileEnv: full,
      processEnv: full,
    });
  }

  async function deploy(fileEnv) {
    const lines = [];
    const pair = await deployFreshPair(hre, planFor(fileEnv), {
      log: (line) => lines.push(String(line)),
    });
    return { ...pair, lines, text: () => lines.join("\n") };
  }

  it("gives the oracle role to ORACLE_ADDRESS and never to the deploy wallet", async function () {
    const { sense, deployer, oracle, treasury } = await loadFixture(tokensFixture);

    const { aiAgent, aiAgentEscrow } = await deploy({
      TOKEN_CONTRACT_ADDRESS: await sense.getAddress(),
      TREASURY_ADDRESS: treasury.address,
      ORACLE_ADDRESS: oracle.address,
      EXPECTED_FEE_TOKEN_SYMBOL: "SENSE",
    });

    expect(await aiAgent.isOracle(oracle.address)).to.equal(true);
    expect(await aiAgent.isOracle(deployer.address)).to.equal(false);
    expect(await aiAgent.owner()).to.equal(deployer.address);
    expect(await aiAgent.aiAgentEscrow()).to.equal(await aiAgentEscrow.getAddress());
    expect(await aiAgentEscrow.evmAIAgent()).to.equal(await aiAgent.getAddress());
    expect(await aiAgentEscrow.ableToken()).to.equal(await sense.getAddress());
    expect(await aiAgentEscrow.treasury()).to.equal(treasury.address);
  });

  it("makes the deploy wallet the first oracle when ORACLE_ADDRESS is unset, and prints the hand-over", async function () {
    const { able, deployer } = await loadFixture(tokensFixture);

    const { aiAgent, text } = await deploy({ TOKEN_CONTRACT_ADDRESS: await able.getAddress() });

    expect(await aiAgent.isOracle(deployer.address)).to.equal(true);
    expect(text()).to.include("scripts/authorize-oracle.js grant");
    expect(text()).to.include("scripts/authorize-oracle.js retire-deployer");
    // The e2e bring-up reads the two addresses from these lines.
    expect(text()).to.match(/EVMAIAgent proxy deployed to: 0x[0-9a-fA-F]{40}/);
    expect(text()).to.match(/EVMAIAgentEscrow proxy deployed to: 0x[0-9a-fA-F]{40}/);
  });

  it("fails after deploying when the token's symbol is not EXPECTED_FEE_TOKEN_SYMBOL, and says which check failed", async function () {
    const { able } = await loadFixture(tokensFixture);

    // The mock token's symbol is ABLE (contracts/mocks/MockAbleToken.sol).
    await expect(
      deploy({
        TOKEN_CONTRACT_ADDRESS: await able.getAddress(),
        EXPECTED_FEE_TOKEN_SYMBOL: "SENSE",
      }),
    ).to.be.rejectedWith(
      /token\.symbol\(\)[\s\S]*EXPECTED_FEE_TOKEN_SYMBOL[\s\S]*agent 0x[0-9a-fA-F]{40}/,
    );
  });

  it("refuses an ORACLE_ADDRESS that is the deploy wallet before anything is sent", async function () {
    const { able, deployer } = await loadFixture(tokensFixture);
    const nonce = await ethers.provider.getTransactionCount(deployer.address);

    await expect(
      deploy({ TOKEN_CONTRACT_ADDRESS: await able.getAddress(), ORACLE_ADDRESS: deployer.address }),
    ).to.be.rejectedWith(/ORACLE_ADDRESS is the deploy wallet[\s\S]*Nothing was sent/);
    expect(await ethers.provider.getTransactionCount(deployer.address)).to.equal(nonce);
  });

  it("refuses a plan that is not fresh", async function () {
    const plan = resolveDeployPlan({
      networkName: "hardhat",
      envFile: ".env.test",
      fileEnv: {
        DEPLOY_MODE: "upgrade",
        AI_AGENT_CONTRACT_ADDRESS: ethers.ZeroAddress.replace(/0$/, "1"),
        AI_AGENT_ESCROW_CONTRACT_ADDRESS: ethers.ZeroAddress.replace(/0$/, "2"),
      },
      processEnv: {
        DEPLOY_MODE: "upgrade",
        AI_AGENT_CONTRACT_ADDRESS: ethers.ZeroAddress.replace(/0$/, "1"),
        AI_AGENT_ESCROW_CONTRACT_ADDRESS: ethers.ZeroAddress.replace(/0$/, "2"),
      },
    });
    await expect(deployFreshPair(hre, plan, { log: () => {} })).to.be.rejectedWith(/fresh/);
  });

  describe("the read-back", function () {
    it("passes on the pair just deployed, and names each link, token and treasury that differs", async function () {
      const { able, sense, oracle, treasury } = await loadFixture(tokensFixture);
      const plan = planFor({
        TOKEN_CONTRACT_ADDRESS: await able.getAddress(),
        TREASURY_ADDRESS: treasury.address,
        ORACLE_ADDRESS: oracle.address,
      });
      const first = await deployFreshPair(hre, plan, { log: () => {} });
      const second = await deployFreshPair(hre, plan, { log: () => {} });
      const [deployer] = await ethers.getSigners();

      expect(await freshPairProblems(hre, { plan, ...first, deployer })).to.deep.equal([]);

      // The first agent with the second escrow (each linked to its own partner), and a plan
      // naming another token and treasury than the escrow holds.
      const problems = await freshPairProblems(hre, {
        plan: { ...plan, token: await sense.getAddress(), treasury: oracle.address },
        aiAgent: first.aiAgent,
        aiAgentEscrow: second.aiAgentEscrow,
        deployer,
      });
      const text = problems.join("\n");
      expect(text).to.include("agent.aiAgentEscrow()");
      expect(text).to.include("escrow.evmAIAgent()");
      expect(text).to.include("escrow.ableToken()");
      expect(text).to.include("escrow.treasury()");
    });
  });
});
