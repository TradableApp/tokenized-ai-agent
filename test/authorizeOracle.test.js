const { expect } = require("chai");
const hre = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const { resolveDeployPlan, deployFreshPair } = require("../scripts/deploy");
const {
  runHandover,
  PHASES,
  resolveHandoverTarget,
  targetLines,
} = require("../scripts/authorize-oracle");

const { ethers } = hre;

const MOCK_CID = "QmXg9j4f8zYf8t7f8zYf8t7f8zYf8t7f8zYf8t7f8zYf8t7";
const CID_BUNDLE = {
  conversationCID: MOCK_CID,
  metadataCID: MOCK_CID,
  promptMessageCID: MOCK_CID,
  answerMessageCID: MOCK_CID,
  searchDeltaCID: MOCK_CID,
};
// The default prompt fee of a fresh deploy is 1 token (scripts/deploy.js); 10 tokens pay for
// every prompt a test here sends.
const USER_TOKENS = ethers.parseEther("10");

// The two phases of runbook section 1.1 after a fresh deploy, where the deploy wallet is the
// first oracle: grant the ROFL signer the role, see it answer, and only then retire the deploy
// wallet's role.
describe("scripts/authorize-oracle — moving the oracle role off the deploy wallet", function () {
  async function freshPairFixture() {
    const [deployer, user, rofl, , stranger] = await ethers.getSigners();
    const token = await (await ethers.getContractFactory("MockAbleToken")).deploy();
    await token.waitForDeployment();
    const fileEnv = {
      DEPLOY_MODE: "fresh",
      DOMAIN: "tradable.app",
      TOKEN_CONTRACT_ADDRESS: await token.getAddress(),
    };
    const plan = resolveDeployPlan({
      networkName: "hardhat",
      envFile: ".env.test",
      fileEnv,
      processEnv: fileEnv,
    });
    const { aiAgent, aiAgentEscrow } = await deployFreshPair(hre, plan, { log: () => {} });

    await token.mint(user.address, USER_TOKENS);
    await token.connect(user).approve(await aiAgentEscrow.getAddress(), USER_TOKENS);
    await aiAgentEscrow.connect(user).setSpendingLimit(USER_TOKENS, (await time.latest()) + 3600);

    return { aiAgent, aiAgentEscrow, deployer, user, rofl, stranger };
  }

  async function answerOnePrompt({ aiAgent, aiAgentEscrow, user }, answerer) {
    const receipt = await (await aiAgentEscrow.connect(user).initiatePrompt(0, "0x", "0x")).wait();
    const topic = aiAgent.interface.getEvent("PromptSubmitted").topicHash;
    const log = receipt.logs.find((l) => l.topics[0] === topic);
    const { promptMessageId, answerMessageId } = aiAgent.interface.parseLog(log).args;
    const answer = await (
      await aiAgent.connect(answerer).submitAnswer(promptMessageId, answerMessageId, CID_BUNDLE)
    ).wait();
    return answer.hash;
  }

  function handover(fixture, phase, env, signer = fixture.deployer) {
    const lines = [];
    fixture.lines = lines;
    return runHandover({
      phase,
      agent: fixture.aiAgent,
      signer,
      provider: ethers.provider,
      env,
      networkName: "hardhat",
      log: (line) => lines.push(String(line)),
    });
  }

  const nonceOf = (signer) => ethers.provider.getTransactionCount(signer.address);

  it("has exactly the two phases", function () {
    expect([...PHASES]).to.deep.equal(["grant", "retire-deployer"]);
  });

  it("grant then retire-deployer leaves the ROFL signer with the role and the deploy wallet without", async function () {
    const fixture = await loadFixture(freshPairFixture);
    const { aiAgent, deployer, rofl } = fixture;
    expect(await aiAgent.isOracle(deployer.address)).to.equal(true);

    await handover(fixture, "grant", { ORACLE_ADDRESS: rofl.address });
    expect(await aiAgent.isOracle(rofl.address)).to.equal(true);
    expect(await aiAgent.isOracle(deployer.address)).to.equal(true);

    const answerTx = await answerOnePrompt(fixture, rofl);
    await handover(fixture, "retire-deployer", {
      ORACLE_ADDRESS: rofl.address,
      ANSWER_TX_HASH: answerTx,
    });

    expect(await aiAgent.isOracle(rofl.address)).to.equal(true);
    expect(await aiAgent.isOracle(deployer.address)).to.equal(false);
  });

  it("grant sends nothing when the address already holds the role", async function () {
    const fixture = await loadFixture(freshPairFixture);
    await handover(fixture, "grant", { ORACLE_ADDRESS: fixture.rofl.address });
    const nonce = await nonceOf(fixture.deployer);

    await handover(fixture, "grant", { ORACLE_ADDRESS: fixture.rofl.address });

    expect(await nonceOf(fixture.deployer)).to.equal(nonce);
    expect(fixture.lines.join("\n")).to.match(/already holds the oracle role/);
  });

  it("grant refuses with no ORACLE_ADDRESS, a malformed one, or the signer itself", async function () {
    const fixture = await loadFixture(freshPairFixture);
    const nonce = await nonceOf(fixture.deployer);

    await expect(handover(fixture, "grant", {})).to.be.rejectedWith(/ORACLE_ADDRESS is required/);
    await expect(handover(fixture, "grant", { ORACLE_ADDRESS: "0x1234" })).to.be.rejectedWith(
      /ORACLE_ADDRESS is not an address \(6 characters/,
    );
    await expect(
      handover(fixture, "grant", { ORACLE_ADDRESS: fixture.deployer.address }),
    ).to.be.rejectedWith(/ORACLE_ADDRESS is the signer/);

    expect(await nonceOf(fixture.deployer)).to.equal(nonce);
  });

  it("retire-deployer refuses before grant", async function () {
    const fixture = await loadFixture(freshPairFixture);
    // An answer from the deploy wallet exists, so only the missing grant can be the reason.
    const answerTx = await answerOnePrompt(fixture, fixture.deployer);
    const nonce = await nonceOf(fixture.deployer);

    await expect(
      handover(fixture, "retire-deployer", {
        ORACLE_ADDRESS: fixture.rofl.address,
        ANSWER_TX_HASH: answerTx,
      }),
    ).to.be.rejectedWith(/does not hold the oracle role[\s\S]*grant[\s\S]*Nothing was sent/);

    expect(await nonceOf(fixture.deployer)).to.equal(nonce);
    expect(await fixture.aiAgent.isOracle(fixture.deployer.address)).to.equal(true);
  });

  it("retire-deployer refuses with no ANSWER_TX_HASH, or one that is not a transaction hash", async function () {
    const fixture = await loadFixture(freshPairFixture);
    await handover(fixture, "grant", { ORACLE_ADDRESS: fixture.rofl.address });
    const nonce = await nonceOf(fixture.deployer);

    await expect(
      handover(fixture, "retire-deployer", { ORACLE_ADDRESS: fixture.rofl.address }),
    ).to.be.rejectedWith(/ANSWER_TX_HASH is required/);
    await expect(
      handover(fixture, "retire-deployer", {
        ORACLE_ADDRESS: fixture.rofl.address,
        ANSWER_TX_HASH: "0xabc",
      }),
    ).to.be.rejectedWith(/ANSWER_TX_HASH is not a transaction hash \(5 characters/);
    // A well-formed hash that this network never mined.
    await expect(
      handover(fixture, "retire-deployer", {
        ORACLE_ADDRESS: fixture.rofl.address,
        ANSWER_TX_HASH: `0x${"ab".repeat(32)}`,
      }),
    ).to.be.rejectedWith(/not found on this network/);

    expect(await nonceOf(fixture.deployer)).to.equal(nonce);
    expect(await fixture.aiAgent.isOracle(fixture.deployer.address)).to.equal(true);
  });

  it("retire-deployer refuses an answer sent by another address", async function () {
    const fixture = await loadFixture(freshPairFixture);
    await handover(fixture, "grant", { ORACLE_ADDRESS: fixture.rofl.address });
    // The deploy wallet still holds the role, so it can answer: that answer proves nothing about
    // the ROFL signer.
    const answerTx = await answerOnePrompt(fixture, fixture.deployer);
    const nonce = await nonceOf(fixture.deployer);

    await expect(
      handover(fixture, "retire-deployer", {
        ORACLE_ADDRESS: fixture.rofl.address,
        ANSWER_TX_HASH: answerTx,
      }),
    ).to.be.rejectedWith(/was sent by 0x[0-9a-fA-F]{40}, not ORACLE_ADDRESS/);

    expect(await nonceOf(fixture.deployer)).to.equal(nonce);
    expect(await fixture.aiAgent.isOracle(fixture.deployer.address)).to.equal(true);
  });

  it("retire-deployer refuses a transaction from the signer that is not a submitAnswer to this agent", async function () {
    const fixture = await loadFixture(freshPairFixture);
    await handover(fixture, "grant", { ORACLE_ADDRESS: fixture.rofl.address });
    // A plain transfer from the ROFL signer: right sender, wrong call.
    const transfer = await (
      await fixture.rofl.sendTransaction({ to: fixture.stranger.address, value: 1n })
    ).wait();

    await expect(
      handover(fixture, "retire-deployer", {
        ORACLE_ADDRESS: fixture.rofl.address,
        ANSWER_TX_HASH: transfer.hash,
      }),
    ).to.be.rejectedWith(/is not a submitAnswer call to the agent/);
    expect(await fixture.aiAgent.isOracle(fixture.deployer.address)).to.equal(true);
  });

  it("refuses once the signer no longer owns the agent, naming the Safe's path", async function () {
    const fixture = await loadFixture(freshPairFixture);
    const { aiAgent, stranger, rofl } = fixture;
    await (await aiAgent.transferOwnership(stranger.address)).wait();
    await (await aiAgent.connect(stranger).acceptOwnership()).wait();

    await expect(handover(fixture, "grant", { ORACLE_ADDRESS: rofl.address })).to.be.rejectedWith(
      /owner is 0x[0-9a-fA-F]{40}, not the signer[\s\S]*Safe/,
    );
    expect(await aiAgent.isOracle(rofl.address)).to.equal(false);
  });

  it("refuses an unknown phase", async function () {
    const fixture = await loadFixture(freshPairFixture);
    await expect(handover(fixture, "remove", {})).to.be.rejectedWith(/grant, retire-deployer/);
  });

  it(`refuses to send on Base mainnet unless DEPLOY_MAINNET_CONFIRMED is exactly "1"`, async function () {
    const fixture = await loadFixture(freshPairFixture);
    await expect(
      runHandover({
        phase: "grant",
        agent: fixture.aiAgent,
        signer: fixture.deployer,
        provider: ethers.provider,
        env: { ORACLE_ADDRESS: fixture.rofl.address, DEPLOY_MAINNET_CONFIRMED: "yes" },
        networkName: "base",
        log: () => {},
      }),
    ).to.be.rejectedWith(/DEPLOY_MAINNET_CONFIRMED=1/);
    expect(await fixture.aiAgent.isOracle(fixture.rofl.address)).to.equal(false);
  });

  describe("a contract that does not do what was sent", function () {
    const HASH = `0x${"cd".repeat(32)}`;

    // An agent stand-in whose owner is the signer, whose oracle role never changes whatever is
    // sent, and which records each call. `holds` says who reads as holding the role.
    function stubAgent({ signer, holds }) {
      const calls = [];
      const agent = {
        calls,
        connect: () => agent,
        owner: async () => signer.address,
        getAddress: async () => "0x4a0C7e5807f9174499a8F56F2C69c61b39a4c64D",
        isOracle: async (address) => holds.some((a) => a.toLowerCase() === address.toLowerCase()),
        addOracle: async (address) => {
          calls.push(["addOracle", address]);
          return { wait: async () => ({ hash: HASH, blockNumber: 7 }) };
        },
        removeOracle: async (address) => {
          calls.push(["removeOracle", address]);
          return { wait: async () => ({ hash: HASH, blockNumber: 8 }) };
        },
      };
      return agent;
    }

    it("grant fails when the oracle still lacks the role after addOracle was mined", async function () {
      const [deployer, , rofl] = await ethers.getSigners();
      const agent = stubAgent({ signer: deployer, holds: [deployer.address] });

      await expect(
        runHandover({
          phase: "grant",
          agent,
          signer: deployer,
          provider: ethers.provider,
          env: { ORACLE_ADDRESS: rofl.address },
          networkName: "hardhat",
          log: () => {},
        }),
      ).to.be.rejectedWith(
        new RegExp(
          `was mined as ${HASH}, but agent\\.isOracle\\(${rofl.address}\\) is false[\\s\\S]*Do not remove`,
        ),
      );
      expect(agent.calls).to.deep.equal([["addOracle", rofl.address]]);
    });

    it("retire-deployer fails when the deploy wallet still holds the role after removeOracle was mined", async function () {
      const fixture = await loadFixture(freshPairFixture);
      const { deployer, rofl } = fixture;
      await handover(fixture, "grant", { ORACLE_ADDRESS: rofl.address });
      const answerTx = await answerOnePrompt(fixture, rofl);
      // The real agent answers who sent the answer; the stand-in keeps both roles whatever is sent.
      const agent = stubAgent({ signer: deployer, holds: [deployer.address, rofl.address] });
      agent.getAddress = () => fixture.aiAgent.getAddress();
      agent.interface = fixture.aiAgent.interface;

      await expect(
        runHandover({
          phase: "retire-deployer",
          agent,
          signer: deployer,
          provider: ethers.provider,
          env: { ORACLE_ADDRESS: rofl.address, ANSWER_TX_HASH: answerTx },
          networkName: "hardhat",
          log: () => {},
        }),
      ).to.be.rejectedWith(
        new RegExp(
          `agent\\.isOracle\\(${deployer.address}\\) is true and agent\\.isOracle\\(${rofl.address}\\) is true[\\s\\S]*Check the agent's oracles now`,
        ),
      );
      expect(agent.calls).to.deep.equal([["removeOracle", deployer.address]]);
    });

    it("retire-deployer refuses an answer that reverted, sending nothing", async function () {
      const fixture = await loadFixture(freshPairFixture);
      const { aiAgent, deployer, rofl } = fixture;
      await handover(fixture, "grant", { ORACLE_ADDRESS: rofl.address });
      const agentAddress = await aiAgent.getAddress();
      const data = aiAgent.interface.encodeFunctionData("submitAnswer", [1n, 2n, CID_BUNDLE]);
      // What the node holds for a submitAnswer from the oracle that was mined and reverted.
      const provider = {
        getTransaction: async () => ({ to: agentAddress, from: rofl.address, data }),
        getTransactionReceipt: async () => ({ status: 0 }),
      };
      const nonce = await nonceOf(deployer);

      await expect(
        runHandover({
          phase: "retire-deployer",
          agent: aiAgent,
          signer: deployer,
          provider,
          env: { ORACLE_ADDRESS: rofl.address, ANSWER_TX_HASH: HASH },
          networkName: "hardhat",
          log: () => {},
        }),
      ).to.be.rejectedWith(
        /is a submitAnswer that reverted, so it answered nothing[\s\S]*Nothing was sent/,
      );
      expect(await nonceOf(deployer)).to.equal(nonce);
      expect(await aiAgent.isOracle(deployer.address)).to.equal(true);
    });
  });

  describe("the pair it acts on", function () {
    const envFile = ".env.base-testnet";
    const AGENT = "0x4a0C7e5807f9174499a8F56F2C69c61b39a4c64D";
    const ESCROW = "0x36ec08471F2b995024967204D7542713cFaf5Fa4";
    const TOKEN = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
    const file = {
      AI_AGENT_CONTRACT_ADDRESS: AGENT,
      AI_AGENT_ESCROW_CONTRACT_ADDRESS: ESCROW,
      TOKEN_CONTRACT_ADDRESS: TOKEN,
    };
    const outside = {
      AI_AGENT_CONTRACT_ADDRESS: "0x1111111111111111111111111111111111111111",
      AI_AGENT_ESCROW_CONTRACT_ADDRESS: "0x2222222222222222222222222222222222222222",
      TOKEN_CONTRACT_ADDRESS: "0x3333333333333333333333333333333333333333",
    };

    it("is read from ENV_FILE on a live network", function () {
      expect(
        resolveHandoverTarget({ networkName: "base", envFile, fileEnv: file, processEnv: file }),
      ).to.deep.equal({ agent: AGENT, escrow: ESCROW, token: TOKEN });
    });

    for (const name of Object.keys(outside)) {
      it(`refuses ${name} set only in the root .env or the shell on a live network, never printing it`, function () {
        for (const networkName of ["baseSepolia", "base"]) {
          const fileEnv = { ...file };
          delete fileEnv[name];
          expect(() =>
            resolveHandoverTarget({
              networkName,
              envFile,
              fileEnv,
              processEnv: { ...fileEnv, [name]: outside[name] },
            }),
          )
            .to.throw(Error)
            .with.property("message")
            .that.includes(`${name} is not set in ${envFile}`)
            .and.includes("Nothing was sent")
            .and.not.includes(outside[name]);
        }
      });
    }

    it("refuses a live network with no ENV_FILE", function () {
      expect(() =>
        resolveHandoverTarget({
          networkName: "base",
          envFile: undefined,
          fileEnv: null,
          processEnv: file,
        }),
      ).to.throw(/ENV_FILE is not set/);
    });

    it("on a local network takes the merged environment and needs only the agent", function () {
      expect(
        resolveHandoverTarget({
          networkName: "localnet",
          envFile: ".env.base-localnet",
          fileEnv: {},
          processEnv: { AI_AGENT_CONTRACT_ADDRESS: AGENT },
        }),
      ).to.deep.equal({ agent: AGENT, escrow: null, token: null });
    });

    it("prints the network, the agent, the escrow and the token before anything is read", function () {
      const text = targetLines({
        networkName: "base",
        envFile,
        phase: "grant",
        signer: AGENT,
        target: { agent: AGENT, escrow: ESCROW, token: TOKEN },
      }).join("\n");
      expect(text).to.include("on base");
      expect(text).to.include("phase=grant");
      expect(text).to.include(`Agent: ${AGENT}`);
      expect(text).to.include(`Escrow: ${ESCROW}`);
      expect(text).to.include(`Fee token: ${TOKEN}`);
      expect(text).to.include(envFile);
    });
  });
});

// The documented command runs the script with node, which loads hardhat.config.js, which loads
// ENV_FILE with override: a line in the file replaces a value typed on the command line, even an
// empty line such as the template's. These run that path in a child process, against a file of
// their own, so what the operator typed and what the file holds can disagree as they would.
describe("scripts/authorize-oracle — the settings as the documented command gives them", function () {
  // Each child loads Hardhat itself.
  this.timeout(60_000);

  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const { spawnSync } = require("child_process");

  const ROOT = path.join(__dirname, "..");
  const AGENT = "0x4a0C7e5807f9174499a8F56F2C69c61b39a4c64D";
  const TYPED = "0x00000000000000000000000000000000000000aa";
  const STALE = "0x00000000000000000000000000000000000000bb";
  const TYPED_HASH = `0x${"aa".repeat(32)}`;
  const STALE_HASH = `0x${"bb".repeat(32)}`;
  const SETTINGS = ["ENV_FILE", "HARDHAT_NETWORK", "ORACLE_ADDRESS", "ANSWER_TX_HASH"];

  let dir;
  before(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "authorize-oracle-"));
  });
  after(function () {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Runs one phase with `fileLines` as ENV_FILE and `shell` as what was typed before it. */
  function run(phase, { fileLines, shell }) {
    const envFile = path.join(dir, `handover-${Math.random().toString(16).slice(2)}.settings`);
    fs.writeFileSync(envFile, [`AI_AGENT_CONTRACT_ADDRESS=${AGENT}`, ...fileLines, ""].join("\n"));
    const env = { ...process.env };
    for (const name of SETTINGS) delete env[name];
    const result = spawnSync(process.execPath, ["scripts/authorize-oracle.js", phase], {
      cwd: ROOT,
      env: { ...env, ...shell, ENV_FILE: envFile, HARDHAT_NETWORK: "hardhat" },
      encoding: "utf8",
    });
    return { envFile, status: result.status, out: `${result.stdout}\n${result.stderr}` };
  }

  it("refuses an ORACLE_ADDRESS typed on the command line when ENV_FILE has the template's empty line", function () {
    const { envFile, status, out } = run("grant", {
      fileLines: ["ORACLE_ADDRESS="],
      shell: { ORACLE_ADDRESS: TYPED },
    });
    expect(status).to.equal(1);
    expect(out).to.include(`ORACLE_ADDRESS is not set in ${envFile}`);
    expect(out).to.include(`set it in ${envFile}`);
    expect(out).to.include("Nothing was sent");
    expect(out).to.not.include(TYPED);
  });

  it("refuses an ORACLE_ADDRESS typed on the command line that differs from ENV_FILE's, never acting on either", function () {
    const { envFile, status, out } = run("grant", {
      fileLines: [`ORACLE_ADDRESS=${STALE}`],
      shell: { ORACLE_ADDRESS: TYPED },
    });
    expect(status).to.equal(1);
    expect(out).to.include(`ORACLE_ADDRESS in the root .env or the shell differs from ${envFile}`);
    expect(out).to.include("Nothing was sent");
    expect(out).to.not.include(TYPED);
    expect(out).to.not.include(STALE);
  });

  it("refuses an empty ORACLE_ADDRESS in ENV_FILE before anything is read, naming the file to set it in", function () {
    const { envFile, status, out } = run("grant", { fileLines: ["ORACLE_ADDRESS="], shell: {} });
    expect(status).to.equal(1);
    expect(out).to.include("ORACLE_ADDRESS is required");
    expect(out).to.include(`set it in ${envFile}`);
    expect(out).to.include("Nothing was sent");
    // The agent address holds no contract here, so a read would fail with a decode error.
    expect(out).to.not.match(/could not decode|BAD_DATA/);
  });

  it("refuses an ANSWER_TX_HASH typed on the command line that differs from ENV_FILE's", function () {
    const { envFile, status, out } = run("retire-deployer", {
      fileLines: [`ORACLE_ADDRESS=${STALE}`, `ANSWER_TX_HASH=${STALE_HASH}`],
      shell: { ANSWER_TX_HASH: TYPED_HASH },
    });
    expect(status).to.equal(1);
    expect(out).to.include(`ANSWER_TX_HASH in the root .env or the shell differs from ${envFile}`);
    expect(out).to.not.include(TYPED_HASH);
    expect(out).to.not.include(STALE_HASH);
  });

  it("refuses an ANSWER_TX_HASH typed on the command line when ENV_FILE has an empty line for it", function () {
    const { envFile, status, out } = run("retire-deployer", {
      fileLines: [`ORACLE_ADDRESS=${STALE}`, "ANSWER_TX_HASH="],
      shell: { ANSWER_TX_HASH: TYPED_HASH },
    });
    expect(status).to.equal(1);
    expect(out).to.include(`ANSWER_TX_HASH is not set in ${envFile}`);
    expect(out).to.not.include(TYPED_HASH);
  });

  it("takes ORACLE_ADDRESS from ENV_FILE when the command line gives the same address or none", function () {
    for (const shell of [{}, { ORACLE_ADDRESS: STALE }]) {
      const { out } = run("grant", { fileLines: [`ORACLE_ADDRESS=${STALE}`], shell });
      // Past the settings: the next step reads the agent, which holds no contract here.
      expect(out).to.not.match(/ORACLE_ADDRESS (is required|is not set in|in the root \.env)/);
      expect(out).to.match(/could not decode|BAD_DATA/);
    }
  });
});
