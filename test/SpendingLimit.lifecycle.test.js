const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("Suite 3 — SpendingLimit Lifecycle", function () {
  const domain = "example.com";
  const INITIAL_ALLOWANCE = ethers.parseEther("100");
  const PROMPT_FEE = ethers.parseEther("10");
  const CANCELLATION_FEE = ethers.parseEther("1");
  const METADATA_FEE = ethers.parseEther("0.5");
  const BRANCH_FEE = ethers.parseEther("2");

  async function deployFixture() {
    const [deployer, user, oracle, treasury] = await ethers.getSigners();

    const MockTokenFactory = await ethers.getContractFactory("MockAbleToken");
    const token = await MockTokenFactory.deploy();
    await token.waitForDeployment();
    await token.mint(user.address, INITIAL_ALLOWANCE);

    const EVMAIAgent = await ethers.getContractFactory("EVMAIAgent");
    const aiAgent = await upgrades.deployProxy(
      EVMAIAgent,
      [domain, oracle.address, deployer.address],
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
    await token.connect(user).approve(await escrow.getAddress(), INITIAL_ALLOWANCE);

    return { aiAgent, escrow, token, deployer, user, oracle, treasury };
  }

  describe("SpendingLimit struct field order", function () {
    it("spendingLimits(user) returns fields in order: allowance, spentAmount, expiresAt", async function () {
      const { escrow, user } = await loadFixture(deployFixture);
      const expiresAt = (await time.latest()) + 3600;
      await escrow.connect(user).setSpendingLimit(INITIAL_ALLOWANCE, expiresAt);

      const limit = await escrow.spendingLimits(user.address);

      expect(limit.allowance).to.equal(INITIAL_ALLOWANCE, "field[0] allowance mismatch");
      expect(limit.spentAmount).to.equal(0n, "field[1] spentAmount should start at 0");
      expect(limit.expiresAt).to.equal(BigInt(expiresAt), "field[2] expiresAt mismatch");
    });
  });

  describe("setSpendingLimit events", function () {
    it("emits SpendingLimitSet(user, allowance, expiresAt) — all three indexed", async function () {
      const { escrow, user } = await loadFixture(deployFixture);
      const expiresAt = (await time.latest()) + 3600;

      await expect(escrow.connect(user).setSpendingLimit(INITIAL_ALLOWANCE, expiresAt))
        .to.emit(escrow, "SpendingLimitSet")
        .withArgs(user.address, INITIAL_ALLOWANCE, expiresAt);
    });

    it("SpendingLimitSet event inputs are all indexed", async function () {
      const { escrow } = await loadFixture(deployFixture);
      const fragment = escrow.interface.getEvent("SpendingLimitSet");

      expect(fragment.inputs).to.have.length(3);
      expect(fragment.inputs[0].name).to.equal("user");
      expect(fragment.inputs[0].indexed).to.be.true;
      expect(fragment.inputs[1].name).to.equal("allowance");
      expect(fragment.inputs[1].indexed).to.be.true;
      expect(fragment.inputs[2].name).to.equal("expiresAt");
      expect(fragment.inputs[2].indexed).to.be.true;
    });

    it("reverts with ZeroSpendingLimit when allowance is 0", async function () {
      const { escrow, user } = await loadFixture(deployFixture);
      const expiresAt = (await time.latest()) + 3600;

      await expect(
        escrow.connect(user).setSpendingLimit(0, expiresAt),
      ).to.be.revertedWithCustomError(escrow, "ZeroSpendingLimit");
    });

    it("reverts with ExpirationInThePast when expiresAt is 0", async function () {
      const { escrow, user } = await loadFixture(deployFixture);

      await expect(
        escrow.connect(user).setSpendingLimit(INITIAL_ALLOWANCE, 0),
      ).to.be.revertedWithCustomError(escrow, "ExpirationInThePast");
    });

    it("reverts with ExpirationInThePast when expiresAt <= block.timestamp", async function () {
      const { escrow, user } = await loadFixture(deployFixture);
      const now = await time.latest();

      await expect(
        escrow.connect(user).setSpendingLimit(INITIAL_ALLOWANCE, now),
      ).to.be.revertedWithCustomError(escrow, "ExpirationInThePast");
    });
  });

  describe("cancelSpendingLimit events and state", function () {
    it("emits SpendingLimitCancelled(user) and zeroes the struct", async function () {
      const { escrow, user } = await loadFixture(deployFixture);
      const expiresAt = (await time.latest()) + 3600;
      await escrow.connect(user).setSpendingLimit(INITIAL_ALLOWANCE, expiresAt);

      await expect(escrow.connect(user).cancelSpendingLimit())
        .to.emit(escrow, "SpendingLimitCancelled")
        .withArgs(user.address);

      const limit = await escrow.spendingLimits(user.address);
      expect(limit.allowance).to.equal(0n);
      expect(limit.spentAmount).to.equal(0n);
      expect(limit.expiresAt).to.equal(0n);
    });

    it("SpendingLimitCancelled input is indexed", async function () {
      const { escrow } = await loadFixture(deployFixture);
      const fragment = escrow.interface.getEvent("SpendingLimitCancelled");

      expect(fragment.inputs).to.have.length(1);
      expect(fragment.inputs[0].name).to.equal("user");
      expect(fragment.inputs[0].indexed).to.be.true;
    });
  });

  describe("spentAmount deduction tracking", function () {
    it("each initiatePrompt increments spentAmount by PROMPT_FEE; allowance stays static", async function () {
      const { aiAgent, escrow, user, oracle } = await loadFixture(deployFixture);
      const expiresAt = (await time.latest()) + 7200;
      await escrow.connect(user).setSpendingLimit(INITIAL_ALLOWANCE, expiresAt);

      await escrow.connect(user).initiatePrompt(0, "0x", "0x");

      let limit = await escrow.spendingLimits(user.address);
      expect(limit.spentAmount).to.equal(
        PROMPT_FEE,
        "spentAmount should be PROMPT_FEE after first prompt",
      );
      expect(limit.allowance).to.equal(INITIAL_ALLOWANCE, "allowance must not change");

      // Finalize so the second prompt can proceed
      const agentIface = aiAgent.interface;
      const escrowIface = escrow.interface;

      const receipt1 = await (await escrow.connect(user).initiatePrompt(0, "0x", "0x")).wait();
      const escrowLog1 = receipt1.logs.find(
        (l) => l.topics[0] === escrowIface.getEvent("PaymentEscrowed").topicHash,
      );
      const answerMessageId1 = escrowIface.parseLog(escrowLog1).args[0];
      const agentLog1 = receipt1.logs.find(
        (l) => l.topics[0] === agentIface.getEvent("PromptSubmitted").topicHash,
      );
      const promptMessageId1 = agentIface.parseLog(agentLog1).args[2];

      limit = await escrow.spendingLimits(user.address);
      expect(limit.spentAmount).to.equal(
        PROMPT_FEE * 2n,
        "spentAmount should be 2x PROMPT_FEE after second prompt",
      );

      const cidBundle = {
        conversationCID: "QmXg9j4f8zYf8t7",
        metadataCID: "QmXg9j4f8zYf8t7",
        promptMessageCID: "QmXg9j4f8zYf8t7",
        answerMessageCID: "QmXg9j4f8zYf8t7",
        searchDeltaCID: "QmXg9j4f8zYf8t7",
      };
      await aiAgent.connect(oracle).submitAnswer(promptMessageId1, answerMessageId1, cidBundle);
    });
  });

  describe("NoActiveSpendingLimit sentinel", function () {
    it("initiatePrompt reverts with NoActiveSpendingLimit when no limit is set", async function () {
      const { escrow, user } = await loadFixture(deployFixture);

      await expect(
        escrow.connect(user).initiatePrompt(0, "0x", "0x"),
      ).to.be.revertedWithCustomError(escrow, "NoActiveSpendingLimit");
    });

    it("initiatePrompt reverts with NoActiveSpendingLimit after cancelSpendingLimit", async function () {
      const { escrow, user } = await loadFixture(deployFixture);
      const expiresAt = (await time.latest()) + 3600;
      await escrow.connect(user).setSpendingLimit(INITIAL_ALLOWANCE, expiresAt);
      await escrow.connect(user).cancelSpendingLimit();

      await expect(
        escrow.connect(user).initiatePrompt(0, "0x", "0x"),
      ).to.be.revertedWithCustomError(escrow, "NoActiveSpendingLimit");
    });
  });

  describe("SpendingLimitExpired sentinel", function () {
    it("initiatePrompt reverts with SpendingLimitExpired once expiresAt has passed", async function () {
      const { escrow, user } = await loadFixture(deployFixture);
      const expiresAt = (await time.latest()) + 5;
      await escrow.connect(user).setSpendingLimit(INITIAL_ALLOWANCE, expiresAt);

      await time.increase(10);

      await expect(
        escrow.connect(user).initiatePrompt(0, "0x", "0x"),
      ).to.be.revertedWithCustomError(escrow, "SpendingLimitExpired");
    });
  });

  describe("spentAmount after cancel and refund", function () {
    it("after cancelPrompt: spentAmount equals CANCELLATION_FEE (prompt fee refunded, cancel fee charged)", async function () {
      const { escrow, user } = await loadFixture(deployFixture);
      const expiresAt = (await time.latest()) + 7200;
      await escrow.connect(user).setSpendingLimit(INITIAL_ALLOWANCE, expiresAt);
      await escrow.connect(user).initiatePrompt(0, "0x", "0x");

      const escrowIface = escrow.interface;
      const receipt = await (await escrow.connect(user).initiatePrompt(0, "0x", "0x")).wait();
      const escrowLog = receipt.logs.find(
        (l) => l.topics[0] === escrowIface.getEvent("PaymentEscrowed").topicHash,
      );
      const answerMessageId = escrowIface.parseLog(escrowLog).args[0];

      await time.increase(5);
      await escrow.connect(user).cancelPrompt(answerMessageId);

      const limit = await escrow.spendingLimits(user.address);
      // First prompt's PROMPT_FEE remains + CANCELLATION_FEE for the cancelled prompt
      expect(limit.spentAmount).to.equal(PROMPT_FEE + CANCELLATION_FEE);
    });

    it("after processRefund: spentAmount returns to 0 for that job's deduction", async function () {
      const { escrow, user } = await loadFixture(deployFixture);
      const expiresAt = (await time.latest()) + 7200;
      await escrow.connect(user).setSpendingLimit(INITIAL_ALLOWANCE, expiresAt);

      const escrowIface = escrow.interface;
      const receipt = await (await escrow.connect(user).initiatePrompt(0, "0x", "0x")).wait();
      const escrowLog = receipt.logs.find(
        (l) => l.topics[0] === escrowIface.getEvent("PaymentEscrowed").topicHash,
      );
      const answerMessageId = escrowIface.parseLog(escrowLog).args[0];

      // Wait past REFUND_TIMEOUT (1 hour)
      await time.increase(3601);
      await escrow.connect(user).processRefund(answerMessageId);

      const limit = await escrow.spendingLimits(user.address);
      expect(limit.spentAmount).to.equal(0n, "spentAmount should be 0 after full refund");
    });
  });
});
