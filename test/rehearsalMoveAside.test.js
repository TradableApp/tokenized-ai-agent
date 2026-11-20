const { expect } = require("chai");
const { ethers } = require("hardhat");
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

// Two ways a rehearsal can be stuck with no way forward in the script, and one setup it cannot
// check: each refusal says what to do.
describe("the rehearsal's way out of a snapshot it cannot finish", function () {
  after(removeScratchDirs);

  const scratch = () => path.join(scratchDir("rehearsal-aside-"), "snapshot.json");
  const done = (n) => ({ status: "done", txHash: `0x${n.repeat(32)}`, blockNumber: 1 });
  const EVERY_STEP_DONE = Object.freeze({
    "fee-set": done("b1"),
    "fee-restore": done("b2"),
    "treasury-set": done("b3"),
    "treasury-restore": done("b4"),
    "oracle-add": done("b5"),
    "oracle-remove": done("b6"),
    ...OFFERS_DONE,
  });

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

  async function writeSnapshot(fixture, state, steps) {
    const snapshotFile = scratch();
    fs.writeFileSync(
      snapshotFile,
      await snapshotText(fixture.contracts, state, fixture.safeContractAddress, { steps }),
    );
    return snapshotFile;
  }

  const confirm = (fixture, snapshotFile) =>
    confirmPhase({
      contracts: fixture.contracts,
      signer: fixture.deployer,
      log: fixture.log,
      snapshotFile,
    });

  // Its role is compared before and after, and on a live network the signer's own role is one
  // the owner removes: the same address cannot be watched for both. On a local network the
  // deploy wallet is the oracle as well, on purpose.
  const LIVE = "baseSepolia";

  for (const dryRun of [false, true]) {
    it(`refuses on a live network a live oracle that is the signer itself, before anything is sent or written (dryRun=${dryRun})`, async function () {
      const fixture = await loadRehearsal();
      const snapshotFile = scratch();
      const nonce = await ethers.provider.getTransactionCount(fixture.deployer.address);
      const contracts = { ...fixture.contracts, oracleAddress: fixture.deployer.address };

      await expect(
        forward(fixture, { contracts, snapshotFile, dryRun, network: LIVE }),
      ).to.be.rejectedWith(/REHEARSAL_ORACLE_ADDRESS is the signer[\s\S]*Nothing was sent/);

      expect(fs.existsSync(snapshotFile)).to.equal(false);
      expect(await ethers.provider.getTransactionCount(fixture.deployer.address)).to.equal(nonce);
    });
  }

  it("takes the signer as the live oracle on a local network", async function () {
    const fixture = await loadRehearsal();
    await fixture.contracts.aiAgent.connect(fixture.deployer).addOracle(fixture.deployer.address);
    const contracts = { ...fixture.contracts, oracleAddress: fixture.deployer.address };

    await forward(fixture, { contracts });

    expect(await fixture.contracts.aiAgent.pendingOwner()).to.equal(fixture.safeContractAddress);
  });

  // A snapshot an earlier version wrote may watch the signer. The ownership the Safe offered
  // back is accepted first, so it is never left open, and then the snapshot is reported.
  it("accepts the ownership offered back, then refuses on a live network a snapshot that watches the signer", async function () {
    const fixture = await loadRehearsal();
    const { aiAgent } = fixture.contracts;
    const { deployer, safe } = fixture;
    const state = { ...fixture.state, oracle: deployer.address, oracleAuthorized: false };
    const snapshotFile = scratch();
    fs.writeFileSync(
      snapshotFile,
      await snapshotText(fixture.contracts, state, safe.address, {
        steps: OFFERS_DONE,
        network: LIVE,
      }),
    );
    await aiAgent.connect(deployer).transferOwnership(safe.address);
    await aiAgent.connect(safe).acceptOwnership();
    await aiAgent.connect(safe).transferOwnership(deployer.address);

    await expect(
      confirmPhase({
        contracts: fixture.contracts,
        signer: deployer,
        log: fixture.log,
        snapshotFile,
        network: LIVE,
      }),
    ).to.be.rejectedWith(/snapshot at [\s\S]*watches the signer[\s\S]*move the snapshot aside/);

    expect(await aiAgent.owner()).to.equal(deployer.address);
    expect(await aiAgent.pendingOwner()).to.equal(ethers.ZeroAddress);
    expect(JSON.parse(fs.readFileSync(snapshotFile, "utf8")).confirmed).to.equal(false);
  });

  it("confirms on a local network a snapshot that watches the signer", async function () {
    const fixture = await loadRehearsal();
    const state = { ...fixture.state, oracle: fixture.deployer.address, oracleAuthorized: false };
    const snapshotFile = await writeSnapshot(fixture, state, OFFERS_DONE);

    await confirm(fixture, snapshotFile);

    expect(JSON.parse(fs.readFileSync(snapshotFile, "utf8")).confirmed).to.equal(true);
  });

  it("says to move the snapshot aside when the confirm phase fails on a value changed since", async function () {
    const fixture = await loadRehearsal();
    const snapshotFile = await writeSnapshot(fixture, fixture.state, OFFERS_DONE);
    await fixture.contracts.escrow.connect(fixture.deployer).setPromptFee(ethers.parseEther("7"));

    await expect(confirm(fixture, snapshotFile)).to.be.rejectedWith(
      /not been fully returned[\s\S]*changed on purpose[\s\S]*move the snapshot aside/,
    );
    expect(JSON.parse(fs.readFileSync(snapshotFile, "utf8")).confirmed).to.equal(false);
  });

  // The confirm phase accepted the ownership back and then failed on a changed value: the
  // forward run finds its offers recorded done and no offer open.
  it("says to move the snapshot aside when a forward run finds a returned rehearsal it cannot resume", async function () {
    const fixture = await loadRehearsal();
    const snapshotFile = await writeSnapshot(fixture, fixture.state, EVERY_STEP_DONE);
    const nonce = await ethers.provider.getTransactionCount(fixture.deployer.address);

    await expect(forward(fixture, { snapshotFile })).to.be.rejectedWith(
      /no ownership offer is open[\s\S]*move the snapshot aside/,
    );
    expect(await ethers.provider.getTransactionCount(fixture.deployer.address)).to.equal(nonce);
  });
});
