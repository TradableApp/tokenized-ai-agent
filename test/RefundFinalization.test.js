const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

/**
 * What the agent contract knows about a prompt whose escrow was refunded on timeout.
 *
 * `cancelPrompt` tells the agent (`recordCancellation` → `isJobFinalized = true`), so the oracle's
 * idempotency check skips a cancelled prompt before it spends a model call. `processRefund` moves
 * the money and says nothing to the agent. These tests pin that asymmetry as it stands today:
 * the user's funds are safe (a late answer cannot be paid twice), but the agent still reports the
 * job as open, so an oracle that comes back after an outage would generate an answer for a prompt
 * that has already been refunded and only learn it at `submitAnswer`.
 *
 * The first describe block is the behaviour that must hold whatever the fix looks like. The second
 * pins the gap; when the contract is fixed, those expectations flip and this file says so.
 */
describe("Timeout refund — what the agent contract knows afterwards", function () {
  const INITIAL_ALLOWANCE = ethers.parseEther("100");
  const PROMPT_FEE = ethers.parseEther("10");
  const CANCELLATION_FEE = ethers.parseEther("1");
  const METADATA_FEE = ethers.parseEther("0.5");
  const BRANCH_FEE = ethers.parseEther("2");
  const MOCK_CID = "QmXg9j4f8zYf8t7f8zYf8t7f8zYf8t7f8zYf8t7f8zYf8t7";
  const CID_BUNDLE = {
    conversationCID: MOCK_CID,
    metadataCID: MOCK_CID,
    promptMessageCID: MOCK_CID,
    answerMessageCID: MOCK_CID,
    searchDeltaCID: MOCK_CID,
  };

  async function refundedPromptFixture() {
    const [deployer, user, oracle, treasury, keeper] = await ethers.getSigners();

    const token = await (await ethers.getContractFactory("MockAbleToken")).deploy();
    await token.waitForDeployment();
    await token.mint(user.address, INITIAL_ALLOWANCE);

    const aiAgent = await upgrades.deployProxy(
      await ethers.getContractFactory("EVMAIAgent"),
      ["example.com", oracle.address, deployer.address],
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
        CANCELLATION_FEE,
        METADATA_FEE,
        BRANCH_FEE,
      ],
      { initializer: "initialize", kind: "uups" },
    );
    await escrow.waitForDeployment();

    await aiAgent.connect(deployer).setAgentEscrow(await escrow.getAddress());
    await token.connect(user).approve(await escrow.getAddress(), INITIAL_ALLOWANCE);
    await escrow.connect(user).setSpendingLimit(INITIAL_ALLOWANCE, (await time.latest()) + 7200);

    const receipt = await (await escrow.connect(user).initiatePrompt(0, "0x", "0x")).wait();
    const escrowed = receipt.logs
      .map((l) => {
        try {
          return escrow.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((p) => p?.name === "PaymentEscrowed");
    const submitted = receipt.logs
      .map((l) => {
        try {
          return aiAgent.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((p) => p?.name === "PromptSubmitted");
    const answerMessageId = escrowed.args[0];
    const promptMessageId = submitted.args[2];

    await time.increase(Number(await escrow.REFUND_TIMEOUT()) + 1);
    await escrow.connect(keeper).processRefund(answerMessageId);

    return { aiAgent, escrow, token, user, oracle, answerMessageId, promptMessageId };
  }

  describe("holds today and must keep holding", function () {
    it("returns the full fee to the user and clears the pending count", async function () {
      const { escrow, token, user } = await loadFixture(refundedPromptFixture);
      expect(await token.balanceOf(user.address)).to.equal(INITIAL_ALLOWANCE);
      expect(await escrow.pendingEscrowCount(user.address)).to.equal(0n);
      expect((await escrow.spendingLimits(user.address)).spentAmount).to.equal(0n);
    });

    it("a late answer for the refunded prompt cannot be paid: submitAnswer reverts and records nothing", async function () {
      const { aiAgent, escrow, token, oracle, user, answerMessageId, promptMessageId } =
        await loadFixture(refundedPromptFixture);
      await expect(
        aiAgent.connect(oracle).submitAnswer(promptMessageId, answerMessageId, CID_BUNDLE),
      ).to.be.reverted;
      expect(await token.balanceOf(user.address)).to.equal(INITIAL_ALLOWANCE);
      expect(await token.balanceOf(await escrow.getAddress())).to.equal(0n);
    });
  });

  describe("KNOWN GAP (pinned 2026-11-11): the refund is not recorded on the agent", function () {
    it("isJobFinalized stays false after a timeout refund, unlike after cancelPrompt", async function () {
      const { aiAgent, answerMessageId } = await loadFixture(refundedPromptFixture);
      // The oracle's pre-flight idempotency check reads this flag. `true` is the fixed behaviour.
      expect(await aiAgent.isJobFinalized(answerMessageId)).to.equal(false);
    });

    it("the late answer is refused by the escrow (EscrowNotPending), not by the agent's own JobAlreadyFinalized", async function () {
      const { aiAgent, escrow, oracle, answerMessageId, promptMessageId } =
        await loadFixture(refundedPromptFixture);
      await expect(
        aiAgent.connect(oracle).submitAnswer(promptMessageId, answerMessageId, CID_BUNDLE),
      ).to.be.revertedWithCustomError(escrow, "EscrowNotPending");
    });
  });
});
