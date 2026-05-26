const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("EVMAIAgentEscrow — Security Edge Cases", function () {
  const INITIAL_ALLOWANCE = ethers.parseEther("100");
  const PROMPT_FEE = ethers.parseEther("10");
  const CANCELLATION_FEE = ethers.parseEther("1");
  const METADATA_FEE = ethers.parseEther("0.5");
  const BRANCH_FEE = ethers.parseEther("2");
  const MOCK_ENCRYPTED_PAYLOAD = "0x1234";
  const MOCK_ROFL_KEY = "0x5678";

  async function deployFixture() {
    const [deployer, user, oracle, treasury, unauthorizedUser] = await ethers.getSigners();

    const MockAgentFactory = await ethers.getContractFactory("MockEVMAIAgent");
    const mockAgent = await MockAgentFactory.deploy(oracle.address);
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

    return { escrow, mockAgent, mockToken, deployer, user, oracle, treasury, unauthorizedUser };
  }

  describe("Cross-state: cancelled prompt cannot be answered or refunded", function () {
    it("finalizePayment reverts after cancelPrompt", async function () {
      const { escrow, mockAgent, user } = await loadFixture(deployFixture);
      await escrow.connect(user).setSpendingLimit(INITIAL_ALLOWANCE, (await time.latest()) + 7200);
      await escrow.connect(user).initiatePrompt(0, MOCK_ENCRYPTED_PAYLOAD, MOCK_ROFL_KEY);
      const answerMessageId = 1;

      await time.increase(5);
      await escrow.connect(user).cancelPrompt(answerMessageId);

      const agentSigner = await ethers.getImpersonatedSigner(await mockAgent.getAddress());
      await ethers.provider.send("hardhat_setBalance", [
        agentSigner.address,
        "0x1000000000000000000",
      ]);
      await expect(
        escrow.connect(agentSigner).finalizePayment(answerMessageId),
      ).to.be.revertedWithCustomError(escrow, "EscrowNotPending");
    });

    it("processRefund reverts after cancelPrompt", async function () {
      const { escrow, user } = await loadFixture(deployFixture);
      await escrow.connect(user).setSpendingLimit(INITIAL_ALLOWANCE, (await time.latest()) + 7200);
      await escrow.connect(user).initiatePrompt(0, MOCK_ENCRYPTED_PAYLOAD, MOCK_ROFL_KEY);
      const answerMessageId = 1;

      await time.increase(5);
      await escrow.connect(user).cancelPrompt(answerMessageId);

      await time.increase(3601);
      await expect(escrow.processRefund(answerMessageId)).to.be.revertedWithCustomError(
        escrow,
        "EscrowNotPending",
      );
    });
  });

  describe("Cross-state: answered prompt cannot be cancelled or refunded", function () {
    it("cancelPrompt reverts after finalizePayment", async function () {
      const { escrow, mockAgent, user } = await loadFixture(deployFixture);
      await escrow.connect(user).setSpendingLimit(INITIAL_ALLOWANCE, (await time.latest()) + 7200);
      await escrow.connect(user).initiatePrompt(0, MOCK_ENCRYPTED_PAYLOAD, MOCK_ROFL_KEY);
      const answerMessageId = 1;

      const agentSigner = await ethers.getImpersonatedSigner(await mockAgent.getAddress());
      await ethers.provider.send("hardhat_setBalance", [
        agentSigner.address,
        "0x1000000000000000000",
      ]);
      await escrow.connect(agentSigner).finalizePayment(answerMessageId);

      await time.increase(5);
      await expect(
        escrow.connect(user).cancelPrompt(answerMessageId),
      ).to.be.revertedWithCustomError(escrow, "EscrowNotPending");
    });

    it("processRefund reverts after finalizePayment", async function () {
      const { escrow, mockAgent, user } = await loadFixture(deployFixture);
      await escrow.connect(user).setSpendingLimit(INITIAL_ALLOWANCE, (await time.latest()) + 7200);
      await escrow.connect(user).initiatePrompt(0, MOCK_ENCRYPTED_PAYLOAD, MOCK_ROFL_KEY);
      const answerMessageId = 1;

      const agentSigner = await ethers.getImpersonatedSigner(await mockAgent.getAddress());
      await ethers.provider.send("hardhat_setBalance", [
        agentSigner.address,
        "0x1000000000000000000",
      ]);
      await escrow.connect(agentSigner).finalizePayment(answerMessageId);

      await time.increase(3601);
      await expect(escrow.processRefund(answerMessageId)).to.be.revertedWithCustomError(
        escrow,
        "EscrowNotPending",
      );
    });
  });

  describe("Direct payment validation (_processDirectPayment paths)", function () {
    it("initiateMetadataUpdate reverts with NoActiveSpendingLimit", async function () {
      const { escrow, user } = await loadFixture(deployFixture);
      await expect(
        escrow.connect(user).initiateMetadataUpdate(1, MOCK_ENCRYPTED_PAYLOAD, MOCK_ROFL_KEY),
      ).to.be.revertedWithCustomError(escrow, "NoActiveSpendingLimit");
    });

    it("initiateMetadataUpdate reverts with SpendingLimitExpired", async function () {
      const { escrow, user } = await loadFixture(deployFixture);
      await escrow.connect(user).setSpendingLimit(INITIAL_ALLOWANCE, (await time.latest()) + 3600);
      await time.increase(3601);
      await expect(
        escrow.connect(user).initiateMetadataUpdate(1, MOCK_ENCRYPTED_PAYLOAD, MOCK_ROFL_KEY),
      ).to.be.revertedWithCustomError(escrow, "SpendingLimitExpired");
    });

    it("initiateMetadataUpdate reverts with InsufficientSpendingLimitAllowance", async function () {
      const { escrow, user } = await loadFixture(deployFixture);
      const tinyAllowance = METADATA_FEE - 1n;
      await escrow.connect(user).setSpendingLimit(tinyAllowance, (await time.latest()) + 3600);
      await expect(
        escrow.connect(user).initiateMetadataUpdate(1, MOCK_ENCRYPTED_PAYLOAD, MOCK_ROFL_KEY),
      ).to.be.revertedWithCustomError(escrow, "InsufficientSpendingLimitAllowance");
    });

    it("initiateBranch reverts with NoActiveSpendingLimit", async function () {
      const { escrow, user } = await loadFixture(deployFixture);
      await expect(
        escrow.connect(user).initiateBranch(1, 2, MOCK_ENCRYPTED_PAYLOAD, MOCK_ROFL_KEY),
      ).to.be.revertedWithCustomError(escrow, "NoActiveSpendingLimit");
    });

    it("initiateBranch reverts with SpendingLimitExpired", async function () {
      const { escrow, user } = await loadFixture(deployFixture);
      await escrow.connect(user).setSpendingLimit(INITIAL_ALLOWANCE, (await time.latest()) + 3600);
      await time.increase(3601);
      await expect(
        escrow.connect(user).initiateBranch(1, 2, MOCK_ENCRYPTED_PAYLOAD, MOCK_ROFL_KEY),
      ).to.be.revertedWithCustomError(escrow, "SpendingLimitExpired");
    });

    it("initiateBranch reverts with InsufficientSpendingLimitAllowance", async function () {
      const { escrow, user } = await loadFixture(deployFixture);
      const tinyAllowance = BRANCH_FEE - 1n;
      await escrow.connect(user).setSpendingLimit(tinyAllowance, (await time.latest()) + 3600);
      await expect(
        escrow.connect(user).initiateBranch(1, 2, MOCK_ENCRYPTED_PAYLOAD, MOCK_ROFL_KEY),
      ).to.be.revertedWithCustomError(escrow, "InsufficientSpendingLimitAllowance");
    });
  });

  describe("Double-spend prevention", function () {
    it("second prompt reverts when spent + fee exceeds allowance", async function () {
      const { escrow, user } = await loadFixture(deployFixture);
      const exactAllowance = PROMPT_FEE + PROMPT_FEE - 1n;
      await escrow.connect(user).setSpendingLimit(exactAllowance, (await time.latest()) + 3600);
      await escrow.connect(user).initiatePrompt(0, MOCK_ENCRYPTED_PAYLOAD, MOCK_ROFL_KEY);

      await expect(
        escrow.connect(user).initiatePrompt(0, MOCK_ENCRYPTED_PAYLOAD, MOCK_ROFL_KEY),
      ).to.be.revertedWithCustomError(escrow, "InsufficientSpendingLimitAllowance");
    });

    it("exact-boundary allowance allows both prompts", async function () {
      const { escrow, user } = await loadFixture(deployFixture);
      const exactAllowance = PROMPT_FEE * 2n;
      await escrow.connect(user).setSpendingLimit(exactAllowance, (await time.latest()) + 3600);
      await escrow.connect(user).initiatePrompt(0, MOCK_ENCRYPTED_PAYLOAD, MOCK_ROFL_KEY);
      await expect(
        escrow.connect(user).initiatePrompt(0, MOCK_ENCRYPTED_PAYLOAD, MOCK_ROFL_KEY),
      ).to.not.be.reverted;
    });
  });

  describe("Balance accounting after partial operations", function () {
    it("token balances correct after initiate→cancel→initiate→finalize", async function () {
      const { escrow, mockAgent, mockToken, user, treasury } = await loadFixture(deployFixture);
      await escrow.connect(user).setSpendingLimit(INITIAL_ALLOWANCE, (await time.latest()) + 7200);

      const escrowAddr = await escrow.getAddress();
      const userStartBalance = await mockToken.balanceOf(user.address);

      await escrow.connect(user).initiatePrompt(0, MOCK_ENCRYPTED_PAYLOAD, MOCK_ROFL_KEY);
      const firstAnswerId = 1;
      expect(await mockToken.balanceOf(escrowAddr)).to.equal(PROMPT_FEE);

      await time.increase(5);
      await escrow.connect(user).cancelPrompt(firstAnswerId);
      expect(await mockToken.balanceOf(escrowAddr)).to.equal(0);
      expect(await mockToken.balanceOf(user.address)).to.equal(
        userStartBalance - CANCELLATION_FEE,
      );

      await escrow.connect(user).initiatePrompt(0, MOCK_ENCRYPTED_PAYLOAD, MOCK_ROFL_KEY);
      const secondAnswerId = 3;
      expect(await mockToken.balanceOf(escrowAddr)).to.equal(PROMPT_FEE);

      const agentSigner = await ethers.getImpersonatedSigner(await mockAgent.getAddress());
      await ethers.provider.send("hardhat_setBalance", [
        agentSigner.address,
        "0x1000000000000000000",
      ]);
      await escrow.connect(agentSigner).finalizePayment(secondAnswerId);

      expect(await mockToken.balanceOf(escrowAddr)).to.equal(0);
      expect(await mockToken.balanceOf(treasury.address)).to.equal(
        CANCELLATION_FEE + PROMPT_FEE,
      );
      expect(await mockToken.balanceOf(user.address)).to.equal(
        userStartBalance - CANCELLATION_FEE - PROMPT_FEE,
      );
      expect(await escrow.pendingEscrowCount(user.address)).to.equal(0);
    });

    it("multiple prompts: one cancel one finalize leaves zero pending", async function () {
      const { escrow, mockAgent, user } = await loadFixture(deployFixture);
      await escrow.connect(user).setSpendingLimit(INITIAL_ALLOWANCE, (await time.latest()) + 7200);

      await escrow.connect(user).initiatePrompt(0, MOCK_ENCRYPTED_PAYLOAD, MOCK_ROFL_KEY);
      await escrow.connect(user).initiatePrompt(0, MOCK_ENCRYPTED_PAYLOAD, MOCK_ROFL_KEY);
      expect(await escrow.pendingEscrowCount(user.address)).to.equal(2);

      await time.increase(5);
      await escrow.connect(user).cancelPrompt(1);
      expect(await escrow.pendingEscrowCount(user.address)).to.equal(1);

      const agentSigner = await ethers.getImpersonatedSigner(await mockAgent.getAddress());
      await ethers.provider.send("hardhat_setBalance", [
        agentSigner.address,
        "0x1000000000000000000",
      ]);
      await escrow.connect(agentSigner).finalizePayment(3);
      expect(await escrow.pendingEscrowCount(user.address)).to.equal(0);
    });
  });

  describe("Treasury setter access control", function () {
    it("allows owner to update treasury address", async function () {
      const { escrow, deployer, unauthorizedUser } = await loadFixture(deployFixture);
      await expect(escrow.connect(deployer).setTreasury(unauthorizedUser.address))
        .to.emit(escrow, "TreasuryUpdated")
        .withArgs(unauthorizedUser.address);
      expect(await escrow.treasury()).to.equal(unauthorizedUser.address);
    });

    it("prevents non-owner from updating treasury", async function () {
      const { escrow, unauthorizedUser } = await loadFixture(deployFixture);
      await expect(
        escrow.connect(unauthorizedUser).setTreasury(unauthorizedUser.address),
      ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
    });
  });
});
