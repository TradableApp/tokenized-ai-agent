const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("EVMAIAgentEscrow (Upgradable)", function () {
  // --- Test Suite Setup ---
  const PROMPT_FEE = ethers.parseEther("1");
  const INITIAL_ALLOWANCE = ethers.parseEther("100");
  const MOCK_ENCRYPTED_DATA = "0x123456"; // Consistent mock data

  // Deploys contracts and sets up the test environment.
  // This fixture is used by `loadFixture` to speed up tests.
  async function deployEscrowFixture() {
    const [deployer, user, oracle, treasury, unauthorizedUser] = await ethers.getSigners();

    // 1. Deploy all mock dependencies.
    const MockAgentFactory = await ethers.getContractFactory("MockEVMAIAgent");
    const mockAgent = await MockAgentFactory.deploy();
    await mockAgent.waitForDeployment();

    const MockTokenFactory = await ethers.getContractFactory("MockAbleToken");
    const mockToken = await MockTokenFactory.deploy();
    await mockToken.waitForDeployment();

    // 2. Mint tokens for the user for testing.
    await mockToken.mint(user.address, INITIAL_ALLOWANCE);

    // 3. Deploy the main Escrow contract as a proxy, linking it to the mocks.
    const EVMAIAgentEscrow = await ethers.getContractFactory("EVMAIAgentEscrow");
    const escrow = await upgrades.deployProxy(
      EVMAIAgentEscrow,
      [
        await mockToken.getAddress(),
        await mockAgent.getAddress(),
        treasury.address,
        oracle.address,
        deployer.address, // owner
      ],
      { initializer: "initialize", kind: "uups" },
    );
    await escrow.waitForDeployment();

    // 4. Have the user approve the escrow contract to spend their tokens.
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
      EVMAIAgentEscrow, // Return factory for revert tests
    };
  }

  // --- Test Cases ---

  describe("Initialization", function () {
    it("should set the correct initial state and owner", async function () {
      const { escrow, mockAgent, mockToken, deployer, treasury, oracle } =
        await loadFixture(deployEscrowFixture);
      expect(await escrow.owner()).to.equal(deployer.address);
      expect(await escrow.treasury()).to.equal(treasury.address);
      expect(await escrow.oracle()).to.equal(oracle.address);
      expect(await escrow.evmAIAgent()).to.equal(await mockAgent.getAddress());
      expect(await escrow.ableToken()).to.equal(await mockToken.getAddress());
    });

    it("should revert if initialized with a zero address for the agent", async function () {
      const { EVMAIAgentEscrow, mockToken, treasury, oracle, deployer } =
        await loadFixture(deployEscrowFixture);
      await expect(
        upgrades.deployProxy(EVMAIAgentEscrow, [
          await mockToken.getAddress(),
          ethers.ZeroAddress, // Invalid agent
          treasury.address,
          oracle.address,
          deployer.address,
        ]),
      ).to.be.revertedWithCustomError(EVMAIAgentEscrow, "ZeroAddress");
    });

    it("should revert if initialized with a zero address for the token", async function () {
      const { EVMAIAgentEscrow, mockAgent, treasury, oracle, deployer } =
        await loadFixture(deployEscrowFixture);
      await expect(
        upgrades.deployProxy(EVMAIAgentEscrow, [
          ethers.ZeroAddress, // Invalid token
          await mockAgent.getAddress(),
          treasury.address,
          oracle.address,
          deployer.address,
        ]),
      ).to.be.revertedWithCustomError(EVMAIAgentEscrow, "ZeroAddress");
    });

    it("should revert if initialized with a zero address for the owner", async function () {
      const { EVMAIAgentEscrow, mockToken, mockAgent, treasury, oracle } =
        await loadFixture(deployEscrowFixture);
      // Because __Ownable_init runs first, we expect its specific error.
      await expect(
        upgrades.deployProxy(EVMAIAgentEscrow, [
          await mockToken.getAddress(),
          await mockAgent.getAddress(),
          treasury.address,
          oracle.address,
          ethers.ZeroAddress, // Invalid owner
        ]),
      ).to.be.revertedWithCustomError(EVMAIAgentEscrow, "OwnableInvalidOwner");
    });
  });

  describe("Administrative Functions", function () {
    it("should allow the owner to set a new treasury", async function () {
      const { escrow, deployer, unauthorizedUser } = await loadFixture(deployEscrowFixture);
      await escrow.connect(deployer).setTreasury(unauthorizedUser.address);
      expect(await escrow.treasury()).to.equal(unauthorizedUser.address);
    });

    it("should prevent a non-owner from setting a new treasury", async function () {
      const { escrow, user, unauthorizedUser } = await loadFixture(deployEscrowFixture);
      await expect(
        escrow.connect(user).setTreasury(unauthorizedUser.address),
      ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
    });

    it("should allow the owner to set a new oracle", async function () {
      const { escrow, deployer, unauthorizedUser } = await loadFixture(deployEscrowFixture);
      await escrow.connect(deployer).setOracle(unauthorizedUser.address);
      expect(await escrow.oracle()).to.equal(unauthorizedUser.address);
    });

    it("should prevent a non-owner from setting a new oracle", async function () {
      const { escrow, user, unauthorizedUser } = await loadFixture(deployEscrowFixture);
      await expect(
        escrow.connect(user).setOracle(unauthorizedUser.address),
      ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
    });

    it("should revert if owner tries to set treasury to the zero address", async function () {
      const { escrow, deployer } = await loadFixture(deployEscrowFixture);
      await expect(
        escrow.connect(deployer).setTreasury(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(escrow, "ZeroAddress");
    });

    it("should revert if owner tries to set oracle to the zero address", async function () {
      const { escrow, deployer } = await loadFixture(deployEscrowFixture);
      await expect(
        escrow.connect(deployer).setOracle(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(escrow, "ZeroAddress");
    });
  });

  describe("Subscription Management", function () {
    it("should allow a user to set and cancel a subscription", async function () {
      const { escrow, user } = await loadFixture(deployEscrowFixture);
      const expiresAt = (await time.latest()) + 3600;
      await expect(escrow.connect(user).setSubscription(INITIAL_ALLOWANCE, expiresAt))
        .to.emit(escrow, "SubscriptionSet")
        .withArgs(user.address, INITIAL_ALLOWANCE, expiresAt);

      let sub = await escrow.subscriptions(user.address);
      expect(sub.allowance).to.equal(INITIAL_ALLOWANCE);

      await expect(escrow.connect(user).cancelSubscription())
        .to.emit(escrow, "SubscriptionCancelled")
        .withArgs(user.address);

      sub = await escrow.subscriptions(user.address);
      expect(sub.allowance).to.equal(0);
    });

    it("should revert when setting a new subscription while a prompt is pending", async function () {
      const { escrow, user } = await loadFixture(deployEscrowFixture);
      await escrow.connect(user).setSubscription(INITIAL_ALLOWANCE, (await time.latest()) + 3600);
      await escrow
        .connect(user)
        .initiatePrompt(MOCK_ENCRYPTED_DATA, MOCK_ENCRYPTED_DATA, MOCK_ENCRYPTED_DATA);

      // Attempting to set a new subscription while one is pending must fail.
      await expect(
        escrow.connect(user).setSubscription(INITIAL_ALLOWANCE, (await time.latest()) + 7200),
      ).to.be.revertedWithCustomError(escrow, "HasPendingPrompts");
    });
  });

  describe("Prompt Initiation", function () {
    context("by a User (initiatePrompt)", function () {
      it("should successfully initiate, escrow funds, and call the agent", async function () {
        const { escrow, mockAgent, mockToken, user } = await loadFixture(deployEscrowFixture);
        await escrow.connect(user).setSubscription(INITIAL_ALLOWANCE, (await time.latest()) + 3600);
        const promptId = await mockAgent.promptIdCounter();
        await expect(
          escrow
            .connect(user)
            .initiatePrompt(MOCK_ENCRYPTED_DATA, MOCK_ENCRYPTED_DATA, MOCK_ENCRYPTED_DATA),
        )
          .to.emit(escrow, "PaymentEscrowed")
          .withArgs(promptId, user.address, PROMPT_FEE);

        expect(await mockToken.balanceOf(await escrow.getAddress())).to.equal(PROMPT_FEE);
        const sub = await escrow.subscriptions(user.address);
        expect(sub.spentAmount).to.equal(PROMPT_FEE);
      });
    });

    context("by the Oracle (initiateAgentJob)", function () {
      it("should successfully initiate on behalf of a user", async function () {
        const { escrow, user, oracle } = await loadFixture(deployEscrowFixture);
        await escrow.connect(user).setSubscription(INITIAL_ALLOWANCE, (await time.latest()) + 3600);
        await escrow
          .connect(oracle)
          .initiateAgentJob(
            user.address,
            MOCK_ENCRYPTED_DATA,
            MOCK_ENCRYPTED_DATA,
            MOCK_ENCRYPTED_DATA,
          );
        const sub = await escrow.subscriptions(user.address);
        expect(sub.spentAmount).to.equal(PROMPT_FEE);
      });

      it("should revert if called by a non-oracle", async function () {
        const { escrow, user } = await loadFixture(deployEscrowFixture);
        await escrow.connect(user).setSubscription(INITIAL_ALLOWANCE, (await time.latest()) + 3600);
        await expect(
          escrow
            .connect(user)
            .initiateAgentJob(
              user.address,
              MOCK_ENCRYPTED_DATA,
              MOCK_ENCRYPTED_DATA,
              MOCK_ENCRYPTED_DATA,
            ),
        ).to.be.revertedWithCustomError(escrow, "NotOracle");
      });
    });

    context("Failure Scenarios", function () {
      it("should revert if user has no active subscription", async function () {
        const { escrow, user } = await loadFixture(deployEscrowFixture);
        // Note: No call to setSubscription for this user
        await expect(
          escrow
            .connect(user)
            .initiatePrompt(MOCK_ENCRYPTED_DATA, MOCK_ENCRYPTED_DATA, MOCK_ENCRYPTED_DATA),
        ).to.be.revertedWithCustomError(escrow, "NoActiveSubscription");
      });

      it("should revert if subscription is expired", async function () {
        const { escrow, user } = await loadFixture(deployEscrowFixture);
        await escrow.connect(user).setSubscription(INITIAL_ALLOWANCE, (await time.latest()) + 3600);
        await time.increase(3601); // Expire the subscription

        await expect(
          escrow
            .connect(user)
            .initiatePrompt(MOCK_ENCRYPTED_DATA, MOCK_ENCRYPTED_DATA, MOCK_ENCRYPTED_DATA),
        ).to.be.revertedWithCustomError(escrow, "SubscriptionExpired");
      });

      it("should revert if subscription allowance is insufficient", async function () {
        const { escrow, user } = await loadFixture(deployEscrowFixture);
        const lowAllowance = PROMPT_FEE - 1n; // Set allowance lower than the fee
        await escrow.connect(user).setSubscription(lowAllowance, (await time.latest()) + 3600);

        await expect(
          escrow
            .connect(user)
            .initiatePrompt(MOCK_ENCRYPTED_DATA, MOCK_ENCRYPTED_DATA, MOCK_ENCRYPTED_DATA),
        ).to.be.revertedWithCustomError(escrow, "InsufficientSubscriptionAllowance");
      });
    });
  });

  describe("Payment Finalization and Refunds", function () {
    it("should allow the agent to finalize payment", async function () {
      const { escrow, mockAgent, mockToken, deployer, user, treasury } =
        await loadFixture(deployEscrowFixture);
      await escrow.connect(user).setSubscription(INITIAL_ALLOWANCE, (await time.latest()) + 3600);
      const promptId = await mockAgent.promptIdCounter();
      await escrow
        .connect(user)
        .initiatePrompt(MOCK_ENCRYPTED_DATA, MOCK_ENCRYPTED_DATA, MOCK_ENCRYPTED_DATA);

      const initialTreasuryBalance = await mockToken.balanceOf(treasury.address);
      // Simulate the agent calling back finalizePayment.
      await mockAgent.connect(deployer).callFinalizePayment(await escrow.getAddress(), promptId);
      expect(await mockToken.balanceOf(treasury.address)).to.equal(
        initialTreasuryBalance + PROMPT_FEE,
      );
      const escrowRecord = await escrow.escrows(promptId);
      expect(escrowRecord.status).to.equal(1); // Enum COMPLETE
    });

    it("should allow a timed-out prompt to be refunded", async function () {
      const { escrow, mockAgent, mockToken, deployer, user } =
        await loadFixture(deployEscrowFixture);
      await escrow.connect(user).setSubscription(INITIAL_ALLOWANCE, (await time.latest()) + 7200);
      const promptId = await mockAgent.promptIdCounter();
      await escrow
        .connect(user)
        .initiatePrompt(MOCK_ENCRYPTED_DATA, MOCK_ENCRYPTED_DATA, MOCK_ENCRYPTED_DATA);

      await time.increase(3601); // Increase time past the REFUND_TIMEOUT
      const initialUserBalance = await mockToken.balanceOf(user.address);
      await escrow.connect(deployer).processRefund(promptId);
      expect(await mockToken.balanceOf(user.address)).to.equal(initialUserBalance + PROMPT_FEE);
      const sub = await escrow.subscriptions(user.address);
      expect(sub.spentAmount).to.equal(0);
      const escrowRecord = await escrow.escrows(promptId);
      expect(escrowRecord.status).to.equal(2); // Enum REFUNDED
    });
  });

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
