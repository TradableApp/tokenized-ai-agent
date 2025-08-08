const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("SapphireAIAgentEscrow", function () {
  // --- Test Suite Setup ---
  const PROMPT_FEE = ethers.parseEther("1");
  const INITIAL_DEPOSIT = ethers.parseEther("10");
  const PROMPT_TEXT = "What is the nature of consciousness?";

  // Deploys contracts and sets up the test environment.
  // This fixture is used by `loadFixture` to speed up tests.
  async function deployEscrowFixture() {
    const [deployer, user, oracle, treasury, unauthorizedUser] = await ethers.getSigners();

    // 1. Deploy the mock agent dependency.
    const MockAgentFactory = await ethers.getContractFactory("MockSapphireAIAgent");
    const mockAgent = await MockAgentFactory.deploy();
    await mockAgent.waitForDeployment();

    // 2. Deploy the main Escrow contract, linking it to the mock.
    const SapphireAIAgentEscrow = await ethers.getContractFactory("SapphireAIAgentEscrow");
    const escrow = await SapphireAIAgentEscrow.deploy(
      await mockAgent.getAddress(),
      treasury.address,
      oracle.address,
      deployer.address, // owner
    );
    await escrow.waitForDeployment();

    // 3. Have the user deposit funds for testing.
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

  describe("Initialization", function () {
    it("should set the correct initial state and owner", async function () {
      const { escrow, mockAgent, deployer, treasury, oracle } =
        await loadFixture(deployEscrowFixture);
      expect(await escrow.owner()).to.equal(deployer.address);
      expect(await escrow.treasury()).to.equal(treasury.address);
      expect(await escrow.oracle()).to.equal(oracle.address);
      expect(await escrow.SAPPHIRE_AI_AGENT()).to.equal(await mockAgent.getAddress());
    });

    it("should revert if deployed with a zero address for the agent", async function () {
      const { SapphireAIAgentEscrow, deployer, treasury, oracle } =
        await loadFixture(deployEscrowFixture);
      await expect(
        SapphireAIAgentEscrow.deploy(
          ethers.ZeroAddress, // Invalid agent
          treasury.address,
          oracle.address,
          deployer.address,
        ),
      ).to.be.revertedWithCustomError(SapphireAIAgentEscrow, "ZeroAddress");
    });

    it("should revert if deployed with a zero address for the treasury", async function () {
      const { SapphireAIAgentEscrow, mockAgent, deployer, oracle } =
        await loadFixture(deployEscrowFixture);
      await expect(
        SapphireAIAgentEscrow.deploy(
          await mockAgent.getAddress(),
          ethers.ZeroAddress, // Invalid treasury
          oracle.address,
          deployer.address,
        ),
      ).to.be.revertedWithCustomError(SapphireAIAgentEscrow, "ZeroAddress");
    });

    it("should revert if deployed with a zero address for the oracle", async function () {
      const { SapphireAIAgentEscrow, mockAgent, deployer, treasury } =
        await loadFixture(deployEscrowFixture);
      await expect(
        SapphireAIAgentEscrow.deploy(
          await mockAgent.getAddress(),
          treasury.address,
          ethers.ZeroAddress, // Invalid oracle
          deployer.address,
        ),
      ).to.be.revertedWithCustomError(SapphireAIAgentEscrow, "ZeroAddress");
    });

    it("should revert if deployed with a zero address for the owner", async function () {
      const { SapphireAIAgentEscrow, mockAgent, treasury, oracle } =
        await loadFixture(deployEscrowFixture);
      await expect(
        SapphireAIAgentEscrow.deploy(
          await mockAgent.getAddress(),
          treasury.address,
          oracle.address,
          ethers.ZeroAddress, // Invalid owner
        ),
      ).to.be.revertedWithCustomError(SapphireAIAgentEscrow, "OwnableInvalidOwner");
    });
  });

  describe("Administrative Functions", function () {
    it("should allow the owner to set a new treasury", async function () {
      const { escrow, deployer, unauthorizedUser } = await loadFixture(deployEscrowFixture);
      await escrow.connect(deployer).setTreasury(unauthorizedUser.address);
      expect(await escrow.treasury()).to.equal(unauthorizedUser.address);
    });

    it("should prevent a non-owner from setting a new treasury", async function () {
      const { escrow, unauthorizedUser } = await loadFixture(deployEscrowFixture);
      await expect(
        escrow.connect(unauthorizedUser).setTreasury(unauthorizedUser.address),
      ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
    });

    it("should revert if owner tries to set treasury to the zero address", async function () {
      const { escrow, deployer } = await loadFixture(deployEscrowFixture);
      await expect(
        escrow.connect(deployer).setTreasury(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(escrow, "ZeroAddress");
    });

    it("should allow the owner to set a new oracle", async function () {
      const { escrow, deployer, unauthorizedUser } = await loadFixture(deployEscrowFixture);
      await escrow.connect(deployer).setOracle(unauthorizedUser.address);
      expect(await escrow.oracle()).to.equal(unauthorizedUser.address);
    });

    it("should prevent a non-owner from setting a new oracle", async function () {
      const { escrow, unauthorizedUser } = await loadFixture(deployEscrowFixture);
      await expect(
        escrow.connect(unauthorizedUser).setOracle(unauthorizedUser.address),
      ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
    });

    it("should revert if owner tries to set oracle to the zero address", async function () {
      const { escrow, deployer } = await loadFixture(deployEscrowFixture);
      await expect(
        escrow.connect(deployer).setOracle(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(escrow, "ZeroAddress");
    });
  });

  describe("Deposit and Withdrawal", function () {
    it("should accept user deposits", async function () {
      const { escrow, user } = await loadFixture(deployEscrowFixture);
      expect(await escrow.deposits(user.address)).to.equal(INITIAL_DEPOSIT);
    });

    it("should allow a user to withdraw their full balance", async function () {
      const { escrow, user } = await loadFixture(deployEscrowFixture);
      const initialBalance = await ethers.provider.getBalance(user.address);
      const tx = await escrow.connect(user).withdraw(INITIAL_DEPOSIT);
      const receipt = await tx.wait();
      const gasUsed = receipt.gasUsed * receipt.gasPrice;

      const finalBalance = await ethers.provider.getBalance(user.address);
      expect(finalBalance).to.equal(initialBalance + INITIAL_DEPOSIT - gasUsed);
      expect(await escrow.deposits(user.address)).to.equal(0);
    });

    it("should revert if a user tries to withdraw more than their balance", async function () {
      const { escrow, user } = await loadFixture(deployEscrowFixture);
      await expect(
        escrow.connect(user).withdraw(INITIAL_DEPOSIT + 1n),
      ).to.be.revertedWithCustomError(escrow, "InsufficientBalanceForWithdrawal");
    });
  });

  describe("Subscription Management", function () {
    it("should allow a user to set and cancel a subscription", async function () {
      const { escrow, user } = await loadFixture(deployEscrowFixture);
      const expiresAt = (await time.latest()) + 3600;

      await expect(escrow.connect(user).setSubscription(expiresAt))
        .to.emit(escrow, "SubscriptionSet")
        .withArgs(user.address, expiresAt);

      const sub = await escrow.subscriptions(user.address);
      expect(sub).to.equal(expiresAt); // Assert on the value itself.

      await expect(escrow.connect(user).cancelSubscription())
        .to.emit(escrow, "SubscriptionCancelled")
        .withArgs(user.address);

      const finalSub = await escrow.subscriptions(user.address);
      expect(finalSub).to.equal(0);
    });
  });

  describe("Prompt Initiation", function () {
    context("by a User (initiatePrompt)", function () {
      it("should successfully initiate from the user's deposit", async function () {
        const { escrow, mockAgent, user } = await loadFixture(deployEscrowFixture);
        await escrow.connect(user).setSubscription((await time.latest()) + 3600);
        const promptId = await mockAgent.promptIdCounter();
        // The user calls the non-payable function. The contract uses their deposited funds.
        await expect(escrow.connect(user).initiatePrompt(PROMPT_TEXT))
          .to.emit(escrow, "PaymentEscrowed")
          .withArgs(promptId, user.address, PROMPT_FEE);

        expect(await escrow.deposits(user.address)).to.equal(INITIAL_DEPOSIT - PROMPT_FEE);
      });
    });

    context("by the Oracle (initiateAgentJob)", function () {
      it("should successfully initiate on behalf of a user from their deposit", async function () {
        const { escrow, user, oracle } = await loadFixture(deployEscrowFixture);
        await escrow.connect(user).setSubscription((await time.latest()) + 3600);
        await escrow.connect(oracle).initiateAgentJob(user.address, PROMPT_TEXT);
        expect(await escrow.deposits(user.address)).to.equal(INITIAL_DEPOSIT - PROMPT_FEE);
      });
    });

    context("Failure Scenarios", function () {
      it("should revert if user has no active subscription", async function () {
        const { escrow, user } = await loadFixture(deployEscrowFixture);
        // Note: No subscription is set for the user.
        await expect(
          escrow.connect(user).initiatePrompt(PROMPT_TEXT),
        ).to.be.revertedWithCustomError(escrow, "NoActiveSubscription");
      });

      it("should revert if subscription is expired", async function () {
        const { escrow, user } = await loadFixture(deployEscrowFixture);
        const expiresAt = (await time.latest()) + 3600;
        await escrow.connect(user).setSubscription(expiresAt);
        await time.increase(3601); // Expire it.

        await expect(
          escrow.connect(user).initiatePrompt(PROMPT_TEXT),
        ).to.be.revertedWithCustomError(escrow, "SubscriptionExpired");
      });

      it("should revert if user has insufficient deposit", async function () {
        const { escrow, unauthorizedUser } = await loadFixture(deployEscrowFixture);
        // This user has 0 deposit.
        await escrow.connect(unauthorizedUser).setSubscription((await time.latest()) + 3600);
        await expect(
          escrow.connect(unauthorizedUser).initiatePrompt(PROMPT_TEXT),
        ).to.be.revertedWithCustomError(escrow, "InsufficientDeposit");
      });

      it("should revert if a non-oracle tries to initiate an agent job", async function () {
        const { escrow, user, unauthorizedUser } = await loadFixture(deployEscrowFixture);
        await escrow.connect(user).setSubscription((await time.latest()) + 3600);
        await expect(
          escrow.connect(unauthorizedUser).initiateAgentJob(user.address, PROMPT_TEXT),
        ).to.be.revertedWithCustomError(escrow, "NotOracle");
      });
    });
  });

  describe("Payment Finalization and Refunds", function () {
    it("should allow the agent to finalize payment", async function () {
      const { escrow, mockAgent, deployer, user, treasury } =
        await loadFixture(deployEscrowFixture);
      await escrow.connect(user).setSubscription((await time.latest()) + 3600);
      const promptId = await mockAgent.promptIdCounter();
      await escrow.connect(user).initiatePrompt(PROMPT_TEXT);

      const initialTreasuryBalance = await ethers.provider.getBalance(treasury.address);
      await mockAgent.connect(deployer).callFinalizePayment(await escrow.getAddress(), promptId);
      expect(await ethers.provider.getBalance(treasury.address)).to.equal(
        initialTreasuryBalance + PROMPT_FEE,
      );
      const escrowRecord = await escrow.escrows(promptId);
      expect(escrowRecord.status).to.equal(1); // Enum COMPLETE
    });

    it("should revert if a non-agent tries to finalize payment", async function () {
      const { escrow, user, unauthorizedUser } = await loadFixture(deployEscrowFixture);
      await escrow.connect(user).setSubscription((await time.latest()) + 3600);
      await escrow.connect(user).initiatePrompt(PROMPT_TEXT);
      const promptId = 0;
      await expect(
        escrow.connect(unauthorizedUser).finalizePayment(promptId),
      ).to.be.revertedWithCustomError(escrow, "NotSapphireAIAgent");
    });

    it("should revert when finalizing a non-existent prompt", async function () {
      const { escrow, mockAgent, deployer } = await loadFixture(deployEscrowFixture);
      const invalidPromptId = 99;
      await expect(
        mockAgent.connect(deployer).callFinalizePayment(await escrow.getAddress(), invalidPromptId),
      ).to.be.revertedWithCustomError(escrow, "EscrowNotFound");
    });

    it("should revert when finalizing a prompt that is not pending", async function () {
      const { escrow, mockAgent, deployer, user } = await loadFixture(deployEscrowFixture);
      await escrow.connect(user).setSubscription((await time.latest()) + 3600);
      const promptId = await mockAgent.promptIdCounter();
      await escrow.connect(user).initiatePrompt(PROMPT_TEXT);

      // Finalize it once, which should succeed.
      await mockAgent.connect(deployer).callFinalizePayment(await escrow.getAddress(), promptId);

      // Trying to finalize it a second time should fail.
      await expect(
        mockAgent.connect(deployer).callFinalizePayment(await escrow.getAddress(), promptId),
      ).to.be.revertedWithCustomError(escrow, "EscrowNotPending");
    });

    it("should allow a timed-out prompt to be refunded to the user's deposit", async function () {
      const { escrow, mockAgent, deployer, user } = await loadFixture(deployEscrowFixture);
      await escrow.connect(user).setSubscription((await time.latest()) + 3600);
      const promptId = await mockAgent.promptIdCounter();
      await escrow.connect(user).initiatePrompt(PROMPT_TEXT);

      await time.increase(3601); // Increase time past the REFUND_TIMEOUT
      const initialUserDeposit = await escrow.deposits(user.address);
      await escrow.connect(deployer).processRefund(promptId);
      expect(await escrow.deposits(user.address)).to.equal(initialUserDeposit + PROMPT_FEE);
      const escrowRecord = await escrow.escrows(promptId);
      expect(escrowRecord.status).to.equal(2); // Enum REFUNDED
    });

    it("should not refund a prompt that has not timed out", async function () {
      const { escrow, mockAgent, deployer, user } = await loadFixture(deployEscrowFixture);
      await escrow.connect(user).setSubscription((await time.latest()) + 3600);
      const promptId = await mockAgent.promptIdCounter();
      await escrow.connect(user).initiatePrompt(PROMPT_TEXT);

      const initialUserDeposit = await escrow.deposits(user.address);
      // Attempt to refund immediately, without waiting for the timeout.
      await escrow.connect(deployer).processRefund(promptId);

      // The user's deposit should be unchanged.
      expect(await escrow.deposits(user.address)).to.equal(initialUserDeposit);
      const escrowRecord = await escrow.escrows(promptId);
      expect(escrowRecord.status).to.equal(0); // Enum PENDING
    });
  });
});
