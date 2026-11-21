const { expect } = require("chai");
const hre = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const { resolveDeployPlan, deployFreshPair } = require("../scripts/deploy");
const { runHandover, PHASES } = require("../scripts/authorize-oracle");

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
});
