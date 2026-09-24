const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

// Moving the payouts from `transfer` to `Address.sendValue` removes the 2300-gas stipend, so a
// contract treasury can now run code when it is paid — and initiateBranch/initiateMetadataUpdate
// pay it BEFORE calling out to the agent. The question that raises is whether a callback can take
// a second fee from the user's deposit for one user action.
//
// It cannot, and the reason is worth pinning rather than rediscovering: _processDirectPayment
// charges `msg.sender`, which on re-entry is the TREASURY, not the user. A treasury with no
// spending limit of its own reverts on the first check. That is a property of the accounting, not
// of any guard — and it is what makes a ReentrancyGuard here unnecessary rather than merely
// untested. A refactor that charged a caller-supplied address instead would silently lose it.
describe("SapphireAIAgentEscrow — a re-entrant treasury cannot reach the user's deposit", function () {
  const INITIAL_DEPOSIT = ethers.parseEther("100");
  const PROMPT_FEE = ethers.parseEther("10");
  const CANCELLATION_FEE = ethers.parseEther("1");
  const METADATA_FEE = ethers.parseEther("0.5");
  const BRANCH_FEE = ethers.parseEther("2");

  async function deployFixture() {
    const [deployer, user, oracle] = await ethers.getSigners();

    const mockAgent = await (
      await ethers.getContractFactory("MockSapphireAIAgent")
    ).deploy(oracle.address);
    await mockAgent.waitForDeployment();

    const treasury = await (await ethers.getContractFactory("MockReentrantTreasury")).deploy();
    await treasury.waitForDeployment();

    const escrow = await (
      await ethers.getContractFactory("SapphireAIAgentEscrow")
    ).deploy(
      await mockAgent.getAddress(),
      await treasury.getAddress(),
      deployer.address,
      PROMPT_FEE,
      CANCELLATION_FEE,
      METADATA_FEE,
      BRANCH_FEE,
    );
    await escrow.waitForDeployment();

    await escrow.connect(user).deposit({ value: INITIAL_DEPOSIT });
    await escrow.connect(user).setSpendingLimit((await time.latest()) + 7200);

    return { escrow, treasury, user };
  }

  /** Runs `entry` once with the treasury armed to re-enter, and reports what the callback saw. */
  async function attemptReentry(escrow, treasury, user, entry, args) {
    await treasury.arm(
      await escrow.getAddress(),
      escrow.interface.encodeFunctionData(entry, args),
    );
    await escrow.connect(user)[entry](...args);

    expect(await treasury.reentryAttempted(), "the treasury callback never fired").to.be.true;

    return {
      succeeded: await treasury.reentrySucceeded(),
      reason: escrow.interface.parseError(await treasury.revertData())?.name,
    };
  }

  it("charges the re-entrant caller, not the user, when initiateBranch pays out", async function () {
    const { escrow, treasury, user } = await loadFixture(deployFixture);

    const { succeeded, reason } = await attemptReentry(escrow, treasury, user, "initiateBranch", [
      1n,
      1n,
      "re-entrant",
    ]);

    expect(succeeded, "the re-entry went through").to.be.false;
    expect(reason, "must fail on the TREASURY's own missing limit").to.equal(
      "NoActiveSpendingLimit",
    );
    expect(await escrow.deposits(user.address)).to.equal(INITIAL_DEPOSIT - BRANCH_FEE);
  });

  it("charges the re-entrant caller, not the user, when initiateMetadataUpdate pays out", async function () {
    const { escrow, treasury, user } = await loadFixture(deployFixture);

    const { succeeded, reason } = await attemptReentry(
      escrow,
      treasury,
      user,
      "initiateMetadataUpdate",
      [1n, "re-entrant"],
    );

    expect(succeeded, "the re-entry went through").to.be.false;
    expect(reason, "must fail on the TREASURY's own missing limit").to.equal(
      "NoActiveSpendingLimit",
    );
    expect(await escrow.deposits(user.address)).to.equal(INITIAL_DEPOSIT - METADATA_FEE);
  });
});
