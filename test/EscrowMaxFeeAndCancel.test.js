const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

// A paying call names the most it will pay, a cancellation takes its fee out of the escrowed
// amount, and the escrow record is written before any token moves.
describe("EVMAIAgentEscrow: maximum fee and cancellation from the escrowed amount", function () {
  const BALANCE = ethers.parseEther("100");
  const PROMPT_FEE = ethers.parseEther("10");
  const CANCELLATION_FEE = ethers.parseEther("1");
  const METADATA_FEE = ethers.parseEther("0.5");
  const BRANCH_FEE = ethers.parseEther("2");
  const PAYLOAD = "0x1234";
  const KEY = "0x5678";
  // The escrow status enum: PENDING is its first member.
  const PENDING = 0n;
  const REFUNDED = 2n;

  async function deployWith(tokenName) {
    const [deployer, user, oracle, treasury] = await ethers.getSigners();
    const mockAgent = await (
      await ethers.getContractFactory("MockEVMAIAgent")
    ).deploy(oracle.address);
    const token = await (await ethers.getContractFactory(tokenName)).deploy();
    await token.mint(user.address, BALANCE);
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
    await token.connect(user).approve(await escrow.getAddress(), BALANCE);
    await escrow.connect(user).setSpendingLimit(BALANCE, (await time.latest()) + 86400);
    return { escrow, token, mockAgent, deployer, user, oracle, treasury };
  }

  const plain = () => deployWith("MockAbleToken");
  const reentrant = () => deployWith("MockReentrantToken");

  async function snapshot({ escrow, token, user, treasury }) {
    return {
      user: await token.balanceOf(user.address),
      treasury: await token.balanceOf(treasury.address),
      escrow: await token.balanceOf(await escrow.getAddress()),
      spent: (await escrow.spendingLimits(user.address)).spentAmount,
      pending: await escrow.pendingEscrowCount(user.address),
    };
  }

  describe("a paying call names its maximum fee", function () {
    const calls = [
      {
        name: "initiatePrompt",
        setter: "setPromptFee",
        fee: PROMPT_FEE,
        send: (escrow, user, max) => escrow.connect(user).initiatePrompt(0, PAYLOAD, KEY, max),
      },
      {
        name: "initiateRegeneration",
        setter: "setPromptFee",
        fee: PROMPT_FEE,
        send: (escrow, user, max) =>
          escrow.connect(user).initiateRegeneration(1, 1, 2, PAYLOAD, KEY, max),
      },
      {
        name: "initiateBranch",
        setter: "setBranchFee",
        fee: BRANCH_FEE,
        send: (escrow, user, max) => escrow.connect(user).initiateBranch(1, 1, PAYLOAD, KEY, max),
      },
      {
        name: "initiateMetadataUpdate",
        setter: "setMetadataUpdateFee",
        fee: METADATA_FEE,
        send: (escrow, user, max) =>
          escrow.connect(user).initiateMetadataUpdate(1, PAYLOAD, KEY, max),
      },
    ];

    for (const call of calls) {
      it(`${call.name} takes nothing when the fee was raised above the caller's maximum`, async function () {
        const ctx = await loadFixture(plain);
        const before = await snapshot(ctx);
        // The owner raises the fee by one wei after the user read it.
        const raised = call.fee + 1n;
        await ctx.escrow.connect(ctx.deployer)[call.setter](raised);

        await expect(call.send(ctx.escrow, ctx.user, call.fee))
          .to.be.revertedWithCustomError(ctx.escrow, "FeeAboveMaximum")
          .withArgs(raised, call.fee);

        expect(await snapshot(ctx)).to.deep.equal(before);
      });

      it(`${call.name} goes through when the fee equals the caller's maximum`, async function () {
        const ctx = await loadFixture(plain);
        const before = await snapshot(ctx);

        await call.send(ctx.escrow, ctx.user, call.fee);

        // The user pays exactly the fee, wherever it goes (escrow or treasury).
        expect((await snapshot(ctx)).user).to.equal(before.user - call.fee);
      });
    }
  });

  describe("a cancellation takes its fee from the escrowed amount", function () {
    async function withPendingPrompt() {
      const ctx = await plain();
      await ctx.escrow.connect(ctx.user).initiatePrompt(0, PAYLOAD, KEY, PROMPT_FEE);
      // The mock agent hands out message ids from 0: prompt 0, answer 1. The answer id keys the escrow.
      const answerMessageId = 1n;
      await time.increase(5);
      return { ...ctx, answerMessageId };
    }

    it("pays the fee to the treasury and the rest to the user, out of the escrow's own balance", async function () {
      const ctx = await loadFixture(withPendingPrompt);
      const before = await snapshot(ctx);
      const escrowAddress = await ctx.escrow.getAddress();
      const approvalBefore = await ctx.token.allowance(ctx.user.address, escrowAddress);

      await expect(ctx.escrow.connect(ctx.user).cancelPrompt(ctx.answerMessageId, CANCELLATION_FEE))
        .to.emit(ctx.escrow, "CancellationSettled")
        // fee 1, returned 10 - 1 = 9
        .withArgs(
          ctx.answerMessageId,
          ctx.user.address,
          CANCELLATION_FEE,
          PROMPT_FEE - CANCELLATION_FEE,
        )
        .and.to.emit(ctx.escrow, "PromptCancelled")
        .withArgs(ctx.user.address, ctx.answerMessageId);

      const after = await snapshot(ctx);
      // The user gets back the escrowed 10 less the fee of 1.
      expect(after.user).to.equal(before.user + PROMPT_FEE - CANCELLATION_FEE);
      expect(after.treasury).to.equal(before.treasury + CANCELLATION_FEE);
      // The escrow held 10 for this prompt and holds nothing after.
      expect(after.escrow).to.equal(before.escrow - PROMPT_FEE);
      // Nothing was pulled from the wallet: the approval is what it was.
      expect(await ctx.token.allowance(ctx.user.address, escrowAddress)).to.equal(approvalBefore);
      // The plan was charged 10 for the prompt and gets 9 back: 1, the fee, stays spent.
      expect(after.spent).to.equal(CANCELLATION_FEE);
      expect(after.pending).to.equal(0n);
      expect((await ctx.escrow.escrows(ctx.answerMessageId)).status).to.equal(REFUNDED);
    });

    it("works with a spent-out limit, no approval and an empty wallet", async function () {
      const ctx = await plain();
      const escrowAddress = await ctx.escrow.getAddress();
      // A limit of exactly one prompt: after the prompt nothing of it is left.
      await ctx.escrow
        .connect(ctx.user)
        .setSpendingLimit(PROMPT_FEE, (await time.latest()) + 86400);
      await ctx.escrow.connect(ctx.user).initiatePrompt(0, PAYLOAD, KEY, PROMPT_FEE);
      await ctx.token.connect(ctx.user).approve(escrowAddress, 0);
      // The wallet held 100 and paid 10: the remaining 90 leaves.
      await ctx.token.connect(ctx.user).transfer(ctx.deployer.address, BALANCE - PROMPT_FEE);
      expect(await ctx.token.balanceOf(ctx.user.address)).to.equal(0n);
      await time.increase(5);

      await ctx.escrow.connect(ctx.user).cancelPrompt(1, CANCELLATION_FEE);

      // 10 escrowed, 1 to the treasury, 9 back to the empty wallet.
      expect(await ctx.token.balanceOf(ctx.user.address)).to.equal(PROMPT_FEE - CANCELLATION_FEE);
      expect(await ctx.token.balanceOf(ctx.treasury.address)).to.equal(CANCELLATION_FEE);
    });

    it("never charges more than was escrowed", async function () {
      const ctx = await loadFixture(withPendingPrompt);
      const before = await snapshot(ctx);
      // A cancellation fee of 11 against an escrowed 10.
      const above = PROMPT_FEE + ethers.parseEther("1");
      await ctx.escrow.connect(ctx.deployer).setCancellationFee(above);

      await expect(ctx.escrow.connect(ctx.user).cancelPrompt(ctx.answerMessageId, above))
        .to.emit(ctx.escrow, "CancellationSettled")
        // The whole 10 is the fee and nothing is returned.
        .withArgs(ctx.answerMessageId, ctx.user.address, PROMPT_FEE, 0n);

      const after = await snapshot(ctx);
      expect(after.user).to.equal(before.user);
      expect(after.treasury).to.equal(before.treasury + PROMPT_FEE);
      // The plan was charged 10 for the prompt and nothing came back.
      expect(after.spent).to.equal(PROMPT_FEE);
    });

    it("is refused, with nothing moved, when the fee was raised above the caller's maximum", async function () {
      const ctx = await loadFixture(withPendingPrompt);
      const raised = CANCELLATION_FEE + 1n;
      await ctx.escrow.connect(ctx.deployer).setCancellationFee(raised);
      const before = await snapshot(ctx);

      await expect(ctx.escrow.connect(ctx.user).cancelPrompt(ctx.answerMessageId, CANCELLATION_FEE))
        .to.be.revertedWithCustomError(ctx.escrow, "FeeAboveMaximum")
        .withArgs(raised, CANCELLATION_FEE);

      expect(await snapshot(ctx)).to.deep.equal(before);
      expect((await ctx.escrow.escrows(ctx.answerMessageId)).status).to.equal(PENDING);
    });

    it("checks the maximum against the fee actually charged, not a fee above the escrowed amount", async function () {
      const ctx = await loadFixture(withPendingPrompt);
      // The fee is set to 50 but only the escrowed 10 can be charged, and the caller allows 10.
      await ctx.escrow.connect(ctx.deployer).setCancellationFee(ethers.parseEther("50"));

      await expect(ctx.escrow.connect(ctx.user).cancelPrompt(ctx.answerMessageId, PROMPT_FEE)).not
        .to.be.reverted;
    });
  });

  describe("the escrow record is written before any token moves", function () {
    it("a token that looks back at the escrow while a prompt's payment is pulled sees the record", async function () {
      const ctx = await loadFixture(reentrant);
      // The mock agent hands out message ids from 0: prompt 0, answer 1.
      const answerMessageId = 1n;
      await ctx.token.arm(
        await ctx.escrow.getAddress(),
        ctx.escrow.interface.encodeFunctionData("escrows", [answerMessageId]),
      );

      await ctx.escrow.connect(ctx.user).initiatePrompt(0, PAYLOAD, KEY, PROMPT_FEE);

      const [seenUser, seenAmount, , seenStatus] = ctx.escrow.interface.decodeFunctionResult(
        "escrows",
        await ctx.token.observed(),
      );
      expect(seenUser).to.equal(ctx.user.address);
      expect(seenAmount).to.equal(PROMPT_FEE);
      expect(seenStatus).to.equal(PENDING);
    });

    it("the same holds for a regeneration", async function () {
      const ctx = await loadFixture(reentrant);
      // No prompt came first in this fixture, so the regeneration's answer takes message id 0.
      const answerMessageId = 0n;
      await ctx.token.arm(
        await ctx.escrow.getAddress(),
        ctx.escrow.interface.encodeFunctionData("escrows", [answerMessageId]),
      );

      await ctx.escrow.connect(ctx.user).initiateRegeneration(1, 1, 2, PAYLOAD, KEY, PROMPT_FEE);

      const [seenUser, seenAmount] = ctx.escrow.interface.decodeFunctionResult(
        "escrows",
        await ctx.token.observed(),
      );
      expect(seenUser).to.equal(ctx.user.address);
      expect(seenAmount).to.equal(PROMPT_FEE);
    });
  });
});

// The Sapphire escrow charges a deposit and has the same owner-set fees, so its paying calls take
// the same maximum.
describe("SapphireAIAgentEscrow: a paying call names its maximum fee", function () {
  const DEPOSIT = ethers.parseEther("100");
  const PROMPT_FEE = ethers.parseEther("10");
  const CANCELLATION_FEE = ethers.parseEther("1");
  const METADATA_FEE = ethers.parseEther("0.5");
  const BRANCH_FEE = ethers.parseEther("2");
  const PAYLOAD = "a confidential payload";

  async function deploy() {
    const [deployer, user, oracle, treasury] = await ethers.getSigners();
    const mockAgent = await (
      await ethers.getContractFactory("MockSapphireAIAgent")
    ).deploy(oracle.address);
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
    await escrow.connect(user).deposit({ value: DEPOSIT });
    await escrow.connect(user).setSpendingLimit((await time.latest()) + 86400);
    return { escrow, deployer, user };
  }

  const calls = [
    [
      "initiatePrompt",
      "setPromptFee",
      PROMPT_FEE,
      (e, u, max) => e.connect(u).initiatePrompt(0, PAYLOAD, max),
    ],
    [
      "initiateRegeneration",
      "setPromptFee",
      PROMPT_FEE,
      (e, u, max) => e.connect(u).initiateRegeneration(1, 1, 2, PAYLOAD, max),
    ],
    [
      "initiateBranch",
      "setBranchFee",
      BRANCH_FEE,
      (e, u, max) => e.connect(u).initiateBranch(1, 1, PAYLOAD, max),
    ],
    [
      "initiateMetadataUpdate",
      "setMetadataUpdateFee",
      METADATA_FEE,
      (e, u, max) => e.connect(u).initiateMetadataUpdate(1, PAYLOAD, max),
    ],
  ];

  for (const [name, setter, fee, send] of calls) {
    it(`${name} charges nothing when the fee was raised above the caller's maximum`, async function () {
      const { escrow, deployer, user } = await loadFixture(deploy);
      // One wei above what the user read.
      await escrow.connect(deployer)[setter](fee + 1n);

      await expect(send(escrow, user, fee))
        .to.be.revertedWithCustomError(escrow, "FeeAboveMaximum")
        .withArgs(fee + 1n, fee);
      expect(await escrow.deposits(user.address)).to.equal(DEPOSIT);
    });

    it(`${name} goes through at exactly the fee`, async function () {
      const { escrow, user } = await loadFixture(deploy);

      await send(escrow, user, fee);

      // The deposit of 100 is charged the fee once.
      expect(await escrow.deposits(user.address)).to.equal(DEPOSIT - fee);
    });
  }

  it("cancelPrompt is refused when the cancellation fee was raised above the caller's maximum", async function () {
    const { escrow, deployer, user } = await loadFixture(deploy);
    await escrow.connect(user).initiatePrompt(0, PAYLOAD, PROMPT_FEE);
    await time.increase(5);
    await escrow.connect(deployer).setCancellationFee(CANCELLATION_FEE + 1n);

    // The mock agent hands out message ids from 0: prompt 0, answer 1.
    await expect(escrow.connect(user).cancelPrompt(1, CANCELLATION_FEE))
      .to.be.revertedWithCustomError(escrow, "FeeAboveMaximum")
      .withArgs(CANCELLATION_FEE + 1n, CANCELLATION_FEE);
    // The deposit still holds 100 less the escrowed 10.
    expect(await escrow.deposits(user.address)).to.equal(DEPOSIT - PROMPT_FEE);
  });
});
