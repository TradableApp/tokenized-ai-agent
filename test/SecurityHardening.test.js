const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

/**
 * Contract-level findings from the cross-repo security review, 2026-09-22.
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
    // calling ableToken.transferFrom, where its two siblings — finalizePayment and processRefund
    // — both write state first. So this was an inconsistency inside one file as much as a
    // security finding.
    //
    // IT IS NOT CURRENTLY EXPLOITABLE, and saying otherwise would overstate it. $ABLE is a plain
    // OZ ERC-20 that never calls back, and the escrow fixes its token at initialize with no
    // setter. Beyond that, two accidents stop it: a token cannot spoof msg.sender, so re-entering
    // cancelPrompt trips NotPromptOwner, and re-entering the permissionless processRefund
    // underflows `spentAmount -= escrow.amount` and reverts because cancelPrompt has already
    // decremented it. Both are luck rather than design — the second depends on the relative
    // values of promptFee and cancellationFee, which are owner-settable at runtime.
    //
    // So the test asserts the ORDERING: the property CEI actually guarantees, and the one that
    // stays true across an upgrade, a redeploy against a different token, or a change to those
    // fee values. The token records what the escrow looked like at the instant it was called.
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

      // EscrowStatus has no NONE member: PENDING = 0, COMPLETE = 1, REFUNDED = 2. Before the
      // reorder this read 0 — the token was called while the escrow still said PENDING.
      expect(decoded.status).to.equal(2);
    });

    // A REAL re-entrant call, not a staticcall. The observing variant above cannot SSTORE, so an
    // "attack" armed with it is inert by construction — this test previously used it and stayed
    // GREEN under a mutation that moved the effects back after the first token call, while
    // claiming in its own comment to be "the behavioural guard that must survive the reordering".
    //
    // What it is guarding: with two or more pending escrows the pre-fix underflow does NOT save
    // us. spentAmount is large enough that `processRefund` completes, and `cancelPrompt` then
    // resumes and pays `escrow.amount` a SECOND time — a double refund drawn from other users'
    // escrowed funds. The reorder closes it because the re-entrant call now finds status
    // REFUNDED and reverts.
    it("refuses a real re-entrant refund, so the user is paid exactly once", async function () {
      const { escrow, token, user } = await loadFixture(reentrantFixture);
      const answerMessageId = 1;

      await escrow.connect(user).setSpendingLimit(INITIAL_ALLOWANCE, (await time.latest()) + 7200);
      // TWO pending escrows: with only one, an underflow reverts the re-entrant call for an
      // unrelated reason and the test would pass without the ordering being responsible.
      await escrow.connect(user).initiatePrompt(0, "0x", "0x");
      await escrow.connect(user).initiatePrompt(0, "0x", "0x");
      await time.increase(3601);

      const reentry = escrow.interface.encodeFunctionData("processRefund", [answerMessageId]);
      await token.armCall(await escrow.getAddress(), reentry);

      const before = await token.balanceOf(user.address);
      await escrow.connect(user).cancelPrompt(answerMessageId);

      expect(await token.reentrySucceeded(), "the re-entrant refund must be rejected").to.equal(
        false,
      );
      expect((await token.balanceOf(user.address)) - before).to.equal(PROMPT_FEE - CANCELLATION_FEE);
      expect(await escrow.pendingEscrowCount(user.address)).to.equal(1);
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
