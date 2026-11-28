const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

// The agent and escrow run here against the SENSE token itself, taken from its own repository at
// a pinned commit, and not against a stand-in. SENSE moves only when the sender or the recipient
// is exempt, so every movement the escrow makes has to have an exempt side.
describe("the escrow with SENSE as the fee token", function () {
  const DOMAIN = "example.com";
  const SUPPLY = ethers.parseEther("1000000000");
  const GRANT = ethers.parseEther("100");
  const PROMPT_FEE = ethers.parseEther("10");
  const CANCELLATION_FEE = ethers.parseEther("1");
  const METADATA_FEE = ethers.parseEther("0.5");
  const BRANCH_FEE = ethers.parseEther("2");
  const MOCK_CID = "QmXg9j4f8zYf8t7f8zYf8t7f8zYf8t7f8zYf8t7f8zYf8t7";
  const CID_BUNDLE = {
    conversationCID: MOCK_CID,
    metadataCID: MOCK_CID,
    promptMessageCID: MOCK_CID,
    answerMessageCID: MOCK_CID,
    searchDeltaCID: MOCK_CID,
  };

  // The token's owner holds the supply and is exempt by being the owner. The escrow and the
  // treasury are exempt because the owner listed them. The user and the stranger are not.
  async function deploy({ listEscrow = true, listTreasury = true } = {}) {
    const [owner, user, oracle, treasury, stranger] = await ethers.getSigners();

    const token = await upgrades.deployProxy(
      await ethers.getContractFactory("SenseToken"),
      ["SENSE Points", "SENSE", SUPPLY, owner.address],
      { initializer: "initialize", kind: "uups" },
    );
    await token.waitForDeployment();

    const agent = await upgrades.deployProxy(
      await ethers.getContractFactory("EVMAIAgent"),
      [DOMAIN, oracle.address, owner.address],
      { initializer: "initialize", kind: "uups" },
    );
    await agent.waitForDeployment();

    const escrow = await upgrades.deployProxy(
      await ethers.getContractFactory("EVMAIAgentEscrow"),
      [
        await token.getAddress(),
        await agent.getAddress(),
        treasury.address,
        owner.address,
        PROMPT_FEE,
        CANCELLATION_FEE,
        METADATA_FEE,
        BRANCH_FEE,
      ],
      { initializer: "initialize", kind: "uups" },
    );
    await escrow.waitForDeployment();
    await agent.setAgentEscrow(await escrow.getAddress());

    if (listEscrow) await token.setTransferExempt(await escrow.getAddress(), true);
    if (listTreasury) await token.setTransferExempt(treasury.address, true);

    await token.transfer(user.address, GRANT);
    await token.connect(user).approve(await escrow.getAddress(), GRANT);
    await escrow.connect(user).setSpendingLimit(GRANT, (await time.latest()) + 7 * 24 * 3600);

    return { token, agent, escrow, owner, user, oracle, treasury, stranger };
  }

  const everythingListed = () => deploy();
  const escrowNotListed = () => deploy({ listEscrow: false });
  const treasuryNotListed = () => deploy({ listTreasury: false });

  // Sends a prompt and returns the ids the two contracts gave it.
  async function prompt(escrow, agent, user, conversationId = 0) {
    const receipt = await (
      await escrow.connect(user).initiatePrompt(conversationId, "0x", "0x", ethers.MaxUint256)
    ).wait();
    const find = (contract, name) => {
      const topic = contract.interface.getEvent(name).topicHash;
      const log = receipt.logs.find((entry) => entry.topics[0] === topic);
      if (!log) throw new Error(`${name} was not emitted by transaction ${receipt.hash}`);
      return contract.interface.parseLog(log);
    };
    const submitted = find(agent, "PromptSubmitted");
    return {
      // The key both contracts know the prompt by; the escrow's own event carries the same id.
      answerMessageId: submitted.args[3],
      conversationId: submitted.args[1],
      promptMessageId: submitted.args[2],
    };
  }

  describe("with the escrow and the treasury exempt", function () {
    it("takes the fee into escrow on a prompt, and pays the treasury on the answer", async function () {
      const { token, agent, escrow, user, oracle, treasury } = await loadFixture(everythingListed);

      const { answerMessageId, promptMessageId } = await prompt(escrow, agent, user);

      expect(await token.balanceOf(user.address)).to.equal(GRANT - PROMPT_FEE);
      expect(await token.balanceOf(await escrow.getAddress())).to.equal(PROMPT_FEE);

      await agent.connect(oracle).submitAnswer(promptMessageId, answerMessageId, CID_BUNDLE);

      expect(await token.balanceOf(await escrow.getAddress())).to.equal(0n);
      expect(await token.balanceOf(treasury.address)).to.equal(PROMPT_FEE);
      expect(await token.balanceOf(user.address)).to.equal(GRANT - PROMPT_FEE);
    });

    it("returns the fee on a cancel, less the cancellation fee", async function () {
      const { token, agent, escrow, user, treasury } = await loadFixture(everythingListed);
      const { answerMessageId } = await prompt(escrow, agent, user);
      await time.increase(await escrow.CANCELLATION_TIMEOUT());

      await escrow.connect(user).cancelPrompt(answerMessageId, ethers.MaxUint256);

      expect(await token.balanceOf(user.address)).to.equal(GRANT - CANCELLATION_FEE);
      expect(await token.balanceOf(treasury.address)).to.equal(CANCELLATION_FEE);
      expect(await token.balanceOf(await escrow.getAddress())).to.equal(0n);
    });

    it("returns the whole fee on a refund, whoever asks for it", async function () {
      const { token, agent, escrow, user, treasury, stranger } =
        await loadFixture(everythingListed);
      const { answerMessageId } = await prompt(escrow, agent, user);
      await time.increase(await escrow.REFUND_TIMEOUT());

      await escrow.connect(stranger).processRefund(answerMessageId);

      expect(await token.balanceOf(user.address)).to.equal(GRANT);
      expect(await token.balanceOf(treasury.address)).to.equal(0n);
      expect(await token.balanceOf(await escrow.getAddress())).to.equal(0n);
    });

    it("pays the treasury directly for a metadata update and for a branch", async function () {
      const { token, agent, escrow, user, oracle, treasury } = await loadFixture(everythingListed);
      const first = await prompt(escrow, agent, user);
      await agent
        .connect(oracle)
        .submitAnswer(first.promptMessageId, first.answerMessageId, CID_BUNDLE);

      await escrow
        .connect(user)
        .initiateMetadataUpdate(first.conversationId, "0x", "0x", ethers.MaxUint256);
      await escrow
        .connect(user)
        .initiateBranch(first.conversationId, first.promptMessageId, "0x", "0x", ethers.MaxUint256);

      expect(await token.balanceOf(treasury.address)).to.equal(
        PROMPT_FEE + METADATA_FEE + BRANCH_FEE,
      );
      expect(await token.balanceOf(user.address)).to.equal(
        GRANT - PROMPT_FEE - METADATA_FEE - BRANCH_FEE,
      );
    });

    it("still refuses a holder sending SENSE to someone else, directly or through an allowance", async function () {
      const { token, user, stranger } = await loadFixture(everythingListed);

      await expect(token.connect(user).transfer(stranger.address, 1n))
        .to.be.revertedWithCustomError(token, "TransferNotAllowed")
        .withArgs(user.address, stranger.address);

      await token.connect(user).approve(stranger.address, 1n);
      await expect(token.connect(stranger).transferFrom(user.address, stranger.address, 1n))
        .to.be.revertedWithCustomError(token, "TransferNotAllowed")
        .withArgs(user.address, stranger.address);
    });

    it("does not let the escrow's allowance be used to move a holder's SENSE anywhere else", async function () {
      const { token, escrow, user, stranger } = await loadFixture(everythingListed);

      // The allowance is the escrow's. Nobody else can spend it, exempt recipient or not.
      await expect(
        token.connect(stranger).transferFrom(user.address, await escrow.getAddress(), 1n),
      ).to.be.revertedWithCustomError(token, "ERC20InsufficientAllowance");
    });
  });

  // What an operator gets wrong on a deploy day, and what it costs. Each of these is put right
  // by the token's owner listing the address.
  describe("when an address the escrow pays through is not exempt", function () {
    it("refuses every prompt while the escrow is not listed", async function () {
      const { token, escrow, user } = await loadFixture(escrowNotListed);

      await expect(escrow.connect(user).initiatePrompt(0, "0x", "0x", ethers.MaxUint256))
        .to.be.revertedWithCustomError(token, "TransferNotAllowed")
        .withArgs(user.address, await escrow.getAddress());
    });

    it("holds a pending fee when the escrow is taken off the list, and returns it once listed again", async function () {
      const { token, agent, escrow, user, stranger } = await loadFixture(everythingListed);
      const { answerMessageId } = await prompt(escrow, agent, user);
      await time.increase(await escrow.REFUND_TIMEOUT());
      await token.setTransferExempt(await escrow.getAddress(), false);

      await expect(escrow.connect(stranger).processRefund(answerMessageId))
        .to.be.revertedWithCustomError(token, "TransferNotAllowed")
        .withArgs(await escrow.getAddress(), user.address);

      await token.setTransferExempt(await escrow.getAddress(), true);
      await escrow.connect(stranger).processRefund(answerMessageId);
      expect(await token.balanceOf(user.address)).to.equal(GRANT);
    });

    it("still answers and pays a treasury that is not listed, because the escrow is the exempt side", async function () {
      const { token, agent, escrow, user, oracle, treasury } = await loadFixture(treasuryNotListed);
      const { answerMessageId, promptMessageId } = await prompt(escrow, agent, user);

      await agent.connect(oracle).submitAnswer(promptMessageId, answerMessageId, CID_BUNDLE);

      expect(await token.balanceOf(treasury.address)).to.equal(PROMPT_FEE);
    });

    it("refuses a metadata update and a branch while the treasury is not listed", async function () {
      const { token, agent, escrow, user, treasury } = await loadFixture(treasuryNotListed);
      const { conversationId, promptMessageId } = await prompt(escrow, agent, user);

      for (const call of [
        () =>
          escrow
            .connect(user)
            .initiateMetadataUpdate(conversationId, "0x", "0x", ethers.MaxUint256),
        () =>
          escrow
            .connect(user)
            .initiateBranch(conversationId, promptMessageId, "0x", "0x", ethers.MaxUint256),
      ]) {
        await expect(call())
          .to.be.revertedWithCustomError(token, "TransferNotAllowed")
          .withArgs(user.address, treasury.address);
      }
    });

    it("lets a cancel through while the treasury is not listed, since both payments leave the listed escrow", async function () {
      const { token, agent, escrow, user, treasury } = await loadFixture(treasuryNotListed);
      const { answerMessageId } = await prompt(escrow, agent, user);
      await time.increase(await escrow.CANCELLATION_TIMEOUT());
      const fee = await escrow.cancellationFee();
      const userBefore = await token.balanceOf(user.address);
      const treasuryBefore = await token.balanceOf(treasury.address);

      await escrow.connect(user).cancelPrompt(answerMessageId, ethers.MaxUint256);

      // The escrow held the prompt fee: the fee of the cancellation goes to the treasury and the
      // rest back to the user.
      expect(await token.balanceOf(treasury.address)).to.equal(treasuryBefore + fee);
      expect(await token.balanceOf(user.address)).to.equal(userBefore + PROMPT_FEE - fee);
    });

    it("refuses prompts, answers, refunds and cancels alike while the token is paused", async function () {
      const { token, agent, escrow, user, oracle, stranger } = await loadFixture(everythingListed);
      const { answerMessageId, promptMessageId } = await prompt(escrow, agent, user);
      await time.increase(await escrow.REFUND_TIMEOUT());
      await token.pause();

      await expect(
        escrow.connect(user).initiatePrompt(0, "0x", "0x", ethers.MaxUint256),
      ).to.be.revertedWithCustomError(token, "EnforcedPause");
      await expect(
        agent.connect(oracle).submitAnswer(promptMessageId, answerMessageId, CID_BUNDLE),
      ).to.be.revertedWithCustomError(token, "EnforcedPause");
      await expect(
        escrow.connect(stranger).processRefund(answerMessageId),
      ).to.be.revertedWithCustomError(token, "EnforcedPause");
      await expect(
        escrow.connect(user).cancelPrompt(answerMessageId, ethers.MaxUint256),
      ).to.be.revertedWithCustomError(token, "EnforcedPause");
    });
  });
});
