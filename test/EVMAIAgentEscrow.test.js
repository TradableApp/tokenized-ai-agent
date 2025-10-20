const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("EVMAIAgentEscrow (Upgradable)", function () {
  // --- Test Suite Setup ---
  const INITIAL_ALLOWANCE = ethers.parseEther("100");
  const PROMPT_FEE = ethers.parseEther("10");
  const CANCELLATION_FEE = ethers.parseEther("1");
  const METADATA_FEE = ethers.parseEther("0.5");
  const BRANCH_FEE = ethers.parseEther("2");
  const MOCK_ENCRYPTED_PAYLOAD = "0x1234";
  const MOCK_ROFL_KEY = "0x5678";

  // Deploys contracts and sets up the test environment.
  async function deployEscrowFixture() {
    const [deployer, user, oracle, treasury, unauthorizedUser] = await ethers.getSigners();

    const MockAgentFactory = await ethers.getContractFactory("MockEVMAIAgent");
    const mockAgent = await MockAgentFactory.deploy();
    await mockAgent.waitForDeployment();

    const MockTokenFactory = await ethers.getContractFactory("MockAbleToken");
    const mockToken = await MockTokenFactory.deploy();
    await mockToken.waitForDeployment();

    await mockToken.mint(user.address, INITIAL_ALLOWANCE);

    const EVMAIAgentEscrow = await ethers.getContractFactory("EVMAIAgentEscrow");
    const escrow = await upgrades.deployProxy(
      EVMAIAgentEscrow,
      [
        await mockToken.getAddress(),
        await mockAgent.getAddress(),
        treasury.address,
        oracle.address,
        deployer.address,
        PROMPT_FEE,
        CANCELLATION_FEE,
        METADATA_FEE,
        BRANCH_FEE,
      ],
      { initializer: "initialize", kind: "uups" },
    );
    await escrow.waitForDeployment();

    await mockToken.connect(user).approve(await escrow.getAddress(), INITIAL_ALLOWANCE);

    return {
      escrow,
      mockAgent,
      mockToken,
      deployer,
      user,
      oracle,
      treasury,
      unauthorizedUser,
      EVMAIAgentEscrow,
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
        const { EVMAIAgentEscrow, mockToken, mockAgent, treasury, oracle, deployer } =
          await loadFixture(deployEscrowFixture);

        await expect(
          upgrades.deployProxy(EVMAIAgentEscrow, [
            ethers.ZeroAddress,
            await mockAgent.getAddress(),
            treasury.address,
            oracle.address,
            deployer.address,
            0,
            0,
            0,
            0,
          ]),
        ).to.be.revertedWithCustomError(EVMAIAgentEscrow, "ZeroAddress");
        await expect(
          upgrades.deployProxy(EVMAIAgentEscrow, [
            await mockToken.getAddress(),
            ethers.ZeroAddress,
            treasury.address,
            oracle.address,
            deployer.address,
            0,
            0,
            0,
            0,
          ]),
        ).to.be.revertedWithCustomError(EVMAIAgentEscrow, "ZeroAddress");
        await expect(
          upgrades.deployProxy(EVMAIAgentEscrow, [
            await mockToken.getAddress(),
            await mockAgent.getAddress(),
            ethers.ZeroAddress,
            oracle.address,
            deployer.address,
            0,
            0,
            0,
            0,
          ]),
        ).to.be.revertedWithCustomError(EVMAIAgentEscrow, "ZeroAddress");
        await expect(
          upgrades.deployProxy(EVMAIAgentEscrow, [
            await mockToken.getAddress(),
            await mockAgent.getAddress(),
            treasury.address,
            ethers.ZeroAddress,
            deployer.address,
            0,
            0,
            0,
            0,
          ]),
        ).to.be.revertedWithCustomError(EVMAIAgentEscrow, "ZeroAddress");
      });
    });

    context("All Fee Setters", function () {
      it("should allow the owner to update all fees", async function () {
        const { escrow, deployer } = await loadFixture(deployEscrowFixture);
        const newFee = ethers.parseEther("5");

        await expect(escrow.connect(deployer).setPromptFee(newFee))
          .to.emit(escrow, "PromptFeeUpdated")
          .withArgs(newFee);
        expect(await escrow.promptFee()).to.equal(newFee);

        await expect(escrow.connect(deployer).setCancellationFee(newFee))
          .to.emit(escrow, "CancellationFeeUpdated")
          .withArgs(newFee);
        expect(await escrow.cancellationFee()).to.equal(newFee);

        await expect(escrow.connect(deployer).setMetadataUpdateFee(newFee))
          .to.emit(escrow, "MetadataUpdateFeeUpdated")
          .withArgs(newFee);
        expect(await escrow.metadataUpdateFee()).to.equal(newFee);

        await expect(escrow.connect(deployer).setBranchFee(newFee))
          .to.emit(escrow, "BranchFeeUpdated")
          .withArgs(newFee);
        expect(await escrow.branchFee()).to.equal(newFee);
      });

      it("should prevent a non-owner from updating any fee", async function () {
        const { escrow, unauthorizedUser } = await loadFixture(deployEscrowFixture);
        const newFee = ethers.parseEther("5");

        await expect(
          escrow.connect(unauthorizedUser).setPromptFee(newFee),
        ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
        await expect(
          escrow.connect(unauthorizedUser).setCancellationFee(newFee),
        ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
        await expect(
          escrow.connect(unauthorizedUser).setMetadataUpdateFee(newFee),
        ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
        await expect(
          escrow.connect(unauthorizedUser).setBranchFee(newFee),
        ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
      });

      it("should revert if owner tries to set treasury or oracle to zero address", async function () {
        const { escrow, deployer } = await loadFixture(deployEscrowFixture);
        await expect(
          escrow.connect(deployer).setTreasury(ethers.ZeroAddress),
        ).to.be.revertedWithCustomError(escrow, "ZeroAddress");
        await expect(
          escrow.connect(deployer).setOracle(ethers.ZeroAddress),
        ).to.be.revertedWithCustomError(escrow, "ZeroAddress");
      });
    });
  });

  describe("Subscription Management", function () {
    it("should allow a user to set and cancel a subscription if they have no pending prompts", async function () {
      const { escrow, user } = await loadFixture(deployEscrowFixture);
      const expiresAt = (await time.latest()) + 3600;
      await expect(escrow.connect(user).setSubscription(INITIAL_ALLOWANCE, expiresAt))
        .to.emit(escrow, "SubscriptionSet")
        .withArgs(user.address, INITIAL_ALLOWANCE, expiresAt);

      await expect(escrow.connect(user).cancelSubscription())
        .to.emit(escrow, "SubscriptionCancelled")
        .withArgs(user.address);
    });

    context("With Pending Prompts", function () {
      let escrow, user;
      beforeEach(async function () {
        const fixtures = await loadFixture(deployEscrowFixture);
        escrow = fixtures.escrow;
        user = fixtures.user;
        await escrow.connect(user).setSubscription(INITIAL_ALLOWANCE, (await time.latest()) + 3600);
        await escrow.connect(user).initiatePrompt(0, "0x", "0x");
      });

      it("should revert if user tries to set a new subscription", async function () {
        await expect(
          escrow.connect(user).setSubscription(INITIAL_ALLOWANCE, (await time.latest()) + 7200),
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
    let escrow, mockAgent, mockToken, user, oracle;

    beforeEach(async function () {
      const fixtures = await loadFixture(deployEscrowFixture);
      ({ escrow, mockAgent, mockToken, user, oracle } = fixtures);
      await escrow.connect(user).setSubscription(INITIAL_ALLOWANCE, (await time.latest()) + 3600);
    });

    it("should handle a new prompt in a new conversation", async function () {
      const expectedAnswerId = 1;
      await expect(escrow.connect(user).initiatePrompt(0, MOCK_ENCRYPTED_PAYLOAD, MOCK_ROFL_KEY))
        .to.emit(escrow, "PaymentEscrowed")
        .withArgs(expectedAnswerId, user.address, PROMPT_FEE);
    });

    it("should handle a regeneration request", async function () {
      const expectedNewAnswerId = 0;
      await expect(
        escrow.connect(user).initiateRegeneration(0, 99, MOCK_ENCRYPTED_PAYLOAD, MOCK_ROFL_KEY),
      )
        .to.emit(escrow, "PaymentEscrowed")
        .withArgs(expectedNewAnswerId, user.address, PROMPT_FEE);
    });

    it("should handle an agent job initiated by the oracle", async function () {
      const expectedTriggerId = 0;
      await expect(
        escrow
          .connect(oracle)
          .initiateAgentJob(user.address, 0, MOCK_ENCRYPTED_PAYLOAD, MOCK_ROFL_KEY),
      )
        .to.emit(escrow, "PaymentEscrowed")
        .withArgs(expectedTriggerId, user.address, PROMPT_FEE);
    });
  });

  describe("User Actions: Direct Payment", function () {
    let escrow, mockAgent, user, treasury, mockToken;
    beforeEach(async function () {
      const fixtures = await loadFixture(deployEscrowFixture);
      ({ escrow, mockAgent, user, treasury, mockToken } = fixtures);
      await escrow.connect(user).setSubscription(INITIAL_ALLOWANCE, (await time.latest()) + 3600);
    });

    it("should handle a metadata update request", async function () {
      const initialTreasuryBalance = await mockToken.balanceOf(treasury.address);
      await escrow.connect(user).initiateMetadataUpdate(1, "0x", "0x");
      expect(await mockToken.balanceOf(treasury.address)).to.equal(
        initialTreasuryBalance + METADATA_FEE,
      );
      expect(await mockAgent.lastConversationId()).to.equal(1);
    });

    it("should handle a branch request", async function () {
      const initialTreasuryBalance = await mockToken.balanceOf(treasury.address);
      await escrow.connect(user).initiateBranch(1, 2);
      expect(await mockToken.balanceOf(treasury.address)).to.equal(
        initialTreasuryBalance + BRANCH_FEE,
      );
      expect(await mockAgent.lastOriginalConversationId()).to.equal(1);
    });
  });

  describe("Initiation Failure Scenarios", function () {
    it("should revert if user has no active subscription", async function () {
      const { escrow, user } = await loadFixture(deployEscrowFixture);
      await expect(
        escrow.connect(user).initiatePrompt(0, "0x", "0x"),
      ).to.be.revertedWithCustomError(escrow, "NoActiveSubscription");
    });

    it("should revert if subscription is expired", async function () {
      const { escrow, user } = await loadFixture(deployEscrowFixture);
      await escrow.connect(user).setSubscription(INITIAL_ALLOWANCE, (await time.latest()) + 3600);
      await time.increase(3601);

      await expect(
        escrow.connect(user).initiatePrompt(0, "0x", "0x"),
      ).to.be.revertedWithCustomError(escrow, "SubscriptionExpired");
    });

    it("should revert if subscription allowance is insufficient", async function () {
      const { escrow, user } = await loadFixture(deployEscrowFixture);
      const lowAllowance = PROMPT_FEE - 1n;
      await escrow.connect(user).setSubscription(lowAllowance, (await time.latest()) + 3600);

      await expect(
        escrow.connect(user).initiatePrompt(0, "0x", "0x"),
      ).to.be.revertedWithCustomError(escrow, "InsufficientSubscriptionAllowance");
    });
  });

  describe("Cancellation and Refund Flows", function () {
    let escrow, mockAgent, mockToken, user, unauthorizedUser;
    const answerMessageId = 1;

    beforeEach(async function () {
      const fixtures = await loadFixture(deployEscrowFixture);
      ({ escrow, mockAgent, mockToken, user, unauthorizedUser } = fixtures);
      await escrow.connect(user).setSubscription(INITIAL_ALLOWANCE, (await time.latest()) + 7200);
      await escrow.connect(user).initiatePrompt(0, "0x", "0x");
    });

    it("should allow a user to cancel a prompt", async function () {
      await time.increase(5);
      const initialUserBalance = await mockToken.balanceOf(user.address);
      await expect(escrow.connect(user).cancelPrompt(answerMessageId))
        .to.emit(escrow, "PromptCancelled")
        .withArgs(answerMessageId, user.address);
      const expectedUserBalance = initialUserBalance + PROMPT_FEE - CANCELLATION_FEE;
      expect(await mockToken.balanceOf(user.address)).to.equal(expectedUserBalance);
    });

    it("should allow a keeper to process a refund", async function () {
      await time.increase(3601);
      const initialUserBalance = await mockToken.balanceOf(user.address);
      await expect(escrow.processRefund(answerMessageId))
        .to.emit(escrow, "PaymentRefunded")
        .withArgs(answerMessageId);
      expect(await mockToken.balanceOf(user.address)).to.equal(initialUserBalance + PROMPT_FEE);
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

    // Test for insufficient funds for cancellation fee
    it("should revert cancelPrompt if user cannot afford the cancellation fee", async function () {
      // Set up a user with just enough allowance for the prompt, but not the cancellation fee
      const { escrow, user, mockToken } = await loadFixture(deployEscrowFixture);
      await mockToken.connect(user).approve(await escrow.getAddress(), PROMPT_FEE);
      await escrow.connect(user).setSubscription(PROMPT_FEE, (await time.latest()) + 7200);
      await escrow.connect(user).initiatePrompt(0, "0x", "0x");

      await time.increase(5);
      await expect(escrow.connect(user).cancelPrompt(1)).to.be.revertedWithCustomError(
        escrow,
        "InsufficientSubscriptionAllowance",
      );
    });

    context("Refund Failure Paths", function () {
      it("should silently return if processRefund is called for a non-existent escrow", async function () {
        const { escrow } = await loadFixture(deployEscrowFixture);
        const nonExistentId = 999;
        await expect(escrow.processRefund(nonExistentId)).to.not.be.reverted;
      });

      it("should revert if processRefund is called on an already completed escrow", async function () {
        const agentSigner = await ethers.getImpersonatedSigner(await mockAgent.getAddress());
        await ethers.provider.send("hardhat_setBalance", [
          agentSigner.address,
          "0x1000000000000000000",
        ]);

        // Finalize the escrow that was created in the beforeEach hook.
        await escrow.connect(agentSigner).finalizePayment(answerMessageId);

        // Now, fast-forward time and try to refund the COMPLETED escrow.
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
      const { escrow, mockAgent, mockToken, user, treasury } =
        await loadFixture(deployEscrowFixture);
      await escrow.connect(user).setSubscription(INITIAL_ALLOWANCE, (await time.latest()) + 3600);
      await escrow.connect(user).initiatePrompt(0, "0x", "0x");
      const answerMessageId = 1;

      const agentSigner = await ethers.getImpersonatedSigner(await mockAgent.getAddress());
      await ethers.provider.send("hardhat_setBalance", [
        agentSigner.address,
        "0x1000000000000000000",
      ]);

      await expect(escrow.connect(agentSigner).finalizePayment(answerMessageId))
        .to.emit(escrow, "PaymentFinalized")
        .withArgs(answerMessageId);
      expect(await mockToken.balanceOf(treasury.address)).to.equal(PROMPT_FEE);
      expect(await mockToken.balanceOf(await escrow.getAddress())).to.equal(0);
    });

    context("Access Control", function () {
      it("should revert if a non-agent address calls finalizePayment", async function () {
        const { escrow, user } = await loadFixture(deployEscrowFixture);
        await expect(escrow.connect(user).finalizePayment(0)).to.be.revertedWithCustomError(
          escrow,
          "NotEVMAIAgent",
        );
      });

      it("should revert if a non-oracle calls initiateAgentJob", async function () {
        const { escrow, user } = await loadFixture(deployEscrowFixture);
        await expect(
          escrow.connect(user).initiateAgentJob(user.address, 0, "0x", "0x"),
        ).to.be.revertedWithCustomError(escrow, "NotOracle");
      });
    });

    context("State Guard Reverts", function () {
      let escrow, mockAgent, user, agentSigner;
      const escrowId = 1;

      beforeEach(async function () {
        const fixtures = await loadFixture(deployEscrowFixture);
        ({ escrow, mockAgent, user } = fixtures);
        await escrow.connect(user).setSubscription(INITIAL_ALLOWANCE, (await time.latest()) + 7200);
        await escrow.connect(user).initiatePrompt(0, "0x", "0x");

        agentSigner = await ethers.getImpersonatedSigner(await mockAgent.getAddress());
        await ethers.provider.send("hardhat_setBalance", [
          agentSigner.address,
          "0x1000000000000000000",
        ]);
        // Finalize the escrow to test non-pending states
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

      it("should revert if refunding a completed escrow", async function () {
        await time.increase(3601);
        await expect(escrow.processRefund(escrowId)).to.be.revertedWithCustomError(
          escrow,
          "EscrowNotPending",
        );
      });
    });
  });

  // Add full test block for upgradeability
  describe("Upgrades", function () {
    it("should allow the owner to upgrade the contract", async function () {
      const { escrow, deployer } = await loadFixture(deployEscrowFixture);
      const V2Factory = await ethers.getContractFactory("EVMAIAgentEscrowV2");
      const upgraded = await upgrades.upgradeProxy(await escrow.getAddress(), V2Factory, {
        signer: deployer,
      });
      expect(await upgraded.version()).to.equal("2.0");
    });

    it("should prevent a non-owner from upgrading the contract", async function () {
      const { escrow, unauthorizedUser } = await loadFixture(deployEscrowFixture);
      const V2Factory = await ethers.getContractFactory("EVMAIAgentEscrowV2", unauthorizedUser);
      await expect(
        upgrades.upgradeProxy(await escrow.getAddress(), V2Factory),
      ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
    });
  });
});
