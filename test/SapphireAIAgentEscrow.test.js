const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("SapphireAIAgentEscrow", function () {
  // --- Test Suite Setup ---
  const INITIAL_DEPOSIT = ethers.parseEther("100");
  const PROMPT_FEE = ethers.parseEther("10");
  const CANCELLATION_FEE = ethers.parseEther("1");
  const METADATA_FEE = ethers.parseEther("0.5");
  const BRANCH_FEE = ethers.parseEther("2");
  const MOCK_PAYLOAD = "This is a confidential payload.";

  // Deploys contracts and sets up the test environment.
  async function deployEscrowFixture() {
    const [deployer, user, oracle, treasury, unauthorizedUser] = await ethers.getSigners();

    const MockAgentFactory = await ethers.getContractFactory("MockSapphireAIAgent");
    const mockAgent = await MockAgentFactory.deploy(oracle.address);
    await mockAgent.waitForDeployment();

    const SapphireAIAgentEscrow = await ethers.getContractFactory("SapphireAIAgentEscrow");
    const escrow = await SapphireAIAgentEscrow.deploy(
      await mockAgent.getAddress(),
      treasury.address,
      deployer.address,
      PROMPT_FEE,
      CANCELLATION_FEE,
      METADATA_FEE,
      BRANCH_FEE,
    );
    await escrow.waitForDeployment();

    await escrow.connect(user).deposit({ value: INITIAL_DEPOSIT });

    return {
      escrow,
      mockAgent,
      deployer,
      user,
      oracle,
      treasury,
      unauthorizedUser,
      SapphireAIAgentEscrow,
    };
  }

  // --- Test Cases ---

  describe("Initialization and Fee Management", function () {
    it("should set all initial fees correctly", async function () {
      const { escrow } = await loadFixture(deployEscrowFixture);
      expect(await escrow.promptFee()).to.equal(PROMPT_FEE);
      expect(await escrow.cancellationFee()).to.equal(CANCELLATION_FEE);
      expect(await escrow.metadataUpdateFee()).to.equal(METADATA_FEE);
      expect(await escrow.branchFee()).to.equal(BRANCH_FEE);
    });

    context("Initialization Failure", function () {
      it("should revert if initialized with any zero address", async function () {
        const { SapphireAIAgentEscrow, mockAgent, treasury, deployer } =
          await loadFixture(deployEscrowFixture);
        await expect(
          SapphireAIAgentEscrow.deploy(
            ethers.ZeroAddress,
            treasury.address,
            deployer.address,
            0,
            0,
            0,
            0,
          ),
        ).to.be.revertedWithCustomError(SapphireAIAgentEscrow, "ZeroAddress");
        await expect(
          SapphireAIAgentEscrow.deploy(
            await mockAgent.getAddress(),
            ethers.ZeroAddress,
            deployer.address,
            0,
            0,
            0,
            0,
          ),
        ).to.be.revertedWithCustomError(SapphireAIAgentEscrow, "ZeroAddress");
      });
    });

    context("All Fee Setters", function () {
      it("should allow the owner to update all fees", async function () {
        const { escrow, deployer } = await loadFixture(deployEscrowFixture);
        const newFee = ethers.parseEther("5");

        await expect(escrow.connect(deployer).setPromptFee(newFee)).to.emit(
          escrow,
          "PromptFeeUpdated",
        );
        await expect(escrow.connect(deployer).setCancellationFee(newFee)).to.emit(
          escrow,
          "CancellationFeeUpdated",
        );
        await expect(escrow.connect(deployer).setMetadataUpdateFee(newFee)).to.emit(
          escrow,
          "MetadataUpdateFeeUpdated",
        );
        await expect(escrow.connect(deployer).setBranchFee(newFee)).to.emit(
          escrow,
          "BranchFeeUpdated",
        );
      });

      it("should prevent a non-owner from updating any fee", async function () {
        const { escrow, unauthorizedUser } = await loadFixture(deployEscrowFixture);
        const newFee = ethers.parseEther("5");

        await expect(
          escrow.connect(unauthorizedUser).setPromptFee(newFee),
        ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
      });

      it("should revert if owner tries to set treasury to zero address", async function () {
        const { escrow, deployer } = await loadFixture(deployEscrowFixture);
        await expect(
          escrow.connect(deployer).setTreasury(ethers.ZeroAddress),
        ).to.be.revertedWithCustomError(escrow, "ZeroAddress");
      });
    });
  });

  describe("Subscription and Deposit Management", function () {
    it("should allow a user to deposit, withdraw, and manage a subscription", async function () {
      const { escrow, user } = await loadFixture(deployEscrowFixture);
      const expiresAt = (await time.latest()) + 3600;
      expect(await escrow.deposits(user.address)).to.equal(INITIAL_DEPOSIT);
      await expect(escrow.connect(user).setSubscription(expiresAt)).to.emit(
        escrow,
        "SubscriptionSet",
      );
      const withdrawAmount = ethers.parseEther("10");
      await escrow.connect(user).withdraw(withdrawAmount);
      expect(await escrow.deposits(user.address)).to.equal(INITIAL_DEPOSIT - withdrawAmount);
      const userBalanceBefore = await ethers.provider.getBalance(user.address);
      const tx = await escrow.connect(user).cancelSubscription();
      const receipt = await tx.wait();
      const gasUsed = receipt.gasUsed * tx.gasPrice;
      const userBalanceAfter = await ethers.provider.getBalance(user.address);
      expect(await escrow.deposits(user.address)).to.equal(0);
      expect(userBalanceAfter).to.equal(
        userBalanceBefore + INITIAL_DEPOSIT - withdrawAmount - gasUsed,
      );
    });

    it("should allow a user with zero deposit to cancel their subscription", async function () {
      const { escrow, unauthorizedUser } = await loadFixture(deployEscrowFixture);
      await escrow.connect(unauthorizedUser).setSubscription((await time.latest()) + 3600);
      await expect(escrow.connect(unauthorizedUser).cancelSubscription()).to.not.emit(
        escrow,
        "Withdrawal",
      );
    });

    context("With Pending Prompts", function () {
      let escrow, user;
      beforeEach(async function () {
        const fixtures = await loadFixture(deployEscrowFixture);
        escrow = fixtures.escrow;
        user = fixtures.user;
        await escrow.connect(user).setSubscription((await time.latest()) + 3600);
        await escrow.connect(user).initiatePrompt(0, MOCK_PAYLOAD);
      });

      it("should revert if user tries to set a new subscription", async function () {
        await expect(
          escrow.connect(user).setSubscription((await time.latest()) + 7200),
        ).to.be.revertedWithCustomError(escrow, "HasPendingPrompts");
      });

      it("should revert if user tries to cancel their subscription", async function () {
        await expect(escrow.connect(user).cancelSubscription()).to.be.revertedWithCustomError(
          escrow,
          "HasPendingPrompts",
        );
      });
    });
  });

  describe("User Actions: Escrow-Based", function () {
    let escrow, user, oracle;
    beforeEach(async function () {
      const fixtures = await loadFixture(deployEscrowFixture);
      ({ escrow, user, oracle } = fixtures);
      await escrow.connect(user).setSubscription((await time.latest()) + 3600);
    });

    it("should handle a new prompt, deducting from deposit", async function () {
      const initialDeposit = await escrow.deposits(user.address);
      await escrow.connect(user).initiatePrompt(0, MOCK_PAYLOAD);
      expect(await escrow.deposits(user.address)).to.equal(initialDeposit - PROMPT_FEE);
    });

    it("should handle a regeneration, deducting from deposit", async function () {
      const initialDeposit = await escrow.deposits(user.address);
      await escrow.connect(user).initiateRegeneration(0, 99, MOCK_PAYLOAD);
      expect(await escrow.deposits(user.address)).to.equal(initialDeposit - PROMPT_FEE);
    });

    it("should handle an agent job, deducting from deposit", async function () {
      const initialDeposit = await escrow.deposits(user.address);
      await escrow.connect(oracle).initiateAgentJob(user.address, 0, MOCK_PAYLOAD);
      expect(await escrow.deposits(user.address)).to.equal(initialDeposit - PROMPT_FEE);
    });
  });

  describe("User Actions: Direct Payment", function () {
    let escrow, user, treasury;
    beforeEach(async function () {
      const fixtures = await loadFixture(deployEscrowFixture);
      ({ escrow, user, treasury } = fixtures);
      await escrow.connect(user).setSubscription((await time.latest()) + 3600);
    });

    it("should handle a metadata update, paying treasury from deposit", async function () {
      const initialDeposit = await escrow.deposits(user.address);
      const initialTreasuryBalance = await ethers.provider.getBalance(treasury.address);
      await escrow.connect(user).initiateMetadataUpdate(1, MOCK_PAYLOAD);
      expect(await escrow.deposits(user.address)).to.equal(initialDeposit - METADATA_FEE);
      expect(await ethers.provider.getBalance(treasury.address)).to.equal(
        initialTreasuryBalance + METADATA_FEE,
      );
    });

    it("should handle a branch request, paying treasury from deposit", async function () {
      const initialDeposit = await escrow.deposits(user.address);
      const initialTreasuryBalance = await ethers.provider.getBalance(treasury.address);
      await escrow.connect(user).initiateBranch(1, 2);
      expect(await escrow.deposits(user.address)).to.equal(initialDeposit - BRANCH_FEE);
      expect(await ethers.provider.getBalance(treasury.address)).to.equal(
        initialTreasuryBalance + BRANCH_FEE,
      );
    });
  });

  describe("Initiation Failure Scenarios", function () {
    it("should revert if user has no active subscription", async function () {
      const { escrow, user } = await loadFixture(deployEscrowFixture);
      await expect(
        escrow.connect(user).initiatePrompt(0, MOCK_PAYLOAD),
      ).to.be.revertedWithCustomError(escrow, "NoActiveSubscription");
    });

    it("should revert if subscription is expired", async function () {
      const { escrow, user } = await loadFixture(deployEscrowFixture);
      await escrow.connect(user).setSubscription((await time.latest()) + 3600);
      await time.increase(3601);
      await expect(
        escrow.connect(user).initiatePrompt(0, MOCK_PAYLOAD),
      ).to.be.revertedWithCustomError(escrow, "SubscriptionExpired");
    });

    it("should revert if user has insufficient deposit", async function () {
      const { escrow, unauthorizedUser } = await loadFixture(deployEscrowFixture);
      await escrow.connect(unauthorizedUser).setSubscription((await time.latest()) + 3600);
      await expect(
        escrow.connect(unauthorizedUser).initiatePrompt(0, MOCK_PAYLOAD),
      ).to.be.revertedWithCustomError(escrow, "InsufficientDeposit");
    });
  });

  describe("Cancellation and Refund Flows", function () {
    let escrow, mockAgent, user, unauthorizedUser, treasury;
    const answerMessageId = 1;

    beforeEach(async function () {
      const fixtures = await loadFixture(deployEscrowFixture);
      ({ escrow, mockAgent, user, unauthorizedUser, treasury } = fixtures);
      await escrow.connect(user).setSubscription((await time.latest()) + 7200);
      await escrow.connect(user).initiatePrompt(0, MOCK_PAYLOAD);
    });

    it("should allow a user to cancel a prompt", async function () {
      await time.increase(5);
      const initialDeposit = await escrow.deposits(user.address);
      const initialTreasuryBalance = await ethers.provider.getBalance(treasury.address);
      await expect(escrow.connect(user).cancelPrompt(answerMessageId)).to.emit(
        escrow,
        "PromptCancelled",
      );
      const expectedDeposit = initialDeposit + PROMPT_FEE - CANCELLATION_FEE;
      expect(await escrow.deposits(user.address)).to.equal(expectedDeposit);
      expect(await ethers.provider.getBalance(treasury.address)).to.equal(
        initialTreasuryBalance + CANCELLATION_FEE,
      );
    });

    it("should allow a keeper to process a refund", async function () {
      await time.increase(3601);
      const initialDeposit = await escrow.deposits(user.address);
      await expect(escrow.processRefund(answerMessageId)).to.emit(escrow, "PaymentRefunded");
      expect(await escrow.deposits(user.address)).to.equal(initialDeposit + PROMPT_FEE);
    });

    it("should revert if a non-owner tries to cancel", async function () {
      await time.increase(5);
      await expect(
        escrow.connect(unauthorizedUser).cancelPrompt(answerMessageId),
      ).to.be.revertedWithCustomError(escrow, "NotPromptOwner");
    });

    it("should revert if cancelling before timeout", async function () {
      await expect(
        escrow.connect(user).cancelPrompt(answerMessageId),
      ).to.be.revertedWithCustomError(escrow, "PromptNotCancellableYet");
    });

    it("should revert if refunding before timeout", async function () {
      await expect(
        escrow.connect(user).processRefund(answerMessageId),
      ).to.be.revertedWithCustomError(escrow, "PromptNotRefundableYet");
    });

    it("should revert cancelPrompt if user cannot afford the cancellation fee", async function () {
      const { escrow, user } = await loadFixture(deployEscrowFixture);
      await escrow.connect(user).withdraw(INITIAL_DEPOSIT); // Withdraw all funds
      await escrow.connect(user).deposit({ value: PROMPT_FEE }); // Deposit just enough for the prompt
      await escrow.connect(user).setSubscription((await time.latest()) + 7200);
      await escrow.connect(user).initiatePrompt(0, MOCK_PAYLOAD); // User deposit is now 0
      await time.increase(5);
      await expect(escrow.connect(user).cancelPrompt(1)).to.be.revertedWithCustomError(
        escrow,
        "InsufficientDeposit",
      );
    });

    context("Refund Failure Paths", function () {
      it("should silently return if processRefund is called for a non-existent escrow", async function () {
        const { escrow } = await loadFixture(deployEscrowFixture);
        await expect(escrow.processRefund(999)).to.not.be.reverted;
      });

      it("should revert if processRefund is called on an already completed escrow", async function () {
        const agentSigner = await ethers.getImpersonatedSigner(await mockAgent.getAddress());
        await ethers.provider.send("hardhat_setBalance", [
          agentSigner.address,
          "0x1" + "0".repeat(18),
        ]);
        await escrow.connect(agentSigner).finalizePayment(answerMessageId);
        await time.increase(3601);
        await expect(escrow.processRefund(answerMessageId)).to.be.revertedWithCustomError(
          escrow,
          "EscrowNotPending",
        );
      });
    });
  });

  describe("Finalization and State Guards", function () {
    it("should allow the agent to finalize payment", async function () {
      const { escrow, mockAgent, user, treasury } = await loadFixture(deployEscrowFixture);
      await escrow.connect(user).setSubscription((await time.latest()) + 3600);
      await escrow.connect(user).initiatePrompt(0, MOCK_PAYLOAD);
      const answerMessageId = 1;
      const initialTreasuryBalance = await ethers.provider.getBalance(treasury.address);
      const agentSigner = await ethers.getImpersonatedSigner(await mockAgent.getAddress());
      await ethers.provider.send("hardhat_setBalance", [
        agentSigner.address,
        "0x1" + "0".repeat(18),
      ]);
      await expect(escrow.connect(agentSigner).finalizePayment(answerMessageId)).to.emit(
        escrow,
        "PaymentFinalized",
      );
      expect(await ethers.provider.getBalance(treasury.address)).to.equal(
        initialTreasuryBalance + PROMPT_FEE,
      );
    });

    context("Access Control", function () {
      it("should revert if a non-agent address calls finalizePayment", async function () {
        const { escrow, user } = await loadFixture(deployEscrowFixture);
        await expect(escrow.connect(user).finalizePayment(0)).to.be.revertedWithCustomError(
          escrow,
          "NotSapphireAIAgent",
        );
      });

      it("should revert if a non-oracle calls initiateAgentJob", async function () {
        const { escrow, user } = await loadFixture(deployEscrowFixture);
        await expect(
          escrow.connect(user).initiateAgentJob(user.address, 0, "0x"),
        ).to.be.revertedWithCustomError(escrow, "NotOracle");
      });
    });

    context("State Guard Reverts", function () {
      let escrow, mockAgent, user, agentSigner;
      const escrowId = 1;
      beforeEach(async function () {
        const fixtures = await loadFixture(deployEscrowFixture);
        ({ escrow, mockAgent, user } = fixtures);
        await escrow.connect(user).setSubscription((await time.latest()) + 7200);
        await escrow.connect(user).initiatePrompt(0, MOCK_PAYLOAD);

        agentSigner = await ethers.getImpersonatedSigner(await mockAgent.getAddress());
        await ethers.provider.send("hardhat_setBalance", [
          agentSigner.address,
          "0x1" + "0".repeat(18),
        ]);
        await escrow.connect(agentSigner).finalizePayment(escrowId);
      });

      it("should revert if finalizing a non-existent escrow", async function () {
        await expect(
          escrow.connect(agentSigner).finalizePayment(999),
        ).to.be.revertedWithCustomError(escrow, "EscrowNotFound");
      });

      it("should revert if finalizing an already finalized escrow", async function () {
        await expect(
          escrow.connect(agentSigner).finalizePayment(escrowId),
        ).to.be.revertedWithCustomError(escrow, "EscrowNotPending");
      });

      it("should revert if cancelling a completed escrow", async function () {
        await time.increase(5);
        await expect(escrow.connect(user).cancelPrompt(escrowId)).to.be.revertedWithCustomError(
          escrow,
          "EscrowNotPending",
        );
      });
    });
  });
});
