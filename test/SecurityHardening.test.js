const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

/**
 * Contract-level findings from the cross-repo security review, 2026-09-22 (CU-14ym9bv73e5).
 */
describe("Security hardening", function () {
  const INITIAL_ALLOWANCE = ethers.parseEther("100");
  const PROMPT_FEE = ethers.parseEther("10");
  const CANCELLATION_FEE = ethers.parseEther("1");
  const METADATA_FEE = ethers.parseEther("0.5");
  const BRANCH_FEE = ethers.parseEther("2");

  async function deployWithToken(tokenContractName) {
    const [deployer, user, oracle, treasury] = await ethers.getSigners();

    const MockAgentFactory = await ethers.getContractFactory("MockEVMAIAgent");
    const mockAgent = await MockAgentFactory.deploy(oracle.address);
    await mockAgent.waitForDeployment();

    const TokenFactory = await ethers.getContractFactory(tokenContractName);
    const token = await TokenFactory.deploy();
    await token.waitForDeployment();
    await token.mint(user.address, INITIAL_ALLOWANCE);

    const EVMAIAgentEscrow = await ethers.getContractFactory("EVMAIAgentEscrow");
    const escrow = await upgrades.deployProxy(
      EVMAIAgentEscrow,
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

    return { escrow, token, user, treasury, mockAgent };
  }

  function reentrantFixture() {
    return deployWithToken("MockReentrantToken");
  }

  function falseReturningFixture() {
    return deployWithToken("MockFalseReturningToken");
  }

  describe("cancelPrompt — checks-effects-interactions", function () {
    // cancelPrompt wrote `escrow.status = REFUNDED` and decremented pendingEscrowCount AFTER
    // calling ableToken.transferFrom. A token that calls back re-entered while the escrow still
    // read PENDING and still had `escrow.user == msg.sender`, so every guard passed a second
    // time and the refund could be taken twice.
    //
    // NOT a live attack path — $ABLE is a plain OZ ERC-20 that never calls back, and the escrow
    // fixes its token at initialize with no setter. This asserts the ordering as a property of
    // the ESCROW rather than of the token it happens to be paired with, which is what makes it
    // still true after an upgrade or a redeploy against a different token.
    //
    // Its two siblings, finalizePayment and processRefund, already ordered this correctly, so
    // this was an inconsistency within one file as much as a security finding.
    // WHAT THIS IS, PRECISELY. cancelPrompt wrote `escrow.status = REFUNDED` and decremented
    // pendingEscrowCount AFTER calling ableToken.transferFrom, where its two siblings —
    // finalizePayment and processRefund — both write state first. So this was an inconsistency
    // inside one file as much as a security finding.
    //
    // IT IS NOT CURRENTLY EXPLOITABLE, and saying otherwise would be overstating it. Two
    // accidents stop it: a token cannot spoof msg.sender, so re-entering cancelPrompt itself
    // trips NotPromptOwner; and re-entering the permissionless processRefund underflows
    // `spentAmount -= escrow.amount` and reverts, because cancelPrompt has already decremented
    // it. Both are luck rather than design — the second in particular depends on the relative
    // values of promptFee and cancellationFee, which are owner-settable at runtime.
    //
    // So the test asserts the ORDERING, which is the property CEI actually guarantees and the
    // thing that stays true when those fee values change. The token records what the escrow
    // looked like at the instant it was called.
    it("has already written REFUNDED before it calls out to the token", async function () {
      const { escrow, token, user } = await loadFixture(reentrantFixture);
      const answerMessageId = 1;

      await escrow.connect(user).setSpendingLimit(INITIAL_ALLOWANCE, (await time.latest()) + 7200);
      await escrow.connect(user).initiatePrompt(0, "0x", "0x");
      await time.increase(5);

      const peek = escrow.interface.encodeFunctionData("escrows", [answerMessageId]);
      await token.arm(await escrow.getAddress(), peek);
      await escrow.connect(user).cancelPrompt(answerMessageId);

      const observed = await token.observed();
      expect(observed, "token callback never fired").to.not.equal("0x");
      const decoded = escrow.interface.decodeFunctionResult("escrows", observed);

      // EscrowStatus: 0 NONE, 1 PENDING, 2 COMPLETE, 3 REFUNDED.
      expect(decoded.status).to.equal(3);
    });

    it("still refunds exactly once, and does not underflow the pending count", async function () {
      // The behavioural guard that must survive the reordering.
      const { escrow, token, user } = await loadFixture(reentrantFixture);
      const answerMessageId = 1;

      await escrow.connect(user).setSpendingLimit(INITIAL_ALLOWANCE, (await time.latest()) + 7200);
      await escrow.connect(user).initiatePrompt(0, "0x", "0x");
      await time.increase(3601);

      const reentry = escrow.interface.encodeFunctionData("processRefund", [answerMessageId]);
      await token.arm(await escrow.getAddress(), reentry);

      const before = await token.balanceOf(user.address);
      await escrow.connect(user).cancelPrompt(answerMessageId);

      expect((await token.balanceOf(user.address)) - before).to.equal(PROMPT_FEE - CANCELLATION_FEE);
      expect(await escrow.pendingEscrowCount(user.address)).to.equal(0);
    });
  });

  describe("SafeERC20 on every token movement", function () {
    // The escrow used raw transfer/transferFrom and ignored the boolean return. A token that
    // reports failure by returning false — rather than reverting — would have let the escrow
    // record a settled payment that never moved. $ABLE reverts, so this is defence in depth
    // against a future token, an upgrade, or a redeploy.
    it("reverts rather than silently succeeding when the token returns false", async function () {
      const { escrow, user } = await loadFixture(falseReturningFixture);

      await escrow.connect(user).setSpendingLimit(INITIAL_ALLOWANCE, (await time.latest()) + 7200);

      await expect(escrow.connect(user).initiatePrompt(0, "0x", "0x")).to.be.reverted;
    });
  });
});
