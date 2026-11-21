const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const { ethers } = require("hardhat");

const { forwardPhase, confirmPhase, readState } = require("../scripts/admin-rehearsal");
const { publishEncryptionKey } = require("./helpers/encryptionKeyProof");
const {
  PROMPT_FEE,
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

  // Revoking the role of the oracle that published the encryption key withdraws the key (the
  // agent's `_revokeRole`). Nothing reads that key today: the dApp encrypts to the key its build
  // names, and no prompt path reads it on chain, so removing the role stops nothing. The real
  // oracle does not publish its own key yet. The role is still removed; a snapshot that recorded
  // the signer's key then always differs on it.
  describe("when the signer published the encryption key", function () {
    const plainAdvice = "so the owner removes it before the handover";

    function expectKeyNote(text, signer) {
      expect(text).to.include(`The signer ${signer} holds the oracle role`);
      expect(text).to.include("is the agent's oracleEncryptionKeyPublisher");
      expect(text).to.include(`agent.removeOracle(${signer})`);
      expect(text).to.include("withdraws that key");
      expect(text).to.include("none does");
      expect(text).to.include("not built yet");
      expect(text).to.include("Remove the role all the same");
      expect(text).to.include("move that snapshot aside");
      expect(text).to.include("Never publish an encryption key from the deploy wallet");
      // Claims that are not true today.
      expect(text).to.not.include("no prompt can be submitted");
      expect(text).to.not.match(/stops? prompts/);
      expect(text).to.not.include("setOracleEncryptionKey(");
      expect(text).to.not.include("straight after");
      expect(text).to.not.include("Do not simply remove");
    }

    it("says in the forward phase what removing the role does to the key, and that it is still removed", async function () {
      const fixture = await loadRehearsal();
      await signerPublishesKey(fixture);

      await forward(fixture, { network: LIVE, dryRun: true });

      expectKeyNote(fixture.lines.join("\n"), fixture.deployer.address);
    });

    it("says the same when the confirm phase refuses for the signer's role", async function () {
      const fixture = await loadRehearsal();
      await signerPublishesKey(fixture);
      const snapshotFile = await confirmable(fixture, LIVE, await readState(fixture.contracts));

      const refused = await confirm(fixture, snapshotFile, LIVE).catch((error) => error);

      expect(refused.message).to.match(
        /not been fully returned[\s\S]*published the encryption key/,
      );
      expect(refused.message).to.include("withdraws that key");
      expect(refused.message).to.not.match(/stops? prompts/);
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
      expect(text).to.not.include("withdraws that key");
    });

    // The publisher is read again for the note. A node failing that read must not replace the
    // refusal with its own error, which can carry the RPC address.
    it("keeps the refusal, with no node error in it, when the publisher cannot be read", async function () {
      const fixture = await loadRehearsal();
      const snapshotFile = await confirmable(fixture, LIVE);
      await grantSignerRole(fixture);
      const failure = Object.assign(
        new Error("request to https://rpc.example/v2/not-a-real-key failed"),
        { code: "SERVER_ERROR" },
      );
      const aiAgent = new Proxy(fixture.contracts.aiAgent, {
        get(target, property) {
          if (property === "oracleEncryptionKeyPublisher") return () => Promise.reject(failure);
          return Reflect.get(target, property, target);
        },
      });
      fixture.lines = [];

      const refused = await confirmPhase({
        contracts: { ...fixture.contracts, aiAgent },
        signer: fixture.deployer,
        log: (line) => fixture.lines.push(String(line)),
        snapshotFile,
        network: LIVE,
        verify: async () => ({ ok: true, mismatches: [] }),
      }).catch((error) => error);

      expect(refused.message).to.match(/not been fully returned/);
      expect(refused.message).to.not.include("not-a-real-key");
      const text = fixture.lines.join("\n");
      expect(text).to.include(`agent.removeOracle(${fixture.deployer.address})`);
      expect(text).to.include("could not be read");
      expect(text).to.not.include("not-a-real-key");
    });
  });

  // A snapshot an earlier version wrote may watch the signer as the live oracle. The confirm
  // phase can never pass with it, so a resumed forward run on a live network sends only the
  // restores of sets already done, so no rehearsal value is left live, holds every other step,
  // and then refuses, naming what it sent and held.
  describe("a resumed forward run and a snapshot that watches the signer as the oracle", function () {
    async function resumable(fixture, steps) {
      const snapshotFile = scratch();
      const baseline = {
        ...fixture.state,
        oracle: fixture.deployer.address,
        oracleAuthorized: false,
      };
      fs.writeFileSync(
        snapshotFile,
        await snapshotText(fixture.contracts, baseline, fixture.safeContractAddress, {
          steps,
          network: LIVE,
        }),
      );
      return snapshotFile;
    }
    const feeSetDone = {
      "fee-set": { status: "done", txHash: `0x${"ef".repeat(32)}`, blockNumber: 1 },
    };
    const nonceOf = (fixture) => ethers.provider.getTransactionCount(fixture.deployer.address);
    const stepsIn = (file) => JSON.parse(fs.readFileSync(file, "utf8")).steps;

    it("sends the fee restore and nothing else, then refuses saying what it sent and held", async function () {
      const fixture = await loadRehearsal();
      const snapshotFile = await resumable(fixture, feeSetDone);
      await fixture.contracts.escrow.connect(fixture.deployer).setPromptFee(REHEARSAL_FEE);
      const nonce = await nonceOf(fixture);

      const refused = await forward(fixture, { snapshotFile, network: LIVE }).catch((e) => e);

      expect(refused.message).to.match(
        new RegExp(`watches the signer ${fixture.deployer.address} as the live oracle`),
      );
      expect(refused.message).to.match(/Sent: \[fee-restore\][\s\S]*Not sent: \[treasury-set\]/);
      expect(await nonceOf(fixture)).to.equal(nonce + 1);
      const { escrow, aiAgent } = fixture.contracts;
      expect(await escrow.promptFee()).to.equal(PROMPT_FEE);
      expect(await escrow.treasury()).to.equal(fixture.treasury.address);
      expect(await aiAgent.isOracle(fixture.safeContractAddress)).to.equal(false);
      expect(await aiAgent.pendingOwner()).to.equal(ethers.ZeroAddress);
      expect(Object.keys(stepsIn(snapshotFile)).sort()).to.deep.equal(["fee-restore", "fee-set"]);
    });

    it("predicts that in a dry run, and sends and writes nothing", async function () {
      const fixture = await loadRehearsal();
      const snapshotFile = await resumable(fixture, feeSetDone);
      await fixture.contracts.escrow.connect(fixture.deployer).setPromptFee(REHEARSAL_FEE);
      const before = fs.readFileSync(snapshotFile, "utf8");
      const nonce = await nonceOf(fixture);

      await expect(
        forward(fixture, { snapshotFile, network: LIVE, dryRun: true }),
      ).to.be.rejectedWith(/as the live oracle[\s\S]*Would send: \[fee-restore\]/);

      expect(await nonceOf(fixture)).to.equal(nonce);
      expect(await fixture.contracts.escrow.promptFee()).to.equal(REHEARSAL_FEE);
      expect(fs.readFileSync(snapshotFile, "utf8")).to.equal(before);
    });

    it("sends nothing when no set was done", async function () {
      const fixture = await loadRehearsal();
      const snapshotFile = await resumable(fixture, {});
      const nonce = await nonceOf(fixture);

      const refused = await forward(fixture, { snapshotFile, network: LIVE }).catch((e) => e);

      expect(refused.message).to.match(/as the live oracle[\s\S]*Nothing was sent/);
      expect(refused.message).to.not.include("once these restores are done");
      expect(await nonceOf(fixture)).to.equal(nonce);
      expect(stepsIn(snapshotFile)).to.deep.equal({});
    });

    it("refuses while the wallet has a transaction pending, before deciding anything", async function () {
      const fixture = await loadRehearsal();
      const snapshotFile = await resumable(fixture, {});
      await ethers.provider.send("evm_setAutomine", [false]);
      try {
        await fixture.deployer.sendTransaction({ to: fixture.deployer.address, value: 0 });
        await expect(forward(fixture, { snapshotFile, network: LIVE })).to.be.rejectedWith(
          /waiting to be mined/,
        );
      } finally {
        await ethers.provider.send("evm_setAutomine", [true]);
        await ethers.provider.send("evm_mine", []);
      }
    });

    it("resumes on a local network, where the signer is the oracle on purpose", async function () {
      const fixture = await loadRehearsal();
      const snapshotFile = scratch();
      const done = { status: "done", txHash: `0x${"ef".repeat(32)}`, blockNumber: 1 };
      const baseline = {
        ...fixture.state,
        oracle: fixture.deployer.address,
        oracleAuthorized: false,
      };
      fs.writeFileSync(
        snapshotFile,
        await snapshotText(fixture.contracts, baseline, fixture.safeContractAddress, {
          steps: { "fee-set": done },
        }),
      );
      await fixture.contracts.escrow.connect(fixture.deployer).setPromptFee(REHEARSAL_FEE);

      await forward(fixture, { snapshotFile });

      expect(await fixture.contracts.escrow.promptFee()).to.equal(PROMPT_FEE);
    });
  });
});
