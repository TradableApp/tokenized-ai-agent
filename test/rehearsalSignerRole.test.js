const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const { forwardPhase, confirmPhase } = require("../scripts/admin-rehearsal");
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

  async function confirmable(fixture, network) {
    const snapshotFile = scratch();
    fs.writeFileSync(
      snapshotFile,
      await snapshotText(fixture.contracts, fixture.state, fixture.safeContractAddress, {
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
});
