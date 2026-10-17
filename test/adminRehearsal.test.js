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
  confirmPhase,
  assertMainnetConfirmed,
  findEvent,
  verifyGetter,
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

    const safeContract = await (await ethers.getContractFactory("MockAbleToken")).deploy();
    await safeContract.waitForDeployment();
    const safeContractAddress = await safeContract.getAddress();

    const contracts = { aiAgent, escrow };
    const state = await readState(contracts);
    const lines = [];
    const log = (line) => lines.push(String(line));
    return {
      contracts,
      state,
      lines,
      log,
      deployer,
      oracle,
      treasury,
      safe,
      safeContractAddress,
      stranger,
    };
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
    it("names the failed step and the recovery path when a live call reverts", async function () {
      const fixture = await loadFixture(deployFixture);
      const plan = buildPlan({
        state: fixture.state,
        safeAddress: fixture.safeContractAddress,
        rehearsalPromptFee: REHEARSAL_FEE,
      });

      await expect(
        runPlan({
          plan,
          contracts: fixture.contracts,
          signer: fixture.stranger,
          dryRun: false,
          log: fixture.log,
        }),
      ).to.be.rejectedWith(/\[fee-set\][\s\S]*REHEARSAL_PHASE=confirm/);
    });

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

    it("skips a step whose getter already holds its target, so a partial run can be resumed", async function () {
      // The live run on Base Sepolia stopped after fee-set had landed (a lagging public RPC node
      // served the read-back). Re-running from the SAME baseline must not re-prove fee-set and
      // must still restore the fee and finish the ownership hand-over.
      const { contracts, state, deployer, safe } = await loadFixture(deployFixture);
      await contracts.escrow.connect(deployer).setPromptFee(REHEARSAL_FEE);
      const lines = [];
      const plan = buildPlan({ state, safeAddress: safe.address, rehearsalPromptFee: REHEARSAL_FEE });

      const results = await runPlan({
        plan,
        contracts,
        signer: deployer,
        dryRun: false,
        log: (l) => lines.push(String(l)),
      });

      const feeSet = results.find((r) => r.id === "fee-set");
      expect(feeSet).to.deep.include({ txHash: null, skipped: true });
      expect(lines.some((l) => l.includes("[fee-set]") || l.includes("already"))).to.equal(true);
      expect(results.filter((r) => r.skipped)).to.have.length(1);
      expect(await contracts.escrow.promptFee()).to.equal(PROMPT_FEE);
      expect(await contracts.aiAgent.owner()).to.equal(safe.address);
      expect(await contracts.escrow.owner()).to.equal(safe.address);
    });
  });

  describe("verifyGetter", function () {
    const stepDef = {
      id: "fee-set",
      verify: { getter: "promptFee", expected: REHEARSAL_FEE },
    };
    const receipt = { blockNumber: 4242 };

    it("reads at the receipt's block and retries past a stale node before failing", async function () {
      // A load-balanced public RPC can answer the read-back from a node that has not seen the
      // block the receipt came from. One stale answer must not fail a rehearsal whose tx landed.
      const seen = [];
      let calls = 0;
      const target = {
        promptFee: async (overrides) => {
          seen.push(overrides);
          calls += 1;
          if (calls === 1) throw new Error("header not found");
          if (calls === 2) return PROMPT_FEE; // stale
          return REHEARSAL_FEE;
        },
      };
      const naps = [];

      await verifyGetter(target, stepDef, receipt, { attempts: 5, sleep: async (ms) => naps.push(ms) });

      expect(calls).to.equal(3);
      expect(seen[0]).to.deep.equal({ blockTag: 4242 });
      expect(naps).to.have.length(2);
    });

    it("names the step and the attempts when every read disagrees", async function () {
      const target = { promptFee: async () => PROMPT_FEE };

      await expect(
        verifyGetter(target, stepDef, receipt, { attempts: 3, sleep: async () => {} }),
      ).to.be.rejectedWith(/\[fee-set\][\s\S]*3 attempts/);
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

    it("rejects a value that is not a token amount with an operator-facing message", function () {
      expect(() => parseRehearsalFee("2ABLE")).to.throw(/REHEARSAL_PROMPT_FEE.*whole tokens/);
    });
  });

  describe("forwardPhase", function () {
    function scratchSnapshot() {
      return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rehearsal-")), "snapshot.json");
    }

    function run(fixture, overrides) {
      fixture.lines = [];
      return forwardPhase({
        contracts: fixture.contracts,
        signer: fixture.deployer,
        dryRun: false,
        log: (line) => fixture.lines.push(String(line)),
        safeAddress: fixture.safeContractAddress,
        rehearsalPromptFee: REHEARSAL_FEE,
        snapshotFile: scratchSnapshot(),
        ...overrides,
      });
    }

    it("writes the pre-rehearsal snapshot before the first transaction is sent", async function () {
      const fixture = await loadFixture(deployFixture);
      const snapshotFile = scratchSnapshot();

      await run(fixture, { snapshotFile });

      const savedAt = fixture.lines.findIndex((l) => l.includes("Pre-rehearsal state saved"));
      const firstStepAt = fixture.lines.findIndex((l) => l.includes("[fee-set]"));
      expect(savedAt).to.be.greaterThan(-1);
      expect(savedAt).to.be.lessThan(firstStepAt);
      const saved = JSON.parse(fs.readFileSync(snapshotFile, "utf8"));
      expect(saved).to.deep.equal({
        agentOwner: fixture.state.agentOwner,
        escrowOwner: fixture.state.escrowOwner,
        oracle: fixture.state.oracle,
        treasury: fixture.state.treasury,
        promptFee: String(fixture.state.promptFee),
      });
      expect(await fixture.contracts.aiAgent.owner()).to.equal(fixture.safeContractAddress);
    });

    it("writes no snapshot on a dry run", async function () {
      const fixture = await loadFixture(deployFixture);
      const snapshotFile = scratchSnapshot();

      await run(fixture, { dryRun: true, snapshotFile });

      expect(fs.existsSync(snapshotFile)).to.equal(false);
    });

    it("refuses before any transaction when the signer does not own both proxies", async function () {
      const fixture = await loadFixture(deployFixture);
      await fixture.contracts.escrow
        .connect(fixture.deployer)
        .transferOwnership(fixture.stranger.address);
      const snapshotFile = scratchSnapshot();

      await expect(run(fixture, { snapshotFile })).to.be.rejectedWith(/does not own both/);

      expect(fs.existsSync(snapshotFile)).to.equal(false);
      expect(await fixture.contracts.escrow.promptFee()).to.equal(PROMPT_FEE);
    });

    it("refuses an address with no contract code as the Safe", async function () {
      const fixture = await loadFixture(deployFixture);

      await expect(run(fixture, { safeAddress: fixture.safe.address })).to.be.rejectedWith(
        /no contract code/,
      );
    });

    it("resumes from an existing snapshot as the restore baseline instead of overwriting it", async function () {
      // Mid-run abort: the snapshot (fee 1) exists and the live fee is already 2. A re-run must
      // keep the ORIGINAL baseline, otherwise the confirm phase would bless the rehearsal value.
      const fixture = await loadFixture(deployFixture);
      const snapshotFile = scratchSnapshot();
      fs.writeFileSync(
        snapshotFile,
        JSON.stringify(
          Object.fromEntries(Object.entries(fixture.state).map(([k, v]) => [k, String(v)])),
        ),
      );
      const before = fs.readFileSync(snapshotFile, "utf8");
      await fixture.contracts.escrow.connect(fixture.deployer).setPromptFee(REHEARSAL_FEE);

      await run(fixture, { snapshotFile });

      expect(fs.readFileSync(snapshotFile, "utf8")).to.equal(before);
      expect(fixture.lines.some((l) => /resum/i.test(l))).to.equal(true);
      expect(fixture.lines.some((l) => l.includes("Pre-rehearsal state saved"))).to.equal(false);
      expect(await fixture.contracts.escrow.promptFee()).to.equal(PROMPT_FEE);
      expect(await fixture.contracts.aiAgent.owner()).to.equal(fixture.safeContractAddress);
      expect(await fixture.contracts.escrow.owner()).to.equal(fixture.safeContractAddress);
    });
  });

  describe("forwardPhase failure path", function () {
    it("keeps the snapshot and surfaces the step error when a transaction fails mid-run", async function () {
      const fixture = await loadFixture(deployFixture);
      const snapshotFile = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), "rehearsal-")),
        "s.json",
      );
      let snapshotExistedWhenPlanRan = null;
      const execute = async () => {
        snapshotExistedWhenPlanRan = fs.existsSync(snapshotFile);
        throw new Error("[treasury-set] escrow.setTreasury failed: boom");
      };

      await expect(
        forwardPhase({
          contracts: fixture.contracts,
          signer: fixture.deployer,
          dryRun: false,
          log: fixture.log,
          safeAddress: fixture.safeContractAddress,
          rehearsalPromptFee: REHEARSAL_FEE,
          snapshotFile,
          execute,
        }),
      ).to.be.rejectedWith(/\[treasury-set\]/);

      expect(snapshotExistedWhenPlanRan).to.equal(true);
      expect(fs.existsSync(snapshotFile)).to.equal(true);
    });
  });

  describe("findEvent", function () {
    it("ignores a matching event emitted by another contract", async function () {
      const { contracts, safe, deployer } = await loadFixture(deployFixture);
      const target = contracts.aiAgent;
      const iface = target.interface;
      const topicHash = iface.getEvent("OwnershipTransferred").topicHash;
      const encode = (from, to) => ({
        topics: [topicHash, ethers.zeroPadValue(from, 32), ethers.zeroPadValue(to, 32)],
        data: "0x",
      });
      const stepDef = {
        id: "agent-owner-to-safe",
        event: { name: "OwnershipTransferred", args: [deployer.address, safe.address] },
      };
      const foreign = {
        address: await contracts.escrow.getAddress(),
        ...encode(safe.address, deployer.address),
      };
      const own = { address: target.target, ...encode(deployer.address, safe.address) };

      expect(() => findEvent({ logs: [foreign, own] }, target, stepDef)).to.not.throw();
      expect(() => findEvent({ logs: [foreign] }, target, stepDef)).to.throw(/was not emitted/);
    });
  });

  describe("confirmPhase", function () {
    it("explains how to produce a missing snapshot", async function () {
      const { contracts, log } = await loadFixture(deployFixture);
      const missing = path.join(os.tmpdir(), "rehearsal-missing", "snapshot.json");

      await expect(confirmPhase({ contracts, log, snapshotFile: missing })).to.be.rejectedWith(
        /run the forward phase first/,
      );
    });
  });

  describe("assertMainnetConfirmed", function () {
    it("blocks live Base mainnet runs unless explicitly confirmed", function () {
      expect(() =>
        assertMainnetConfirmed({ networkName: "base", dryRun: false, confirmed: undefined }),
      ).to.throw(/REHEARSAL_MAINNET_CONFIRMED=1/);
      expect(() =>
        assertMainnetConfirmed({ networkName: "base", dryRun: false, confirmed: "yes" }),
      ).to.throw(/REHEARSAL_MAINNET_CONFIRMED=1/);
      expect(() =>
        assertMainnetConfirmed({ networkName: "base", dryRun: false, confirmed: "1" }),
      ).to.not.throw();
      expect(() =>
        assertMainnetConfirmed({ networkName: "base", dryRun: true, confirmed: undefined }),
      ).to.not.throw();
      expect(() =>
        assertMainnetConfirmed({ networkName: "baseSepolia", dryRun: false, confirmed: undefined }),
      ).to.not.throw();
    });
  });
});
