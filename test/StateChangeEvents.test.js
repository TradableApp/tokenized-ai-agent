const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

/**
 * Every state change a contract makes is visible in that contract's own logs.
 *
 * Three places changed state silently: the direct-to-treasury payment behind a branch or a
 * metadata update (tokens moved and the spending counter rose with no escrow event, so an indexer
 * had to infer the fee from FeeConfig), the oracle address set at agent deployment, and the fee
 * and treasury configuration set in the Sapphire escrow's constructor. The EVM escrow's
 * `initialize` already emitted its configuration; these tests hold the other paths to the same
 * rule. What a timeout refund records on the agent, on both chains, is in
 * RefundFinalization.test.js; the mock-level wiring of the Sapphire escrow stays here.
 */
describe("State changes are announced by the contract that makes them", function () {
  const ALLOWANCE = ethers.parseEther("100");
  const PROMPT_FEE = ethers.parseEther("10");
  const CANCELLATION_FEE = ethers.parseEther("1");
  const METADATA_FEE = ethers.parseEther("0.5");
  const BRANCH_FEE = ethers.parseEther("2");
  const ROFL_APP_ID = ethers.zeroPadBytes("0x00", 21);

  describe("EVM", function () {
    async function evmEscrowFixture() {
      const [deployer, user, oracle, treasury] = await ethers.getSigners();
      const mockAgent = await (
        await ethers.getContractFactory("MockEVMAIAgent")
      ).deploy(oracle.address);
      await mockAgent.waitForDeployment();
      const token = await (await ethers.getContractFactory("MockAbleToken")).deploy();
      await token.waitForDeployment();
      await token.mint(user.address, ALLOWANCE);
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
      await token.connect(user).approve(await escrow.getAddress(), ALLOWANCE);
      await escrow.connect(user).setSpendingLimit(ALLOWANCE, (await time.latest()) + 7200);
      return { escrow, user };
    }

    it("a branch emits DirectPaymentProcessed(user, branchFee) from the escrow", async function () {
      const { escrow, user } = await loadFixture(evmEscrowFixture);
      await expect(escrow.connect(user).initiateBranch(123, 456, "0x1234", "0x5678"))
        .to.emit(escrow, "DirectPaymentProcessed")
        .withArgs(user.address, BRANCH_FEE);
    });

    it("a metadata update emits DirectPaymentProcessed(user, metadataUpdateFee)", async function () {
      const { escrow, user } = await loadFixture(evmEscrowFixture);
      await expect(escrow.connect(user).initiateMetadataUpdate(1, "0x1234", "0x5678"))
        .to.emit(escrow, "DirectPaymentProcessed")
        .withArgs(user.address, METADATA_FEE);
    });

    it("the agent announces its initial oracle at initialization", async function () {
      const [deployer, , oracle] = await ethers.getSigners();
      const aiAgent = await upgrades.deployProxy(
        await ethers.getContractFactory("EVMAIAgent"),
        ["example.com", oracle.address, deployer.address],
        { initializer: "initialize", kind: "uups" },
      );
      await aiAgent.waitForDeployment();
      await expect(aiAgent.deploymentTransaction())
        .to.emit(aiAgent, "RoleGranted")
        .withArgs(ethers.id("ORACLE_ROLE"), oracle.address, deployer.address);
    });
  });

  describe("Sapphire", function () {
    async function sapphireEscrowFixture() {
      const [deployer, user, oracle, treasury] = await ethers.getSigners();
      const mockAgent = await (
        await ethers.getContractFactory("MockSapphireAIAgent")
      ).deploy(oracle.address);
      await mockAgent.waitForDeployment();
      const escrow = await (
        await ethers.getContractFactory("SapphireAIAgentEscrow")
      ).deploy(
        await mockAgent.getAddress(),
        treasury.address,
        deployer.address,
        PROMPT_FEE,
        CANCELLATION_FEE,
        METADATA_FEE,
        BRANCH_FEE,
      );
      await escrow.waitForDeployment();
      await escrow.connect(user).deposit({ value: ALLOWANCE });
      await escrow.connect(user).setSpendingLimit((await time.latest()) + 7200);
      return { escrow, mockAgent, user, treasury };
    }

    async function initiatePromptAndPassTimeout(escrow, user) {
      const receipt = await (await escrow.connect(user).initiatePrompt(0, "payload")).wait();
      const topic = escrow.interface.getEvent("PaymentEscrowed").topicHash;
      const escrowId = escrow.interface.parseLog(receipt.logs.find((l) => l.topics[0] === topic))
        .args[0];
      await time.increase(Number(await escrow.REFUND_TIMEOUT()) + 1);
      return escrowId;
    }

    it("the escrow announces its fees and treasury at construction", async function () {
      const { escrow, treasury } = await loadFixture(sapphireEscrowFixture);
      const deployTx = escrow.deploymentTransaction();
      await expect(deployTx).to.emit(escrow, "PromptFeeUpdated").withArgs(PROMPT_FEE);
      await expect(deployTx).to.emit(escrow, "CancellationFeeUpdated").withArgs(CANCELLATION_FEE);
      await expect(deployTx).to.emit(escrow, "MetadataUpdateFeeUpdated").withArgs(METADATA_FEE);
      await expect(deployTx).to.emit(escrow, "BranchFeeUpdated").withArgs(BRANCH_FEE);
      await expect(deployTx).to.emit(escrow, "TreasuryUpdated").withArgs(treasury.address);
    });

    it("a branch emits DirectPaymentProcessed(user, branchFee) from the escrow", async function () {
      const { escrow, user } = await loadFixture(sapphireEscrowFixture);
      await expect(escrow.connect(user).initiateBranch(456, 789, "payload"))
        .to.emit(escrow, "DirectPaymentProcessed")
        .withArgs(user.address, BRANCH_FEE);
    });

    it("a metadata update emits DirectPaymentProcessed(user, metadataUpdateFee)", async function () {
      const { escrow, user } = await loadFixture(sapphireEscrowFixture);
      await expect(escrow.connect(user).initiateMetadataUpdate(123, "payload"))
        .to.emit(escrow, "DirectPaymentProcessed")
        .withArgs(user.address, METADATA_FEE);
    });

    it("a timeout refund is recorded on the agent", async function () {
      const { escrow, mockAgent, user } = await loadFixture(sapphireEscrowFixture);
      const escrowId = await initiatePromptAndPassTimeout(escrow, user);
      await expect(escrow.processRefund(escrowId))
        .to.emit(mockAgent, "RefundRecorded")
        .withArgs(user.address, escrowId);
    });

    it("a failing agent costs the record, not the refund: RefundRecordFailed, deposit restored", async function () {
      const { escrow, mockAgent, user } = await loadFixture(sapphireEscrowFixture);
      const escrowId = await initiatePromptAndPassTimeout(escrow, user);
      await mockAgent.setRecordRefundReverts(true);

      const refund = escrow.processRefund(escrowId);

      await expect(refund).to.emit(escrow, "RefundRecordFailed").withArgs(escrowId);
      await expect(refund).to.emit(escrow, "PaymentRefunded").withArgs(escrowId);
      expect(await escrow.deposits(user.address)).to.equal(ALLOWANCE);
    });

    it("a failed refund record can be completed later, with no change to the deposit", async function () {
      const { escrow, mockAgent, user } = await loadFixture(sapphireEscrowFixture);
      const escrowId = await initiatePromptAndPassTimeout(escrow, user);
      await mockAgent.setRecordRefundReverts(true);
      await escrow.processRefund(escrowId);
      await mockAgent.setRecordRefundReverts(false);

      const retry = escrow.retryRefundRecord(escrowId);

      await expect(retry).to.emit(mockAgent, "RefundRecorded").withArgs(user.address, escrowId);
      await expect(retry).to.emit(escrow, "RefundRecordRetried").withArgs(escrowId);
      expect(await escrow.deposits(user.address)).to.equal(ALLOWANCE);
    });

    it("a retry reverts while the agent still cannot take the call, and works once it can", async function () {
      const { escrow, mockAgent, user } = await loadFixture(sapphireEscrowFixture);
      const escrowId = await initiatePromptAndPassTimeout(escrow, user);
      await mockAgent.setRecordRefundReverts(true);
      await escrow.processRefund(escrowId);

      await expect(escrow.retryRefundRecord(escrowId)).to.be.revertedWith(
        "MockAIAgent: recordRefund reverts",
      );

      await mockAgent.setRecordRefundReverts(false);
      await expect(escrow.retryRefundRecord(escrowId))
        .to.emit(mockAgent, "RefundRecorded")
        .withArgs(user.address, escrowId);
    });

    it("a refund record cannot be retried for an escrow that is still pending", async function () {
      const { escrow, user } = await loadFixture(sapphireEscrowFixture);
      const escrowId = await initiatePromptAndPassTimeout(escrow, user);
      await expect(escrow.retryRefundRecord(escrowId)).to.be.revertedWithCustomError(
        escrow,
        "EscrowNotRefunded",
      );
    });

    it("a refund record cannot be retried for an escrow that does not exist", async function () {
      const { escrow } = await loadFixture(sapphireEscrowFixture);
      await expect(escrow.retryRefundRecord(4242)).to.be.revertedWithCustomError(
        escrow,
        "EscrowNotRefunded",
      );
    });

    it("the agent announces its initial oracle at construction", async function () {
      const [deployer, , oracle] = await ethers.getSigners();
      const aiAgent = await (
        await ethers.getContractFactory("SapphireAIAgent")
      ).deploy("example.com", ROFL_APP_ID, oracle.address, deployer.address);
      await aiAgent.waitForDeployment();
      await expect(aiAgent.deploymentTransaction())
        .to.emit(aiAgent, "RoleGranted")
        .withArgs(ethers.id("ORACLE_ROLE"), oracle.address, deployer.address);
    });

    it("recordRefund on the agent sets the flag, emits PromptRefunded, and is a no-op the second time", async function () {
      const [deployer, user, oracle] = await ethers.getSigners();
      const aiAgent = await (
        await ethers.getContractFactory("SapphireAIAgent")
      ).deploy("example.com", ROFL_APP_ID, oracle.address, deployer.address);
      await aiAgent.waitForDeployment();
      const mockEscrow = await (
        await ethers.getContractFactory("MockSapphireAIAgentEscrow")
      ).deploy(await aiAgent.getAddress());
      await mockEscrow.waitForDeployment();
      await aiAgent.connect(deployer).setAgentEscrow(await mockEscrow.getAddress());

      await expect(mockEscrow.callRecordRefund(user.address, 7))
        .to.emit(aiAgent, "PromptRefunded")
        .withArgs(user.address, 7);
      expect(await aiAgent.isJobFinalized(7)).to.equal(true);
      const second = mockEscrow.callRecordRefund(user.address, 7);
      await expect(second).to.not.be.reverted;
      await expect(second).to.not.emit(aiAgent, "PromptRefunded");
    });
  });
});
