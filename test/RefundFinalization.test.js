const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

/**
 * What the agent contract knows about a prompt whose escrow was refunded on timeout.
 *
 * `cancelPrompt` tells the agent (`recordCancellation` → `isJobFinalized = true`), so the oracle's
 * idempotency check skips a cancelled prompt before it spends a model call. `processRefund` now
 * does the same through `recordRefund`, with its own `PromptRefunded` event so an indexer never
 * mistakes a timeout refund for a user cancellation (which carries a fee). Before that fix the
 * agent still reported a refunded job as open, and an oracle returning from an outage generated an
 * answer for it and only learned at `submitAnswer`.
 *
 * The first describe block is the money behaviour, which held before the fix and must keep
 * holding. The second is the fix itself.
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

  async function pendingPromptFixture() {
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
    // Topic lookup, as in answerMessageId.lifecycle.test.js; a missing log names itself.
    const findEvent = (contract, name) => {
      const topic = contract.interface.getEvent(name).topicHash;
      const log = receipt.logs.find((l) => l.topics[0] === topic);
      if (!log) throw new Error(`${name} not found in the initiatePrompt receipt — recompile?`);
      return contract.interface.parseLog(log);
    };
    const answerMessageId = findEvent(escrow, "PaymentEscrowed").args[0];
    const promptMessageId = findEvent(aiAgent, "PromptSubmitted").args[2];

    const refundTimeout = Number(await escrow.REFUND_TIMEOUT());
    return {
      aiAgent,
      escrow,
      token,
      deployer,
      user,
      oracle,
      keeper,
      answerMessageId,
      promptMessageId,
      refundTimeout,
    };
  }

  async function refundedPromptFixture() {
    const pending = await pendingPromptFixture();
    await time.increase(pending.refundTimeout + 1);
    const refundTx = await pending.escrow
      .connect(pending.keeper)
      .processRefund(pending.answerMessageId);
    return { ...pending, refundTx };
  }

  // The escrow against a mock agent whose recordRefund can be made to revert.
  async function escrowWithFailingAgentFixture() {
    const [deployer, user, oracle, treasury, keeper] = await ethers.getSigners();
    const mockAgent = await (
      await ethers.getContractFactory("MockEVMAIAgent")
    ).deploy(oracle.address);
    await mockAgent.waitForDeployment();
    const token = await (await ethers.getContractFactory("MockAbleToken")).deploy();
    await token.waitForDeployment();
    await token.mint(user.address, INITIAL_ALLOWANCE);
    const escrow = await upgrades.deployProxy(
      await ethers.getContractFactory("EVMAIAgentEscrow"),
      [
        await token.getAddress(),
        await mockAgent.getAddress(),
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
    await token.connect(user).approve(await escrow.getAddress(), INITIAL_ALLOWANCE);
    await escrow.connect(user).setSpendingLimit(INITIAL_ALLOWANCE, (await time.latest()) + 7200);

    const receipt = await (await escrow.connect(user).initiatePrompt(0, "0x", "0x")).wait();
    const topic = escrow.interface.getEvent("PaymentEscrowed").topicHash;
    const escrowId = escrow.interface.parseLog(receipt.logs.find((l) => l.topics[0] === topic))
      .args[0];

    await mockAgent.setRecordRefundReverts(true);
    await time.increase(Number(await escrow.REFUND_TIMEOUT()) + 1);
    return { escrow, mockAgent, token, user, keeper, escrowId };
  }

  describe("the money: held before the fix and must keep holding", function () {
    it("returns the full fee to the user and clears the pending count", async function () {
      const { escrow, token, user } = await loadFixture(refundedPromptFixture);
      expect(await token.balanceOf(user.address)).to.equal(INITIAL_ALLOWANCE);
      expect(await token.balanceOf(await escrow.getAddress())).to.equal(0n);
      expect(await escrow.pendingEscrowCount(user.address)).to.equal(0n);
      expect((await escrow.spendingLimits(user.address)).spentAmount).to.equal(0n);
    });

    it("a late answer for the refunded prompt cannot be paid: submitAnswer reverts", async function () {
      // Which contract refuses it is pinned separately below, because that is what the fix changes.
      const { aiAgent, oracle, answerMessageId, promptMessageId } =
        await loadFixture(refundedPromptFixture);
      await expect(
        aiAgent.connect(oracle).submitAnswer(promptMessageId, answerMessageId, CID_BUNDLE),
      ).to.be.reverted;
    });
  });

  describe("the refund is recorded on the agent", function () {
    it("isJobFinalized is true after a timeout refund, as it is after cancelPrompt", async function () {
      const { aiAgent, answerMessageId } = await loadFixture(refundedPromptFixture);
      // The oracle's pre-flight idempotency check reads this flag.
      expect(await aiAgent.isJobFinalized(answerMessageId)).to.equal(true);
    });

    it("the agent emits PromptRefunded(user, answerMessageId), and no PromptCancelled", async function () {
      const { aiAgent, user, answerMessageId, refundTx } = await loadFixture(refundedPromptFixture);
      await expect(refundTx)
        .to.emit(aiAgent, "PromptRefunded")
        .withArgs(user.address, answerMessageId);
      // A cancellation carries a fee in the subgraph's activity feed; a refund must not look like one.
      await expect(refundTx).to.not.emit(aiAgent, "PromptCancelled");
    });

    it("a late answer is refused by the agent's own JobAlreadyFinalized", async function () {
      const { aiAgent, oracle, answerMessageId, promptMessageId } =
        await loadFixture(refundedPromptFixture);
      await expect(
        aiAgent.connect(oracle).submitAnswer(promptMessageId, answerMessageId, CID_BUNDLE),
      ).to.be.revertedWithCustomError(aiAgent, "JobAlreadyFinalized");
    });

    it("only the escrow may record a refund", async function () {
      const { aiAgent, user, keeper, answerMessageId } = await loadFixture(refundedPromptFixture);
      await expect(
        aiAgent.connect(keeper).recordRefund(user.address, answerMessageId),
      ).to.be.revertedWithCustomError(aiAgent, "NotAIAgentEscrow");
    });
  });

  describe("a refund happens once, and only for a pending escrow", function () {
    it("is refused before the refund timeout has passed", async function () {
      const { escrow, keeper, answerMessageId } = await loadFixture(pendingPromptFixture);
      await expect(
        escrow.connect(keeper).processRefund(answerMessageId),
      ).to.be.revertedWithCustomError(escrow, "PromptNotRefundableYet");
    });

    it("a second refund of the same escrow is refused", async function () {
      const { escrow, keeper, answerMessageId } = await loadFixture(refundedPromptFixture);
      await expect(
        escrow.connect(keeper).processRefund(answerMessageId),
      ).to.be.revertedWithCustomError(escrow, "EscrowNotPending");
    });

    it("a cancelled prompt cannot also be refunded, and records no PromptRefunded", async function () {
      const { aiAgent, escrow, user, keeper, answerMessageId, refundTimeout } =
        await loadFixture(pendingPromptFixture);
      await time.increase(Number(await escrow.CANCELLATION_TIMEOUT()) + 1);
      await escrow.connect(user).cancelPrompt(answerMessageId);
      await time.increase(refundTimeout + 1);

      const refund = escrow.connect(keeper).processRefund(answerMessageId);

      await expect(refund).to.be.revertedWithCustomError(escrow, "EscrowNotPending");
      expect(await aiAgent.queryFilter(aiAgent.filters.PromptRefunded())).to.have.lengthOf(0);
    });

    it("an answered prompt cannot be refunded", async function () {
      const { aiAgent, escrow, oracle, keeper, answerMessageId, promptMessageId, refundTimeout } =
        await loadFixture(pendingPromptFixture);
      await aiAgent.connect(oracle).submitAnswer(promptMessageId, answerMessageId, CID_BUNDLE);
      await time.increase(refundTimeout + 1);

      await expect(
        escrow.connect(keeper).processRefund(answerMessageId),
      ).to.be.revertedWithCustomError(escrow, "EscrowNotPending");
    });
  });

  describe("a failing agent cannot stand between the user and the refund", function () {
    // The refund is the user's last exit. An agent that reverts (an escrow upgraded ahead of its
    // agent has no recordRefund to call, a mis-linked agent refuses the caller) must cost the
    // bookkeeping, never the money, and the failure must be visible in the escrow's own logs.
    it("the refund still pays the user in full", async function () {
      const { escrow, token, user, keeper, escrowId } = await loadFixture(
        escrowWithFailingAgentFixture,
      );

      await escrow.connect(keeper).processRefund(escrowId);

      expect(await token.balanceOf(user.address)).to.equal(INITIAL_ALLOWANCE);
      expect(await escrow.pendingEscrowCount(user.address)).to.equal(0n);
    });

    it("the escrow emits RefundRecordFailed(escrowId) alongside PaymentRefunded", async function () {
      const { escrow, keeper, escrowId } = await loadFixture(escrowWithFailingAgentFixture);

      const refund = escrow.connect(keeper).processRefund(escrowId);

      await expect(refund).to.emit(escrow, "RefundRecordFailed").withArgs(escrowId);
      await expect(refund).to.emit(escrow, "PaymentRefunded").withArgs(escrowId);
    });
  });

  describe("a refund record that failed can be completed later", function () {
    // Without this a failed record is permanent: the escrow is REFUNDED, so neither processRefund
    // nor cancelPrompt will touch it again, and the agent keeps the job open (and, for a
    // regeneration, keeps the prompt locked) for good.
    async function refundedWithFailedRecordFixture() {
      const fixture = await escrowWithFailingAgentFixture();
      await fixture.escrow.connect(fixture.keeper).processRefund(fixture.escrowId);
      return fixture;
    }

    it("anyone can complete the record once the agent takes the call", async function () {
      const { escrow, mockAgent, user, keeper, escrowId } = await loadFixture(
        refundedWithFailedRecordFixture,
      );
      await mockAgent.setRecordRefundReverts(false);

      const retry = escrow.connect(keeper).retryRefundRecord(escrowId);

      await expect(retry).to.emit(mockAgent, "RefundRecorded").withArgs(user.address, escrowId);
      await expect(retry).to.emit(escrow, "RefundRecordRetried").withArgs(escrowId);
    });

    it("moves no funds", async function () {
      const { escrow, mockAgent, token, user, keeper, escrowId } = await loadFixture(
        refundedWithFailedRecordFixture,
      );
      await mockAgent.setRecordRefundReverts(false);
      const userBefore = await token.balanceOf(user.address);
      const escrowBefore = await token.balanceOf(await escrow.getAddress());

      await escrow.connect(keeper).retryRefundRecord(escrowId);

      expect(await token.balanceOf(user.address)).to.equal(userBefore);
      expect(await token.balanceOf(await escrow.getAddress())).to.equal(escrowBefore);
    });

    it("reverts while the agent still cannot take the call, and can be tried again afterwards", async function () {
      const { escrow, mockAgent, user, keeper, escrowId } = await loadFixture(
        refundedWithFailedRecordFixture,
      );

      await expect(escrow.connect(keeper).retryRefundRecord(escrowId)).to.be.revertedWith(
        "MockAIAgent: recordRefund reverts",
      );

      await mockAgent.setRecordRefundReverts(false);
      await expect(escrow.connect(keeper).retryRefundRecord(escrowId))
        .to.emit(mockAgent, "RefundRecorded")
        .withArgs(user.address, escrowId);
    });

    it("refuses an escrow that is still pending", async function () {
      const { escrow, keeper, escrowId } = await loadFixture(escrowWithFailingAgentFixture);
      await expect(
        escrow.connect(keeper).retryRefundRecord(escrowId),
      ).to.be.revertedWithCustomError(escrow, "EscrowNotRefunded");
    });

    it("refuses an escrow that was answered, and one that does not exist", async function () {
      const { aiAgent, escrow, oracle, keeper, answerMessageId, promptMessageId } =
        await loadFixture(pendingPromptFixture);
      await aiAgent.connect(oracle).submitAnswer(promptMessageId, answerMessageId, CID_BUNDLE);

      await expect(
        escrow.connect(keeper).retryRefundRecord(answerMessageId),
      ).to.be.revertedWithCustomError(escrow, "EscrowNotRefunded");
      await expect(
        escrow.connect(keeper).retryRefundRecord(answerMessageId + 1000n),
      ).to.be.revertedWithCustomError(escrow, "EscrowNotRefunded");
    });

    it("a cancelled prompt's retry records no refund: the agent already holds the cancellation", async function () {
      const { aiAgent, escrow, user, keeper, answerMessageId } =
        await loadFixture(pendingPromptFixture);
      await time.increase(Number(await escrow.CANCELLATION_TIMEOUT()) + 1);
      await escrow.connect(user).cancelPrompt(answerMessageId);

      const retry = escrow.connect(keeper).retryRefundRecord(answerMessageId);

      await expect(retry).to.emit(escrow, "RefundRecordRetried").withArgs(answerMessageId);
      await expect(retry).to.not.emit(aiAgent, "PromptRefunded");
    });

    it("through the real agent: the job is finalized and a regeneration's prompt is unlocked", async function () {
      // The real agent cannot be made to fail on demand, so a test-only escrow puts a pending
      // regeneration in the state a refund without a record leaves behind.
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
        await ethers.getContractFactory("EVMAIAgentEscrowRefundHarness"),
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

      const eventOf = (receipt, contract, name) => {
        const topic = contract.interface.getEvent(name).topicHash;
        return contract.interface.parseLog(receipt.logs.find((l) => l.topics[0] === topic));
      };
      const promptReceipt = await (await escrow.connect(user).initiatePrompt(0, "0x", "0x")).wait();
      const { conversationId, promptMessageId, answerMessageId } = eventOf(
        promptReceipt,
        aiAgent,
        "PromptSubmitted",
      ).args;
      await aiAgent.connect(oracle).submitAnswer(promptMessageId, answerMessageId, CID_BUNDLE);
      const regenReceipt = await (
        await escrow
          .connect(user)
          .initiateRegeneration(conversationId, promptMessageId, answerMessageId, "0x", "0x")
      ).wait();
      const regenAnswerId = eventOf(regenReceipt, escrow, "PaymentEscrowed").args[0];
      await escrow.markRefundedWithoutRecord(regenAnswerId);
      expect(await aiAgent.isJobFinalized(regenAnswerId)).to.equal(false);
      expect(await aiAgent.isRegenerationPending(promptMessageId)).to.equal(true);

      await expect(escrow.connect(keeper).retryRefundRecord(regenAnswerId))
        .to.emit(aiAgent, "PromptRefunded")
        .withArgs(user.address, regenAnswerId);

      expect(await aiAgent.isJobFinalized(regenAnswerId)).to.equal(true);
      expect(await aiAgent.isRegenerationPending(promptMessageId)).to.equal(false);
    });

    it("changes nothing for a refund the agent already recorded", async function () {
      const { aiAgent, escrow, keeper, answerMessageId } = await loadFixture(refundedPromptFixture);

      const retry = escrow.connect(keeper).retryRefundRecord(answerMessageId);

      await expect(retry).to.emit(escrow, "RefundRecordRetried").withArgs(answerMessageId);
      await expect(retry).to.not.emit(aiAgent, "PromptRefunded");
      expect(await aiAgent.isJobFinalized(answerMessageId)).to.equal(true);
    });
  });

  describe("Sapphire: the refund is recorded on the real agent", function () {
    const ROFL_APP_ID = ethers.zeroPadBytes("0x00", 21);

    async function sapphirePendingPromptFixture() {
      const [deployer, user, oracle, treasury, keeper] = await ethers.getSigners();
      const aiAgent = await (
        await ethers.getContractFactory("SapphireAIAgent")
      ).deploy("example.com", ROFL_APP_ID, oracle.address, deployer.address);
      await aiAgent.waitForDeployment();
      const escrow = await (
        await ethers.getContractFactory("SapphireAIAgentEscrow")
      ).deploy(
        await aiAgent.getAddress(),
        treasury.address,
        deployer.address,
        PROMPT_FEE,
        CANCELLATION_FEE,
        METADATA_FEE,
        BRANCH_FEE,
      );
      await escrow.waitForDeployment();
      await aiAgent.connect(deployer).setAgentEscrow(await escrow.getAddress());
      await escrow.connect(user).deposit({ value: INITIAL_ALLOWANCE });
      await escrow.connect(user).setSpendingLimit((await time.latest()) + 7200);

      const receipt = await (await escrow.connect(user).initiatePrompt(0, "payload")).wait();
      const topic = aiAgent.interface.getEvent("PromptSubmitted").topicHash;
      const submitted = aiAgent.interface.parseLog(receipt.logs.find((l) => l.topics[0] === topic));
      const { promptMessageId, answerMessageId } = submitted.args;

      return { aiAgent, escrow, user, oracle, keeper, answerMessageId, promptMessageId };
    }

    async function sapphireRefundedPromptFixture() {
      const pending = await sapphirePendingPromptFixture();
      await time.increase(Number(await pending.escrow.REFUND_TIMEOUT()) + 1);
      const refundTx = await pending.escrow
        .connect(pending.keeper)
        .processRefund(pending.answerMessageId);
      return { ...pending, refundTx };
    }

    it("isJobFinalized is true and the agent emits PromptRefunded(user, answerMessageId)", async function () {
      const { aiAgent, user, answerMessageId, refundTx } = await loadFixture(
        sapphireRefundedPromptFixture,
      );
      expect(await aiAgent.isJobFinalized(answerMessageId)).to.equal(true);
      await expect(refundTx)
        .to.emit(aiAgent, "PromptRefunded")
        .withArgs(user.address, answerMessageId);
    });

    it("the escrowed fee is back in the user's deposit", async function () {
      const { escrow, user } = await loadFixture(sapphireRefundedPromptFixture);
      expect(await escrow.deposits(user.address)).to.equal(INITIAL_ALLOWANCE);
    });

    it("a retry changes nothing for a refund the agent already recorded", async function () {
      const { aiAgent, escrow, keeper, answerMessageId } = await loadFixture(
        sapphireRefundedPromptFixture,
      );

      const retry = escrow.connect(keeper).retryRefundRecord(answerMessageId);

      await expect(retry).to.emit(escrow, "RefundRecordRetried").withArgs(answerMessageId);
      await expect(retry).to.not.emit(aiAgent, "PromptRefunded");
      expect(await aiAgent.isJobFinalized(answerMessageId)).to.equal(true);
    });

    it("a cancelled prompt's retry records no refund", async function () {
      const { aiAgent, escrow, user, keeper, answerMessageId } = await loadFixture(
        sapphirePendingPromptFixture,
      );
      await time.increase(Number(await escrow.CANCELLATION_TIMEOUT()) + 1);
      await escrow.connect(user).cancelPrompt(answerMessageId);

      const retry = escrow.connect(keeper).retryRefundRecord(answerMessageId);

      await expect(retry).to.emit(escrow, "RefundRecordRetried").withArgs(answerMessageId);
      await expect(retry).to.not.emit(aiAgent, "PromptRefunded");
    });

    it("a late answer is refused by the agent's own JobAlreadyFinalized", async function () {
      const { aiAgent, oracle, answerMessageId, promptMessageId } = await loadFixture(
        sapphireRefundedPromptFixture,
      );
      await expect(
        aiAgent.connect(oracle).submitAnswer(promptMessageId, answerMessageId, CID_BUNDLE),
      ).to.be.revertedWithCustomError(aiAgent, "JobAlreadyFinalized");
    });
  });

  describe("recordRefund never blocks a refund", function () {
    async function agentWithMockEscrowFixture() {
      const [deployer, user, oracle] = await ethers.getSigners();
      const aiAgent = await upgrades.deployProxy(
        await ethers.getContractFactory("EVMAIAgent"),
        ["example.com", oracle.address, deployer.address],
        { initializer: "initialize", kind: "uups" },
      );
      await aiAgent.waitForDeployment();
      const mockEscrow = await (
        await ethers.getContractFactory("MockEVMAIAgentEscrow")
      ).deploy(await aiAgent.getAddress());
      await mockEscrow.waitForDeployment();
      await aiAgent.connect(deployer).setAgentEscrow(await mockEscrow.getAddress());
      return { aiAgent, mockEscrow, user };
    }

    it("is a no-op, not a revert, for a job that is already finalized", async function () {
      // The escrow moves the user's money in the same transaction. If the agent reverted here a
      // user could be locked out of a refund by agent-side state, so the second call must pass
      // and must not emit a second event.
      const { aiAgent, mockEscrow, user } = await loadFixture(agentWithMockEscrowFixture);
      await expect(mockEscrow.callRecordRefund(user.address, 7))
        .to.emit(aiAgent, "PromptRefunded")
        .withArgs(user.address, 7);
      const second = mockEscrow.callRecordRefund(user.address, 7);
      await expect(second).to.not.be.reverted;
      await expect(second).to.not.emit(aiAgent, "PromptRefunded");
      expect(await aiAgent.isJobFinalized(7)).to.equal(true);
    });
  });
});
