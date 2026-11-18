const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

// Ownership of the agent and the escrow decides who may authorise an oracle, set the fees and the
// treasury, and upgrade. It moves only when the new owner accepts it, so an address that cannot
// act (a mistyped one, one from another chain) never becomes the owner, and it cannot be given up.
describe("ownership moves in two steps and cannot be renounced", function () {
  const DOMAIN = "example.com";
  const ROFL_APP_ID = ethers.zeroPadValue("0x01", 21);
  const FEE = ethers.parseEther("1");

  async function evmPair() {
    const [owner, next, stranger, oracle, treasury] = await ethers.getSigners();
    const token = await (await ethers.getContractFactory("MockAbleToken")).deploy();
    const agent = await upgrades.deployProxy(
      await ethers.getContractFactory("EVMAIAgent"),
      [DOMAIN, oracle.address, owner.address],
      { initializer: "initialize", kind: "uups" },
    );
    const escrow = await upgrades.deployProxy(
      await ethers.getContractFactory("EVMAIAgentEscrow"),
      [
        await token.getAddress(),
        await agent.getAddress(),
        treasury.address,
        owner.address,
        FEE,
        FEE,
        FEE,
        FEE,
      ],
      { initializer: "initialize", kind: "uups" },
    );
    return { agent, escrow, owner, next, stranger, oracle, treasury };
  }

  async function sapphirePair() {
    const [owner, next, stranger, oracle, treasury] = await ethers.getSigners();
    const agent = await (
      await ethers.getContractFactory("SapphireAIAgent")
    ).deploy(DOMAIN, ROFL_APP_ID, oracle.address, owner.address);
    const escrow = await (
      await ethers.getContractFactory("SapphireAIAgentEscrow")
    ).deploy(await agent.getAddress(), treasury.address, owner.address, FEE, FEE, FEE, FEE);
    return { agent, escrow, owner, next, stranger, oracle, treasury };
  }

  const CONTRACTS = [
    { name: "EVMAIAgent", fixture: evmPair, pick: (f) => f.agent },
    { name: "EVMAIAgentEscrow", fixture: evmPair, pick: (f) => f.escrow },
    { name: "SapphireAIAgent", fixture: sapphirePair, pick: (f) => f.agent },
    { name: "SapphireAIAgentEscrow", fixture: sapphirePair, pick: (f) => f.escrow },
  ];

  for (const { name, fixture, pick } of CONTRACTS) {
    describe(name, function () {
      it("keeps its owner when ownership is offered, until the new owner accepts", async function () {
        const f = await loadFixture(fixture);
        const contract = pick(f);

        await expect(contract.connect(f.owner).transferOwnership(f.next.address))
          .to.emit(contract, "OwnershipTransferStarted")
          .withArgs(f.owner.address, f.next.address);

        expect(await contract.owner()).to.equal(f.owner.address);
        expect(await contract.pendingOwner()).to.equal(f.next.address);

        await expect(contract.connect(f.next).acceptOwnership())
          .to.emit(contract, "OwnershipTransferred")
          .withArgs(f.owner.address, f.next.address);

        expect(await contract.owner()).to.equal(f.next.address);
        expect(await contract.pendingOwner()).to.equal(ethers.ZeroAddress);
      });

      it("lets nobody but the address it was offered to accept", async function () {
        const f = await loadFixture(fixture);
        const contract = pick(f);
        await contract.connect(f.owner).transferOwnership(f.next.address);

        for (const other of [f.stranger, f.owner]) {
          await expect(contract.connect(other).acceptOwnership())
            .to.be.revertedWithCustomError(contract, "OwnableUnauthorizedAccount")
            .withArgs(other.address);
        }
      });

      it("lets the owner take an offer back by offering it to another address", async function () {
        const f = await loadFixture(fixture);
        const contract = pick(f);
        await contract.connect(f.owner).transferOwnership(f.stranger.address);

        await contract.connect(f.owner).transferOwnership(f.next.address);

        await expect(contract.connect(f.stranger).acceptOwnership()).to.be.revertedWithCustomError(
          contract,
          "OwnableUnauthorizedAccount",
        );
        await contract.connect(f.next).acceptOwnership();
        expect(await contract.owner()).to.equal(f.next.address);
      });

      it("refuses to give ownership up, from the owner and from anyone else", async function () {
        const f = await loadFixture(fixture);
        const contract = pick(f);

        await expect(contract.connect(f.owner).renounceOwnership()).to.be.revertedWithCustomError(
          contract,
          "OwnershipCannotBeRenounced",
        );
        await expect(contract.connect(f.stranger).renounceOwnership()).to.be.reverted;
        expect(await contract.owner()).to.equal(f.owner.address);
      });
    });
  }

  describe("what only the owner may do", function () {
    it("stays with the old owner of the agent until the offer is accepted, then moves", async function () {
      const { agent, owner, next, stranger } = await loadFixture(evmPair);
      await agent.connect(owner).transferOwnership(next.address);

      await expect(agent.connect(next).addOracle(stranger.address))
        .to.be.revertedWithCustomError(agent, "OwnableUnauthorizedAccount")
        .withArgs(next.address);
      await agent.connect(owner).addOracle(stranger.address);

      await agent.connect(next).acceptOwnership();

      await expect(agent.connect(owner).removeOracle(stranger.address))
        .to.be.revertedWithCustomError(agent, "OwnableUnauthorizedAccount")
        .withArgs(owner.address);
      await agent.connect(next).removeOracle(stranger.address);
    });

    it("stays with the old owner of the escrow until the offer is accepted, then moves", async function () {
      const { escrow, owner, next } = await loadFixture(evmPair);
      await escrow.connect(owner).transferOwnership(next.address);

      await expect(escrow.connect(next).setPromptFee(2n))
        .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount")
        .withArgs(next.address);

      await escrow.connect(next).acceptOwnership();

      await expect(escrow.connect(owner).setPromptFee(2n))
        .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount")
        .withArgs(owner.address);
      await escrow.connect(next).setPromptFee(2n);
      expect(await escrow.promptFee()).to.equal(2n);
    });

    it("includes the upgrade, which follows the accepted owner", async function () {
      const { agent, escrow, owner, next } = await loadFixture(evmPair);
      for (const [contract, v2] of [
        [agent, "EVMAIAgentV2"],
        [escrow, "EVMAIAgentEscrowV2"],
      ]) {
        await contract.connect(owner).transferOwnership(next.address);
        await contract.connect(next).acceptOwnership();

        await expect(
          upgrades.upgradeProxy(
            await contract.getAddress(),
            await ethers.getContractFactory(v2, owner),
          ),
        ).to.be.revertedWithCustomError(contract, "OwnableUnauthorizedAccount");
        await upgrades.upgradeProxy(
          await contract.getAddress(),
          await ethers.getContractFactory(v2, next),
        );
        expect(await contract.owner()).to.equal(next.address);
      }
    });
  });
});
