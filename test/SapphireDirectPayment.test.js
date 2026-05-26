const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("SapphireAIAgentEscrow — _processDirectPayment Coverage", function () {
  const INITIAL_DEPOSIT = ethers.parseEther("100");
  const PROMPT_FEE = ethers.parseEther("10");
  const CANCELLATION_FEE = ethers.parseEther("1");
  const METADATA_FEE = ethers.parseEther("0.5");
  const BRANCH_FEE = ethers.parseEther("2");
  const MOCK_PAYLOAD = "Confidential payload for test.";

  async function deployFixture() {
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

    return { escrow, mockAgent, deployer, user, oracle, treasury, unauthorizedUser };
  }

  describe("initiateMetadataUpdate failures via _processDirectPayment", function () {
    it("should revert with NoActiveSpendingLimit when user has no limit set", async function () {
      const { escrow, unauthorizedUser } = await loadFixture(deployFixture);
      await expect(
        escrow.connect(unauthorizedUser).initiateMetadataUpdate(1, MOCK_PAYLOAD),
      ).to.be.revertedWithCustomError(escrow, "NoActiveSpendingLimit");
    });

    it("should revert with SpendingLimitExpired when limit has expired", async function () {
      const { escrow, user } = await loadFixture(deployFixture);
      await escrow.connect(user).setSpendingLimit((await time.latest()) + 3600);
      await time.increase(3601);
      await expect(
        escrow.connect(user).initiateMetadataUpdate(1, MOCK_PAYLOAD),
      ).to.be.revertedWithCustomError(escrow, "SpendingLimitExpired");
    });

    it("should revert with InsufficientDeposit when user has no deposit", async function () {
      const { escrow, unauthorizedUser } = await loadFixture(deployFixture);
      await escrow.connect(unauthorizedUser).setSpendingLimit((await time.latest()) + 3600);
      await expect(
        escrow.connect(unauthorizedUser).initiateMetadataUpdate(1, MOCK_PAYLOAD),
      ).to.be.revertedWithCustomError(escrow, "InsufficientDeposit");
    });
  });

  describe("initiateBranch failures via _processDirectPayment", function () {
    it("should revert with NoActiveSpendingLimit when user has no limit set", async function () {
      const { escrow, unauthorizedUser } = await loadFixture(deployFixture);
      await expect(
        escrow.connect(unauthorizedUser).initiateBranch(1, 2, MOCK_PAYLOAD),
      ).to.be.revertedWithCustomError(escrow, "NoActiveSpendingLimit");
    });

    it("should revert with SpendingLimitExpired when limit has expired", async function () {
      const { escrow, user } = await loadFixture(deployFixture);
      await escrow.connect(user).setSpendingLimit((await time.latest()) + 3600);
      await time.increase(3601);
      await expect(
        escrow.connect(user).initiateBranch(1, 2, MOCK_PAYLOAD),
      ).to.be.revertedWithCustomError(escrow, "SpendingLimitExpired");
    });

    it("should revert with InsufficientDeposit when user has no deposit", async function () {
      const { escrow, unauthorizedUser } = await loadFixture(deployFixture);
      await escrow.connect(unauthorizedUser).setSpendingLimit((await time.latest()) + 3600);
      await expect(
        escrow.connect(unauthorizedUser).initiateBranch(1, 2, MOCK_PAYLOAD),
      ).to.be.revertedWithCustomError(escrow, "InsufficientDeposit");
    });
  });

  describe("Cross-state security", function () {
    it("cancelled prompt cannot be finalized", async function () {
      const { escrow, mockAgent, user } = await loadFixture(deployFixture);
      await escrow.connect(user).setSpendingLimit((await time.latest()) + 7200);
      await escrow.connect(user).initiatePrompt(0, MOCK_PAYLOAD);
      const answerMessageId = 1;

      await time.increase(5);
      await escrow.connect(user).cancelPrompt(answerMessageId);

      const agentSigner = await ethers.getImpersonatedSigner(await mockAgent.getAddress());
      await ethers.provider.send("hardhat_setBalance", [
        agentSigner.address,
        "0x" + (10n ** 18n).toString(16),
      ]);
      await expect(
        escrow.connect(agentSigner).finalizePayment(answerMessageId),
      ).to.be.revertedWithCustomError(escrow, "EscrowNotPending");
    });

    it("cancelled prompt cannot be refunded", async function () {
      const { escrow, user } = await loadFixture(deployFixture);
      await escrow.connect(user).setSpendingLimit((await time.latest()) + 7200);
      await escrow.connect(user).initiatePrompt(0, MOCK_PAYLOAD);
      const answerMessageId = 1;

      await time.increase(5);
      await escrow.connect(user).cancelPrompt(answerMessageId);

      await time.increase(3601);
      await expect(escrow.processRefund(answerMessageId)).to.be.revertedWithCustomError(
        escrow,
        "EscrowNotPending",
      );
    });

    it("finalized prompt cannot be cancelled", async function () {
      const { escrow, mockAgent, user } = await loadFixture(deployFixture);
      await escrow.connect(user).setSpendingLimit((await time.latest()) + 7200);
      await escrow.connect(user).initiatePrompt(0, MOCK_PAYLOAD);
      const answerMessageId = 1;

      const agentSigner = await ethers.getImpersonatedSigner(await mockAgent.getAddress());
      await ethers.provider.send("hardhat_setBalance", [
        agentSigner.address,
        "0x" + (10n ** 18n).toString(16),
      ]);
      await escrow.connect(agentSigner).finalizePayment(answerMessageId);

      await time.increase(5);
      await expect(
        escrow.connect(user).cancelPrompt(answerMessageId),
      ).to.be.revertedWithCustomError(escrow, "EscrowNotPending");
    });
  });

  describe("Deposit accounting integrity", function () {
    it("deposit balance is correct after prompt→cancel→prompt→finalize cycle", async function () {
      const { escrow, mockAgent, user } = await loadFixture(deployFixture);
      await escrow.connect(user).setSpendingLimit((await time.latest()) + 7200);

      await escrow.connect(user).initiatePrompt(0, MOCK_PAYLOAD);
      const firstAnswerId = 1;
      expect(await escrow.deposits(user.address)).to.equal(INITIAL_DEPOSIT - PROMPT_FEE);

      await time.increase(5);
      await escrow.connect(user).cancelPrompt(firstAnswerId);
      expect(await escrow.deposits(user.address)).to.equal(
        INITIAL_DEPOSIT - CANCELLATION_FEE,
      );

      await escrow.connect(user).initiatePrompt(0, MOCK_PAYLOAD);
      const secondAnswerId = 3;
      expect(await escrow.deposits(user.address)).to.equal(
        INITIAL_DEPOSIT - CANCELLATION_FEE - PROMPT_FEE,
      );

      const agentSigner = await ethers.getImpersonatedSigner(await mockAgent.getAddress());
      await ethers.provider.send("hardhat_setBalance", [
        agentSigner.address,
        "0x" + (10n ** 18n).toString(16),
      ]);
      await escrow.connect(agentSigner).finalizePayment(secondAnswerId);

      expect(await escrow.pendingEscrowCount(user.address)).to.equal(0);
    });
  });
});
