const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("E2E: Advanced Scenarios", function () {
  const DOMAIN = "tradable.app";
  const INITIAL_MINT = ethers.parseEther("1000");
  const PROMPT_FEE = ethers.parseEther("10");
  const CANCELLATION_FEE = ethers.parseEther("1");
  const METADATA_FEE = ethers.parseEther("0.5");
  const BRANCH_FEE = ethers.parseEther("2");

  async function deployFullStackFixture() {
    const [deployer, user, oracle, treasury, keeper] = await ethers.getSigners();

    const MockTokenFactory = await ethers.getContractFactory("MockAbleToken");
    const token = await MockTokenFactory.deploy();
    await token.waitForDeployment();
    await token.mint(user.address, INITIAL_MINT);

    const EVMAIAgent = await ethers.getContractFactory("EVMAIAgent");
    const aiAgent = await upgrades.deployProxy(
      EVMAIAgent,
      [DOMAIN, oracle.address, deployer.address],
      { initializer: "initialize", kind: "uups" },
    );
    await aiAgent.waitForDeployment();

    const EVMAIAgentEscrow = await ethers.getContractFactory("EVMAIAgentEscrow");
    const escrow = await upgrades.deployProxy(
      EVMAIAgentEscrow,
      [
        await token.getAddress(),
        await aiAgent.getAddress(),
        treasury.address,
        deployer.address,
        PROMPT_FEE,
        CANCELLATION_FEE,
        METADATA_FEE,
        BRANCH_FEE,
      ],
      { initializer: "initialize", kind: "uups" },
    );
    await escrow.waitForDeployment();

    await aiAgent.connect(deployer).setAgentEscrow(await escrow.getAddress());
    await token.connect(user).approve(await escrow.getAddress(), INITIAL_MINT);

    return { aiAgent, escrow, token, deployer, user, oracle, treasury, keeper };
  }

  function extractEventArgs(receipt, contractIface, eventName) {
    const topicHash = contractIface.getEvent(eventName).topicHash;
    const log = receipt.logs.find((l) => l.topics[0] === topicHash);
    if (!log) throw new Error(`${eventName} event not found in receipt`);
    return contractIface.parseLog(log).args;
  }

  describe("Multi-Conversation Lifecycle", function () {
    it("creates two independent conversations with distinct IDs, CIDs, and independent finalization", async function () {
      const { aiAgent, escrow, user, oracle } = await loadFixture(deployFullStackFixture);

      const expiresAt = (await time.latest()) + 7200;
      await escrow.connect(user).setSpendingLimit(ethers.parseEther("100"), expiresAt);

      // Conversation 1: new conversation (conversationId=0)
      const tx1 = await escrow.connect(user).initiatePrompt(0, "0x1234", "0x5678");
      const r1 = await tx1.wait();
      const agent1 = extractEventArgs(r1, aiAgent.interface, "PromptSubmitted");
      const conv1Id = agent1[1];
      const prompt1Id = agent1[2];
      const answer1Id = extractEventArgs(r1, escrow.interface, "PaymentEscrowed")[0];

      // Conversation 2: new conversation (conversationId=0 again)
      const tx2 = await escrow.connect(user).initiatePrompt(0, "0xabcd", "0xef01");
      const r2 = await tx2.wait();
      const agent2 = extractEventArgs(r2, aiAgent.interface, "PromptSubmitted");
      const conv2Id = agent2[1];
      const prompt2Id = agent2[2];
      const answer2Id = extractEventArgs(r2, escrow.interface, "PaymentEscrowed")[0];

      expect(conv1Id).to.not.equal(conv2Id);
      expect(answer1Id).to.not.equal(answer2Id);

      // Oracle answers with different CID values per conversation
      const cid1 = "QmConv1CID0000000000000000000000000000000000000";
      const cid2 = "QmConv2CID0000000000000000000000000000000000000";

      const bundle1 = {
        conversationCID: cid1,
        metadataCID: cid1,
        promptMessageCID: cid1,
        answerMessageCID: cid1,
        searchDeltaCID: cid1,
      };
      const bundle2 = {
        conversationCID: cid2,
        metadataCID: cid2,
        promptMessageCID: cid2,
        answerMessageCID: cid2,
        searchDeltaCID: cid2,
      };

      // Answer conversation 2 first — independent of conversation 1
      await aiAgent.connect(oracle).submitAnswer(prompt2Id, answer2Id, bundle2);
      expect(await aiAgent.isJobFinalized(answer2Id)).to.be.true;
      expect(await aiAgent.isJobFinalized(answer1Id)).to.be.false;

      await aiAgent.connect(oracle).submitAnswer(prompt1Id, answer1Id, bundle1);
      expect(await aiAgent.isJobFinalized(answer1Id)).to.be.true;

      expect(await escrow.pendingEscrowCount(user.address)).to.equal(0);
    });
  });

  describe("Spending Limit Full Lifecycle", function () {
    it("exhausts spending limit over 5 prompts, rejects 6th, then cancels limit", async function () {
      const { aiAgent, escrow, user, oracle } = await loadFixture(deployFullStackFixture);

      const limitForFive = PROMPT_FEE * 5n;
      const expiresAt = (await time.latest()) + 7200;
      await escrow.connect(user).setSpendingLimit(limitForFive, expiresAt);

      const promptIds = [];
      const answerIds = [];

      for (let i = 0; i < 5; i++) {
        const tx = await escrow.connect(user).initiatePrompt(0, "0x1234", "0x5678");
        const receipt = await tx.wait();
        promptIds.push(extractEventArgs(receipt, aiAgent.interface, "PromptSubmitted")[2]);
        answerIds.push(extractEventArgs(receipt, escrow.interface, "PaymentEscrowed")[0]);

        const limit = await escrow.spendingLimits(user.address);
        expect(limit.spentAmount).to.equal(PROMPT_FEE * BigInt(i + 1));
      }

      // 6th prompt exceeds limit
      await expect(
        escrow.connect(user).initiatePrompt(0, "0x1234", "0x5678"),
      ).to.be.revertedWithCustomError(escrow, "InsufficientSpendingLimitAllowance");

      // Cannot cancel limit while prompts are pending
      await expect(escrow.connect(user).cancelSpendingLimit()).to.be.revertedWithCustomError(
        escrow,
        "HasPendingPrompts",
      );

      // Answer all to clear pending count
      const cidBundle = {
        conversationCID: "QmMock",
        metadataCID: "QmMock",
        promptMessageCID: "QmMock",
        answerMessageCID: "QmMock",
        searchDeltaCID: "QmMock",
      };
      for (let i = 0; i < 5; i++) {
        await aiAgent.connect(oracle).submitAnswer(promptIds[i], answerIds[i], cidBundle);
      }

      expect(await escrow.pendingEscrowCount(user.address)).to.equal(0);

      // Now cancel spending limit
      await expect(escrow.connect(user).cancelSpendingLimit())
        .to.emit(escrow, "SpendingLimitCancelled")
        .withArgs(user.address);

      const limit = await escrow.spendingLimits(user.address);
      expect(limit.allowance).to.equal(0);
      expect(limit.spentAmount).to.equal(0);
      expect(limit.expiresAt).to.equal(0);

      // Prompt after cancellation fails
      await expect(
        escrow.connect(user).initiatePrompt(0, "0x1234", "0x5678"),
      ).to.be.revertedWithCustomError(escrow, "NoActiveSpendingLimit");
    });
  });

  describe("Concurrent Prompts", function () {
    it("handles two prompts in rapid succession with correct escrow accounting", async function () {
      const { aiAgent, escrow, token, user, oracle, treasury } =
        await loadFixture(deployFullStackFixture);

      const expiresAt = (await time.latest()) + 7200;
      await escrow.connect(user).setSpendingLimit(ethers.parseEther("100"), expiresAt);

      const userBalBefore = await token.balanceOf(user.address);
      const treasuryBalBefore = await token.balanceOf(treasury.address);

      // Two prompts submitted back-to-back
      const tx1 = await escrow.connect(user).initiatePrompt(0, "0x1234", "0x5678");
      const tx2 = await escrow.connect(user).initiatePrompt(0, "0xabcd", "0xef01");

      const [r1, r2] = await Promise.all([tx1.wait(), tx2.wait()]);

      expect(await escrow.pendingEscrowCount(user.address)).to.equal(2);
      expect(await token.balanceOf(user.address)).to.equal(userBalBefore - PROMPT_FEE * 2n);

      const prompt1Id = extractEventArgs(r1, aiAgent.interface, "PromptSubmitted")[2];
      const answer1Id = extractEventArgs(r1, escrow.interface, "PaymentEscrowed")[0];
      const prompt2Id = extractEventArgs(r2, aiAgent.interface, "PromptSubmitted")[2];
      const answer2Id = extractEventArgs(r2, escrow.interface, "PaymentEscrowed")[0];

      expect(answer1Id).to.not.equal(answer2Id);

      const cidBundle = {
        conversationCID: "QmMock",
        metadataCID: "QmMock",
        promptMessageCID: "QmMock",
        answerMessageCID: "QmMock",
        searchDeltaCID: "QmMock",
      };

      await aiAgent.connect(oracle).submitAnswer(prompt1Id, answer1Id, cidBundle);
      await aiAgent.connect(oracle).submitAnswer(prompt2Id, answer2Id, cidBundle);

      // No double-charging: exactly 2x promptFee to treasury
      expect(await token.balanceOf(treasury.address)).to.equal(treasuryBalBefore + PROMPT_FEE * 2n);
      expect(await escrow.pendingEscrowCount(user.address)).to.equal(0);
    });
  });

  describe("Gas Estimation", function () {
    it("setSpendingLimit uses less than 500k gas", async function () {
      const { escrow, user } = await loadFixture(deployFullStackFixture);

      const expiresAt = (await time.latest()) + 7200;
      const tx = await escrow.connect(user).setSpendingLimit(ethers.parseEther("100"), expiresAt);
      const receipt = await tx.wait();

      expect(receipt.gasUsed).to.be.lessThan(500_000n);
    });

    it("initiatePrompt uses less than 500k gas", async function () {
      const { escrow, user } = await loadFixture(deployFullStackFixture);

      const expiresAt = (await time.latest()) + 7200;
      await escrow.connect(user).setSpendingLimit(ethers.parseEther("100"), expiresAt);

      const tx = await escrow.connect(user).initiatePrompt(0, "0x1234", "0x5678");
      const receipt = await tx.wait();

      expect(receipt.gasUsed).to.be.lessThan(500_000n);
    });

    it("submitAnswer uses less than 500k gas", async function () {
      const { aiAgent, escrow, user, oracle } = await loadFixture(deployFullStackFixture);

      const expiresAt = (await time.latest()) + 7200;
      await escrow.connect(user).setSpendingLimit(ethers.parseEther("100"), expiresAt);

      const initTx = await escrow.connect(user).initiatePrompt(0, "0x1234", "0x5678");
      const initReceipt = await initTx.wait();
      const promptId = extractEventArgs(initReceipt, aiAgent.interface, "PromptSubmitted")[2];
      const answerId = extractEventArgs(initReceipt, escrow.interface, "PaymentEscrowed")[0];

      const cidBundle = {
        conversationCID: "QmMock",
        metadataCID: "QmMock",
        promptMessageCID: "QmMock",
        answerMessageCID: "QmMock",
        searchDeltaCID: "QmMock",
      };
      const tx = await aiAgent.connect(oracle).submitAnswer(promptId, answerId, cidBundle);
      const receipt = await tx.wait();

      expect(receipt.gasUsed).to.be.lessThan(500_000n);
    });

    it("cancelPrompt uses less than 500k gas", async function () {
      const { escrow, user } = await loadFixture(deployFullStackFixture);

      const expiresAt = (await time.latest()) + 7200;
      await escrow.connect(user).setSpendingLimit(ethers.parseEther("100"), expiresAt);

      const initTx = await escrow.connect(user).initiatePrompt(0, "0x1234", "0x5678");
      const initReceipt = await initTx.wait();
      const answerId = extractEventArgs(initReceipt, escrow.interface, "PaymentEscrowed")[0];

      await time.increase(5);

      const tx = await escrow.connect(user).cancelPrompt(answerId);
      const receipt = await tx.wait();

      expect(receipt.gasUsed).to.be.lessThan(500_000n);
    });

    it("processRefund uses less than 500k gas", async function () {
      const { escrow, user, keeper } = await loadFixture(deployFullStackFixture);

      const expiresAt = (await time.latest()) + 7200;
      await escrow.connect(user).setSpendingLimit(ethers.parseEther("100"), expiresAt);

      const initTx = await escrow.connect(user).initiatePrompt(0, "0x1234", "0x5678");
      const initReceipt = await initTx.wait();
      const answerId = extractEventArgs(initReceipt, escrow.interface, "PaymentEscrowed")[0];

      await time.increase(3601);

      const tx = await escrow.connect(keeper).processRefund(answerId);
      const receipt = await tx.wait();

      expect(receipt.gasUsed).to.be.lessThan(500_000n);
    });
  });
});
