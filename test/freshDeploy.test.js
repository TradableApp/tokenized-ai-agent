const { expect } = require("chai");
const hre = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const {
  resolveDeployPlan,
  deployFreshPair,
  freshPairProblems,
  upgradePair,
} = require("../scripts/deploy");

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

  it("refuses a token whose symbol is not EXPECTED_FEE_TOKEN_SYMBOL before anything is deployed", async function () {
    const { able, deployer } = await loadFixture(tokensFixture);
    const nonce = await ethers.provider.getTransactionCount(deployer.address);

    // The mock token's symbol is ABLE (contracts/mocks/MockAbleToken.sol).
    await expect(
      deploy({
        TOKEN_CONTRACT_ADDRESS: await able.getAddress(),
        EXPECTED_FEE_TOKEN_SYMBOL: "SENSE",
      }),
    ).to.be.rejectedWith(
      /token\.symbol\(\) is "ABLE", which is not EXPECTED_FEE_TOKEN_SYMBOL[\s\S]*Nothing was sent/,
    );
    expect(await ethers.provider.getTransactionCount(deployer.address)).to.equal(nonce);
  });

  it("refuses a TOKEN_CONTRACT_ADDRESS with no contract before anything is deployed", async function () {
    const { deployer, treasury } = await loadFixture(tokensFixture);
    const nonce = await ethers.provider.getTransactionCount(deployer.address);

    await expect(deploy({ TOKEN_CONTRACT_ADDRESS: treasury.address })).to.be.rejectedWith(
      /no contract at TOKEN_CONTRACT_ADDRESS[\s\S]*Nothing was sent/,
    );
    expect(await ethers.provider.getTransactionCount(deployer.address)).to.equal(nonce);
  });

  describe("the fees", function () {
    const FEES = {
      INITIAL_PROMPT_FEE: "2500000000000000000",
      INITIAL_CANCELLATION_FEE: "1",
      INITIAL_METADATA_FEE: "0",
      INITIAL_BRANCH_FEE: "750000000000000000000",
    };

    it("prints each fee in wei and in whole tokens before anything is deployed, and the escrow starts with them", async function () {
      const { able } = await loadFixture(tokensFixture);

      const { aiAgentEscrow, lines } = await deploy({
        TOKEN_CONTRACT_ADDRESS: await able.getAddress(),
        ...FEES,
      });

      const first = lines.findIndex((l) => l.includes("Deploying EVMAIAgent proxy"));
      const before = lines.slice(0, first).join("\n");
      expect(before).to.include(
        "Prompt fee (INITIAL_PROMPT_FEE): 2500000000000000000 wei = 2.5 ABLE",
      );
      expect(before).to.include(
        "Cancellation fee (INITIAL_CANCELLATION_FEE): 1 wei = 0.000000000000000001 ABLE",
      );
      expect(before).to.include("Metadata fee (INITIAL_METADATA_FEE): 0 wei = 0.0 ABLE");
      expect(before).to.include(
        "Branch fee (INITIAL_BRANCH_FEE): 750000000000000000000 wei = 750.0 ABLE",
      );
      expect(await aiAgentEscrow.promptFee()).to.equal(2500000000000000000n);
      expect(await aiAgentEscrow.cancellationFee()).to.equal(1n);
      expect(await aiAgentEscrow.metadataUpdateFee()).to.equal(0n);
      expect(await aiAgentEscrow.branchFee()).to.equal(750000000000000000000n);
    });

    it("a dry run prints the whole plan and sends nothing", async function () {
      const { able, deployer } = await loadFixture(tokensFixture);
      const plan = planFor({ TOKEN_CONTRACT_ADDRESS: await able.getAddress(), ...FEES });
      const nonce = await ethers.provider.getTransactionCount(deployer.address);
      const lines = [];

      const result = await deployFreshPair(
        hre,
        { ...plan, dryRun: true },
        {
          log: (line) => lines.push(String(line)),
        },
      );

      const text = lines.join("\n");
      expect(result).to.equal(null);
      expect(text).to.include(
        "Prompt fee (INITIAL_PROMPT_FEE): 2500000000000000000 wei = 2.5 ABLE",
      );
      expect(text).to.include("DRY_RUN=1: nothing was sent");
      expect(text).to.not.include("Deploying EVMAIAgent proxy");
      expect(await ethers.provider.getTransactionCount(deployer.address)).to.equal(nonce);
    });

    it("prints the defaults a local network falls back to, marked as defaults", async function () {
      const { able } = await loadFixture(tokensFixture);

      const { aiAgentEscrow, text } = await deploy({
        TOKEN_CONTRACT_ADDRESS: await able.getAddress(),
      });

      expect(text()).to.include(
        "Prompt fee (INITIAL_PROMPT_FEE): 1000000000000000000 wei = 1.0 ABLE (default: INITIAL_PROMPT_FEE is not set)",
      );
      expect(await aiAgentEscrow.branchFee()).to.equal(ethers.parseEther("0.5"));
    });

    it("refuses a fee that is not a whole number of wei before anything is sent", async function () {
      const { able, deployer } = await loadFixture(tokensFixture);
      const plan = planFor({ TOKEN_CONTRACT_ADDRESS: await able.getAddress() });
      const nonce = await ethers.provider.getTransactionCount(deployer.address);

      await expect(
        deployFreshPair(hre, { ...plan, fees: { ...plan.fees, prompt: "1.5" } }, { log: () => {} }),
      ).to.be.rejectedWith(
        /INITIAL_PROMPT_FEE is not a whole number of wei[\s\S]*Nothing was sent/,
      );
      expect(await ethers.provider.getTransactionCount(deployer.address)).to.equal(nonce);
    });

    it("the read-back names each fee the escrow does not hold", async function () {
      const { able } = await loadFixture(tokensFixture);
      const plan = planFor({ TOKEN_CONTRACT_ADDRESS: await able.getAddress(), ...FEES });
      const pair = await deployFreshPair(hre, plan, { log: () => {} });
      const [deployer] = await ethers.getSigners();

      const problems = await freshPairProblems(hre, {
        plan: {
          ...plan,
          fees: { prompt: "3", cancellation: "4", metadata: "5", branch: "6" },
        },
        ...pair,
        deployer,
      });

      expect(problems).to.deep.equal([
        "escrow.promptFee() is 2500000000000000000, not INITIAL_PROMPT_FEE 3",
        "escrow.cancellationFee() is 1, not INITIAL_CANCELLATION_FEE 4",
        "escrow.metadataUpdateFee() is 0, not INITIAL_METADATA_FEE 5",
        "escrow.branchFee() is 750000000000000000000, not INITIAL_BRANCH_FEE 6",
      ]);
    });
  });

  it("says to record the pair and set DEPLOY_MODE=upgrade when ORACLE_ADDRESS is set too", async function () {
    const { able, oracle } = await loadFixture(tokensFixture);

    const { aiAgentAddress, aiAgentEscrowAddress, text } = await deploy({
      TOKEN_CONTRACT_ADDRESS: await able.getAddress(),
      ORACLE_ADDRESS: oracle.address,
    });

    expect(text()).to.include(
      `In .env.test: AI_AGENT_CONTRACT_ADDRESS=${aiAgentAddress}, AI_AGENT_ESCROW_CONTRACT_ADDRESS=${aiAgentEscrowAddress}, DEPLOY_MODE=upgrade.`,
    );
    expect(text()).to.not.include("authorize-oracle.js grant");
  });

  it("refuses an ORACLE_ADDRESS that is the deploy wallet before anything is sent", async function () {
    const { able, deployer } = await loadFixture(tokensFixture);
    const nonce = await ethers.provider.getTransactionCount(deployer.address);

    await expect(
      deploy({ TOKEN_CONTRACT_ADDRESS: await able.getAddress(), ORACLE_ADDRESS: deployer.address }),
    ).to.be.rejectedWith(/ORACLE_ADDRESS is the deploy wallet[\s\S]*Nothing was sent/);
    expect(await ethers.provider.getTransactionCount(deployer.address)).to.equal(nonce);
  });

  it("refuses the zero address as ORACLE_ADDRESS before anything is sent, dry run included", async function () {
    const { able, deployer } = await loadFixture(tokensFixture);
    const nonce = await ethers.provider.getTransactionCount(deployer.address);

    for (const extra of [{}, { DRY_RUN: "1" }]) {
      await expect(
        deploy({
          TOKEN_CONTRACT_ADDRESS: await able.getAddress(),
          ORACLE_ADDRESS: ethers.ZeroAddress,
          ...extra,
        }),
      ).to.be.rejectedWith(/ORACLE_ADDRESS is the zero address[\s\S]*Nothing was sent/);
    }
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

  it("upgradePair refuses a dry-run plan itself, before anything is read or sent", async function () {
    const [deployer] = await ethers.getSigners();
    const nonce = await ethers.provider.getTransactionCount(deployer.address);
    const env = {
      DEPLOY_MODE: "upgrade",
      DRY_RUN: "1",
      AI_AGENT_CONTRACT_ADDRESS: ethers.ZeroAddress.replace(/0$/, "1"),
      AI_AGENT_ESCROW_CONTRACT_ADDRESS: ethers.ZeroAddress.replace(/0$/, "2"),
    };
    const plan = resolveDeployPlan({
      networkName: "hardhat",
      envFile: ".env.test",
      fileEnv: env,
      processEnv: env,
    });
    const lines = [];
    await expect(upgradePair(hre, plan, { log: (line) => lines.push(line) })).to.be.rejectedWith(
      /an upgrade has no dry run[\s\S]*Nothing was sent/,
    );
    expect(lines).to.deep.equal([]);
    expect(await ethers.provider.getTransactionCount(deployer.address)).to.equal(nonce);
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

    async function pairWithOracle() {
      const { able, oracle, treasury } = await loadFixture(tokensFixture);
      const plan = planFor({
        TOKEN_CONTRACT_ADDRESS: await able.getAddress(),
        TREASURY_ADDRESS: treasury.address,
        ORACLE_ADDRESS: oracle.address,
      });
      const pair = await deployFreshPair(hre, plan, { log: () => {} });
      const [deployer, , , , stranger] = await ethers.getSigners();
      return { plan, pair, deployer, oracle, stranger };
    }

    // Ownership moves in two steps: the new owner accepts.
    async function handOver(contract, to) {
      await (await contract.transferOwnership(to.address)).wait();
      await (await contract.connect(to).acceptOwnership()).wait();
    }

    it("names each contract the deploy wallet does not own", async function () {
      const { plan, pair, deployer, stranger } = await pairWithOracle();
      await handOver(pair.aiAgent, stranger);
      await handOver(pair.aiAgentEscrow, stranger);

      const problems = await freshPairProblems(hre, { plan, ...pair, deployer });

      expect(problems).to.have.lengthOf(2);
      expect(problems[0]).to.equal(
        `agent.owner() is ${stranger.address}, not the deploy wallet ${deployer.address}`,
      );
      expect(problems[1]).to.equal(
        `escrow.owner() is ${stranger.address}, not the deploy wallet ${deployer.address}`,
      );
    });

    it("names ORACLE_ADDRESS without the oracle role, and the deploy wallet with it", async function () {
      const { plan, pair, deployer, oracle } = await pairWithOracle();
      await (await pair.aiAgent.addOracle(deployer.address)).wait();
      await (await pair.aiAgent.removeOracle(oracle.address)).wait();

      const problems = await freshPairProblems(hre, { plan, ...pair, deployer });

      expect(problems).to.deep.equal([
        `agent.isOracle(${oracle.address}) is false: ORACLE_ADDRESS does not hold the oracle role`,
        `agent.isOracle(${deployer.address}) is true: the deploy wallet holds the oracle role`,
      ]);
    });

    it("names the deploy wallet without the oracle role when it is meant to be the first oracle", async function () {
      const { able } = await loadFixture(tokensFixture);
      const plan = planFor({ TOKEN_CONTRACT_ADDRESS: await able.getAddress() });
      const pair = await deployFreshPair(hre, plan, { log: () => {} });
      const [deployer, , , , stranger] = await ethers.getSigners();
      await (await pair.aiAgent.addOracle(stranger.address)).wait();
      await (await pair.aiAgent.removeOracle(deployer.address)).wait();

      const problems = await freshPairProblems(hre, { plan, ...pair, deployer });

      expect(problems).to.deep.equal([
        `agent.isOracle(${deployer.address}) is false: the deploy wallet does not hold the oracle role`,
      ]);
    });
  });
});
