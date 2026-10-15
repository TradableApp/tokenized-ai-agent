const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  readState,
  buildPlan,
  runPlan,
  buildSafeReturnTxs,
  verifyReturned,
  parseRehearsalFee,
  forwardPhase,
} = require("../scripts/admin-rehearsal");

describe("scripts/admin-rehearsal", function () {
  const DOMAIN = "tradable.app";
  const PROMPT_FEE = ethers.parseEther("1");
  const REHEARSAL_FEE = ethers.parseEther("2");

  async function deployFixture() {
    const [deployer, oracle, treasury, safe, stranger] = await ethers.getSigners();

    const token = await (await ethers.getContractFactory("MockAbleToken")).deploy();
    await token.waitForDeployment();

    const aiAgent = await upgrades.deployProxy(
      await ethers.getContractFactory("EVMAIAgent"),
      [DOMAIN, oracle.address, deployer.address],
      { initializer: "initialize", kind: "uups" },
    );
    await aiAgent.waitForDeployment();

    const escrow = await upgrades.deployProxy(
      await ethers.getContractFactory("EVMAIAgentEscrow"),
      [
        await token.getAddress(),
        await aiAgent.getAddress(),
        treasury.address,
        deployer.address,
        PROMPT_FEE,
        ethers.parseEther("0.1"),
        ethers.parseEther("0.1"),
        ethers.parseEther("0.5"),
      ],
      { initializer: "initialize", kind: "uups" },
    );
    await escrow.waitForDeployment();
    await aiAgent.connect(deployer).setAgentEscrow(await escrow.getAddress());

    const contracts = { aiAgent, escrow };
    const state = await readState(contracts);
    const lines = [];
    const log = (line) => lines.push(String(line));
    return { contracts, state, lines, log, deployer, oracle, treasury, safe, stranger };
  }

  describe("readState", function () {
    it("captures the live owner, oracle, treasury and prompt fee", async function () {
      const { state, deployer, oracle, treasury } = await loadFixture(deployFixture);

      expect(state.agentOwner).to.equal(deployer.address);
      expect(state.escrowOwner).to.equal(deployer.address);
      expect(state.oracle).to.equal(oracle.address);
      expect(state.treasury).to.equal(treasury.address);
      expect(state.promptFee).to.equal(PROMPT_FEE);
    });
  });

  describe("buildPlan", function () {
    it("orders set-and-restore pairs before the ownership transfers", async function () {
      const { state, safe, oracle, treasury } = await loadFixture(deployFixture);

      const plan = buildPlan({
        state,
        safeAddress: safe.address,
        rehearsalPromptFee: REHEARSAL_FEE,
      });

      expect(plan.map((s) => `${s.contract}.${s.method}`)).to.deep.equal([
        "escrow.setPromptFee",
        "escrow.setPromptFee",
        "escrow.setTreasury",
        "escrow.setTreasury",
        "agent.setOracle",
        "agent.setOracle",
        "agent.transferOwnership",
        "escrow.transferOwnership",
      ]);
      expect(plan[0].args).to.deep.equal([REHEARSAL_FEE]);
      expect(plan[1].args).to.deep.equal([PROMPT_FEE]);
      expect(plan[2].args).to.deep.equal([safe.address]);
      expect(plan[3].args).to.deep.equal([treasury.address]);
      expect(plan[4].args).to.deep.equal([safe.address]);
      expect(plan[5].args).to.deep.equal([oracle.address]);
      expect(plan[6].args).to.deep.equal([safe.address]);
      expect(plan[7].args).to.deep.equal([safe.address]);
    });

    it("pairs every step with the event and getter that prove it", async function () {
      const { state, safe, deployer } = await loadFixture(deployFixture);

      const plan = buildPlan({
        state,
        safeAddress: safe.address,
        rehearsalPromptFee: REHEARSAL_FEE,
      });

      expect(plan[0].event).to.deep.equal({ name: "PromptFeeUpdated", args: [REHEARSAL_FEE] });
      expect(plan[0].verify).to.deep.equal({ getter: "promptFee", expected: REHEARSAL_FEE });
      expect(plan[2].event).to.deep.equal({ name: "TreasuryUpdated", args: [safe.address] });
      expect(plan[4].event).to.deep.equal({ name: "OracleUpdated", args: [safe.address] });
      expect(plan[6].event).to.deep.equal({
        name: "OwnershipTransferred",
        args: [deployer.address, safe.address],
      });
      expect(plan[6].verify).to.deep.equal({ getter: "owner", expected: safe.address });
      expect(plan[7].event).to.deep.equal({
        name: "OwnershipTransferred",
        args: [deployer.address, safe.address],
      });
    });

    it("rejects a Safe address that is zero, malformed or already the owner", async function () {
      const { state, deployer } = await loadFixture(deployFixture);

      expect(() =>
        buildPlan({ state, safeAddress: ethers.ZeroAddress, rehearsalPromptFee: REHEARSAL_FEE }),
      ).to.throw(/safe/i);
      expect(() =>
        buildPlan({ state, safeAddress: "0x1234", rehearsalPromptFee: REHEARSAL_FEE }),
      ).to.throw(/safe/i);
      expect(() =>
        buildPlan({ state, safeAddress: deployer.address, rehearsalPromptFee: REHEARSAL_FEE }),
      ).to.throw(/already/i);
    });

    it("rejects a rehearsal fee equal to the live fee", async function () {
      const { state, safe } = await loadFixture(deployFixture);

      expect(() =>
        buildPlan({ state, safeAddress: safe.address, rehearsalPromptFee: PROMPT_FEE }),
      ).to.throw(/fee/i);
    });
  });

  describe("runPlan (dry run)", function () {
    it("prints every call and expected event without changing state", async function () {
      const { contracts, state, lines, log, deployer, safe } = await loadFixture(deployFixture);
      const plan = buildPlan({
        state,
        safeAddress: safe.address,
        rehearsalPromptFee: REHEARSAL_FEE,
      });

      const results = await runPlan({ plan, contracts, signer: deployer, dryRun: true, log });

      expect(results).to.have.length(8);
      expect(results.every((r) => r.txHash === null)).to.equal(true);
      const joined = lines.join("\n");
      for (const step of plan) {
        expect(joined).to.include(step.method);
        expect(joined).to.include(step.event.name);
      }
      expect(joined).to.match(/0x[0-9a-f]{8}/i);
      expect(await contracts.escrow.promptFee()).to.equal(PROMPT_FEE);
      expect(await contracts.aiAgent.owner()).to.equal(deployer.address);
      expect(await contracts.escrow.owner()).to.equal(deployer.address);
    });

    it("fails on the first step the signer could not execute", async function () {
      const { contracts, state, log, stranger, safe } = await loadFixture(deployFixture);
      const plan = buildPlan({
        state,
        safeAddress: safe.address,
        rehearsalPromptFee: REHEARSAL_FEE,
      });

      await expect(
        runPlan({ plan, contracts, signer: stranger, dryRun: true, log }),
      ).to.be.rejectedWith(/escrow\.setPromptFee/);
    });
  });

  describe("runPlan (live)", function () {
    it("executes, proves each event and getter, and leaves fees restored and ownership with the Safe", async function () {
      const { contracts, state, log, deployer, oracle, treasury, safe } =
        await loadFixture(deployFixture);
      const plan = buildPlan({
        state,
        safeAddress: safe.address,
        rehearsalPromptFee: REHEARSAL_FEE,
      });

      const results = await runPlan({ plan, contracts, signer: deployer, dryRun: false, log });

      expect(results.map((r) => r.id)).to.deep.equal(plan.map((s) => s.id));
      expect(results.every((r) => /^0x[0-9a-f]{64}$/.test(r.txHash))).to.equal(true);
      expect(await contracts.escrow.promptFee()).to.equal(PROMPT_FEE);
      expect(await contracts.escrow.treasury()).to.equal(treasury.address);
      expect(await contracts.aiAgent.oracle()).to.equal(oracle.address);
      expect(await contracts.aiAgent.owner()).to.equal(safe.address);
      expect(await contracts.escrow.owner()).to.equal(safe.address);
    });

    it("rejects when the emitted event does not match the plan", async function () {
      const { contracts, state, log, deployer, safe } = await loadFixture(deployFixture);
      const plan = buildPlan({
        state,
        safeAddress: safe.address,
        rehearsalPromptFee: REHEARSAL_FEE,
      });
      const tampered = [{ ...plan[0], event: { name: "PromptFeeUpdated", args: [PROMPT_FEE] } }];

      await expect(
        runPlan({ plan: tampered, contracts, signer: deployer, dryRun: false, log }),
      ).to.be.rejectedWith(/PromptFeeUpdated/);
    });
  });

  describe("buildSafeReturnTxs", function () {
    it("encodes transferOwnership back to the deploy wallet for both proxies", async function () {
      const { contracts, deployer } = await loadFixture(deployFixture);

      const txs = await buildSafeReturnTxs({ contracts, returnTo: deployer.address });

      const agentData = contracts.aiAgent.interface.encodeFunctionData("transferOwnership", [
        deployer.address,
      ]);
      const escrowData = contracts.escrow.interface.encodeFunctionData("transferOwnership", [
        deployer.address,
      ]);
      expect(txs).to.deep.equal([
        { to: await contracts.aiAgent.getAddress(), value: "0", data: agentData },
        { to: await contracts.escrow.getAddress(), value: "0", data: escrowData },
      ]);
    });
  });

  describe("verifyReturned", function () {
    it("reports the mismatches while the Safe still owns the proxies, then passes once returned", async function () {
      const { contracts, state, log, deployer, safe } = await loadFixture(deployFixture);
      const plan = buildPlan({
        state,
        safeAddress: safe.address,
        rehearsalPromptFee: REHEARSAL_FEE,
      });
      await runPlan({ plan, contracts, signer: deployer, dryRun: false, log });

      const before = await verifyReturned({ contracts, state });
      expect(before.ok).to.equal(false);
      expect(before.mismatches.map((m) => m.field).sort()).to.deep.equal([
        "agentOwner",
        "escrowOwner",
      ]);

      await contracts.aiAgent.connect(safe).transferOwnership(deployer.address);
      await contracts.escrow.connect(safe).transferOwnership(deployer.address);

      const after = await verifyReturned({ contracts, state });
      expect(after).to.deep.equal({ ok: true, mismatches: [] });
    });
  });

  describe("parseRehearsalFee", function () {
    it("reads a human token amount and defaults to 2 tokens", function () {
      expect(parseRehearsalFee("3")).to.equal(ethers.parseEther("3"));
      expect(parseRehearsalFee("0.5")).to.equal(ethers.parseEther("0.5"));
      expect(parseRehearsalFee(undefined)).to.equal(ethers.parseEther("2"));
      expect(parseRehearsalFee("")).to.equal(ethers.parseEther("2"));
    });
  });

  describe("forwardPhase", function () {
    function scratchSnapshot() {
      return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rehearsal-")), "snapshot.json");
    }

    it("writes the pre-rehearsal snapshot before the first transaction is sent", async function () {
      const { contracts, state, log, stranger, safe } = await loadFixture(deployFixture);
      const snapshotFile = scratchSnapshot();

      await expect(
        forwardPhase({
          contracts,
          signer: stranger,
          dryRun: false,
          log,
          safeAddress: safe.address,
          rehearsalPromptFee: REHEARSAL_FEE,
          snapshotFile,
        }),
      ).to.be.rejectedWith(/fee-set/);

      const saved = JSON.parse(fs.readFileSync(snapshotFile, "utf8"));
      expect(saved).to.deep.equal({
        agentOwner: state.agentOwner,
        escrowOwner: state.escrowOwner,
        oracle: state.oracle,
        treasury: state.treasury,
        promptFee: String(state.promptFee),
      });
    });

    it("writes no snapshot on a dry run", async function () {
      const { contracts, log, deployer, safe } = await loadFixture(deployFixture);
      const snapshotFile = scratchSnapshot();

      await forwardPhase({
        contracts,
        signer: deployer,
        dryRun: true,
        log,
        safeAddress: safe.address,
        rehearsalPromptFee: REHEARSAL_FEE,
        snapshotFile,
      });

      expect(fs.existsSync(snapshotFile)).to.equal(false);
    });
  });
});
