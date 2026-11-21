const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const { ethers } = require("hardhat");

const { forwardPhase, confirmPhase, readState } = require("../scripts/admin-rehearsal");
const { publishEncryptionKey } = require("./helpers/encryptionKeyProof");
const {
  REHEARSAL_FEE,
  OFFERS_DONE,
  snapshotText,
  loadRehearsal,
  scratchFolders,
} = require("./helpers/rehearsalFixture");

const { scratchDir, removeScratchDirs } = scratchFolders();

// The deploy wallet is given the oracle role when the pair is deployed. Once ownership is handed
// over, only the new owner can take it away. On a live network the rehearsal says whether the
// signer still holds it, and the confirm phase does not pass while it does; the removal itself
// is left to the owner.
describe("the rehearsal and the signer's own oracle role", function () {
  after(removeScratchDirs);

  const LIVE = "baseSepolia";
  const scratch = () => path.join(scratchDir("rehearsal-role-"), "snapshot.json");
  const oracleRole = () => require("../scripts/rehearsal/oracleRole"); // eslint-disable-line global-require

  function forward(fixture, overrides = {}) {
    fixture.lines = [];
    return forwardPhase({
      contracts: fixture.contracts,
      signer: fixture.deployer,
      dryRun: false,
      log: (line) => fixture.lines.push(String(line)),
      safeAddress: fixture.safeContractAddress,
      rehearsalPromptFee: REHEARSAL_FEE,
      snapshotFile: scratch(),
      ...overrides,
    });
  }

  async function confirmable(fixture, network, state = fixture.state) {
    const snapshotFile = scratch();
    fs.writeFileSync(
      snapshotFile,
      await snapshotText(fixture.contracts, state, fixture.safeContractAddress, {
        steps: OFFERS_DONE,
        network,
      }),
    );
    return snapshotFile;
  }

  function confirm(fixture, snapshotFile, network) {
    fixture.lines = [];
    return confirmPhase({
      contracts: fixture.contracts,
      signer: fixture.deployer,
      log: (line) => fixture.lines.push(String(line)),
      snapshotFile,
      network,
    });
  }

  const grantSignerRole = (fixture) =>
    fixture.contracts.aiAgent.connect(fixture.deployer).addOracle(fixture.deployer.address);
  // The signer publishes the encryption key clients encrypt to, as the deploy wallet would if
  // it had been run as the oracle.
  const signerPublishesKey = async (fixture) => {
    await grantSignerRole(fixture);
    const key = new ethers.SigningKey(ethers.id("rehearsal-signer-encryption-key"));
    await publishEncryptionKey(fixture.contracts.aiAgent, fixture.deployer, key);
  };
  const confirmedIn = (file) => JSON.parse(fs.readFileSync(file, "utf8")).confirmed;

  it("counts every network but the local ones as live", function () {
    const { isLiveNetwork } = oracleRole();
    for (const network of ["hardhat", "localhost", "localnet"]) {
      expect(isLiveNetwork(network), network).to.equal(false);
    }
    for (const network of ["baseSepolia", "base", "a-network-added-later"]) {
      expect(isLiveNetwork(network), network).to.equal(true);
    }
  });

  it("says on a live network that the signer holds the oracle role, how it is removed, and goes on", async function () {
    const fixture = await loadRehearsal();
    await grantSignerRole(fixture);

    await forward(fixture, { network: LIVE });

    const text = fixture.lines.join("\n");
    expect(text).to.include(`The signer ${fixture.deployer.address} holds the oracle role`);
    expect(text).to.include(`agent.removeOracle(${fixture.deployer.address})`);
    expect(await fixture.contracts.aiAgent.pendingOwner()).to.equal(fixture.safeContractAddress);
  });

  it("says on a live network that the signer does not hold the oracle role", async function () {
    const fixture = await loadRehearsal();

    await forward(fixture, { network: LIVE, dryRun: true });

    expect(fixture.lines.join("\n")).to.include(
      `The signer ${fixture.deployer.address} does not hold the oracle role`,
    );
  });

  // On a local network the deploy wallet is the oracle as well, on purpose.
  it("says nothing of the signer's role on a local network", async function () {
    const fixture = await loadRehearsal();
    await grantSignerRole(fixture);

    await forward(fixture);

    expect(fixture.lines.join("\n")).to.not.match(/The signer \S+ (holds|does not hold)/);
  });

  it("does not pass the confirm phase on a live network while the signer holds the oracle role", async function () {
    const fixture = await loadRehearsal();
    const snapshotFile = await confirmable(fixture, LIVE);
    await grantSignerRole(fixture);

    await expect(confirm(fixture, snapshotFile, LIVE)).to.be.rejectedWith(
      /not been fully returned/,
    );

    const text = fixture.lines.join("\n");
    expect(text).to.include("signerIsOracle: expected false, actual true");
    expect(text).to.include(`agent.removeOracle(${fixture.deployer.address})`);
    expect(confirmedIn(snapshotFile)).to.equal(false);

    await fixture.contracts.aiAgent
      .connect(fixture.deployer)
      .removeOracle(fixture.deployer.address);
    await confirm(fixture, snapshotFile, LIVE);
    expect(confirmedIn(snapshotFile)).to.equal(true);
  });

  it("passes the confirm phase on a local network with the signer holding the role", async function () {
    const fixture = await loadRehearsal();
    const snapshotFile = await confirmable(fixture, "hardhat");
    await grantSignerRole(fixture);

    await confirm(fixture, snapshotFile, "hardhat");

    expect(confirmedIn(snapshotFile)).to.equal(true);
  });

  // Revoking the role of the oracle that published the encryption key withdraws the key, and
  // no prompt can be submitted until an oracle publishes one. Another oracle cannot replace the
  // signer's key while it is published, so the removal cannot simply be advised.
  describe("when the signer published the encryption key", function () {
    const plainAdvice = "so the owner removes it before the handover";

    function expectKeyNote(text, signer) {
      expect(text).to.include(`The signer ${signer} holds the oracle role`);
      expect(text).to.include("published the encryption key");
      expect(text).to.include("would withdraw that key");
      expect(text).to.include("EncryptionKeyHeldByAnotherOracle");
      expect(text).to.include("agent.setOracleEncryptionKey(");
      expect(text).to.not.include(plainAdvice);
    }

    it("does not advise the removal as is in the forward phase, and says what removing it does", async function () {
      const fixture = await loadRehearsal();
      await signerPublishesKey(fixture);

      await forward(fixture, { network: LIVE, dryRun: true });

      expectKeyNote(fixture.lines.join("\n"), fixture.deployer.address);
    });

    it("says the same when the confirm phase refuses for the signer's role", async function () {
      const fixture = await loadRehearsal();
      await signerPublishesKey(fixture);
      const snapshotFile = await confirmable(fixture, LIVE, await readState(fixture.contracts));

      await expect(confirm(fixture, snapshotFile, LIVE)).to.be.rejectedWith(
        /not been fully returned[\s\S]*published the encryption key/,
      );

      expectKeyNote(fixture.lines.join("\n"), fixture.deployer.address);
      expect(confirmedIn(snapshotFile)).to.equal(false);
    });

    it("still gives the plain advice when another oracle published the key", async function () {
      const fixture = await loadRehearsal();
      await grantSignerRole(fixture);
      const key = new ethers.SigningKey(ethers.id("rehearsal-oracle-encryption-key"));
      await publishEncryptionKey(fixture.contracts.aiAgent, fixture.oracle, key);

      await forward(fixture, { network: LIVE, dryRun: true });

      const text = fixture.lines.join("\n");
      expect(text).to.include(plainAdvice);
      expect(text).to.not.include("would withdraw that key");
    });
  });
});
