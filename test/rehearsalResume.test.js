const { expect } = require("chai");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const { findLeftovers } = require("../scripts/rehearsal/resume");
const { REHEARSAL_FEE, deployRehearsalFixture } = require("./helpers/rehearsalFixture");

describe("scripts/rehearsal/resume", function () {
  describe("findLeftovers", function () {
    async function leftovers(fixture) {
      return findLeftovers({
        contracts: fixture.contracts,
        safe: fixture.safe.address,
        rehearsalPromptFee: REHEARSAL_FEE,
      });
    }

    it("finds nothing on a pair no rehearsal has touched", async function () {
      const fixture = await loadFixture(deployRehearsalFixture);

      expect(await leftovers(fixture)).to.deep.equal([]);
    });

    it("finds the fee left at the rehearsal fee", async function () {
      const fixture = await loadFixture(deployRehearsalFixture);
      await fixture.contracts.escrow.connect(fixture.deployer).setPromptFee(REHEARSAL_FEE);

      const found = await leftovers(fixture);

      expect(found).to.have.lengthOf(1);
      expect(found[0]).to.match(/promptFee\(\) is the rehearsal fee/);
    });

    it("finds the Safe left as the treasury", async function () {
      const fixture = await loadFixture(deployRehearsalFixture);
      await fixture.contracts.escrow.connect(fixture.deployer).setTreasury(fixture.safe.address);

      const found = await leftovers(fixture);

      expect(found).to.have.lengthOf(1);
      expect(found[0]).to.match(/treasury\(\) is the Safe/);
    });

    it("finds the Safe left holding the oracle role", async function () {
      const fixture = await loadFixture(deployRehearsalFixture);
      await fixture.contracts.aiAgent.connect(fixture.deployer).addOracle(fixture.safe.address);

      const found = await leftovers(fixture);

      expect(found).to.have.lengthOf(1);
      expect(found[0]).to.match(/Safe holds the oracle role/);
    });

    it("finds an ownership offer left open, to anyone", async function () {
      const fixture = await loadFixture(deployRehearsalFixture);
      await fixture.contracts.escrow
        .connect(fixture.deployer)
        .transferOwnership(fixture.stranger.address);

      const found = await leftovers(fixture);

      expect(found).to.have.lengthOf(1);
      expect(found[0]).to.match(/escrow has an ownership offer open/);
    });

    it("finds a proxy the Safe owns", async function () {
      const fixture = await loadFixture(deployRehearsalFixture);
      await fixture.contracts.aiAgent
        .connect(fixture.deployer)
        .transferOwnership(fixture.safe.address);
      await fixture.contracts.aiAgent.connect(fixture.safe).acceptOwnership();

      const found = await leftovers(fixture);

      expect(found).to.have.lengthOf(1);
      expect(found[0]).to.match(/Safe owns the agent/);
    });
  });
});
