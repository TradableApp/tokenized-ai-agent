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
  acceptReturned,
  verifyReturned,
  parseRehearsalFee,
  forwardPhase,
  confirmPhase,
  assertMainnetConfirmed,
  findEvent,
  verifyGetter,
} = require("../scripts/admin-rehearsal");
const { publishEncryptionKey: publishKey } = require("./helpers/encryptionKeyProof");

describe("scripts/admin-rehearsal", function () {
  const DOMAIN = "tradable.app";
  const PROMPT_FEE = ethers.parseEther("1");
  const REHEARSAL_FEE = ethers.parseEther("2");

  /** Publishes a throwaway encryption key as `oracle` and returns it. */
  async function publishEncryptionKey(aiAgent, oracle) {
    const key = new ethers.SigningKey(ethers.id("admin-rehearsal-encryption-key"));
    await publishKey(aiAgent, oracle, key);
    return key.publicKey;
  }

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
    it("captures the live owner, treasury and prompt fee", async function () {
      const { state, deployer, treasury } = await loadFixture(deployFixture);

      expect(state.agentOwner).to.equal(deployer.address);
      expect(state.escrowOwner).to.equal(deployer.address);
      expect(state.treasury).to.equal(treasury.address);
      expect(state.promptFee).to.equal(PROMPT_FEE);
    });

    it("captures the published encryption key and who published it", async function () {
      const { contracts, oracle } = await loadFixture(deployFixture);
      const before = await readState(contracts);
      expect(before.encryptionKey).to.equal("0x");
      expect(before.encryptionKeyPublisher).to.equal(ethers.ZeroAddress);

      const key = await publishEncryptionKey(contracts.aiAgent, oracle);

      const after = await readState(contracts);
      expect(after.encryptionKey).to.equal(key);
      expect(after.encryptionKeyPublisher).to.equal(oracle.address);
    });
    it("leaves the encryption key out for an agent that does not have it yet", async function () {
      const { contracts, deployer } = await loadFixture(deployFixture);
      // The agent's interface at the escrow's address: the owner reads work, the two key getters
      // revert, as they do on a proxy still running the version before the key.
      const olderAgent = contracts.aiAgent.attach(await contracts.escrow.getAddress());

      const state = await readState({ ...contracts, aiAgent: olderAgent });

      expect(state.agentOwner).to.equal(deployer.address);
      expect(state).to.not.have.property("encryptionKey");
      expect(state).to.not.have.property("encryptionKeyPublisher");
    });
    it("does not take a node's own error for a missing key, even when its text mentions a revert", async function () {
      const { contracts } = await loadFixture(deployFixture);
      const refused = Object.assign(new Error("429: request reverted by rate limiter"), {
        code: "SERVER_ERROR",
      });
      const failingAgent = {
        owner: () => contracts.aiAgent.owner(),
        oracleEncryptionKey: () => Promise.reject(refused),
        oracleEncryptionKeyPublisher: () => contracts.aiAgent.oracleEncryptionKeyPublisher(),
      };

      await expect(readState({ ...contracts, aiAgent: failingAgent })).to.be.rejectedWith(refused);
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
        "agent.addOracle",
        "agent.removeOracle",
        "agent.transferOwnership",
        "escrow.transferOwnership",
      ]);
      expect(plan[0].args).to.deep.equal([REHEARSAL_FEE]);
      expect(plan[1].args).to.deep.equal([PROMPT_FEE]);
      expect(plan[2].args).to.deep.equal([safe.address]);
      expect(plan[3].args).to.deep.equal([treasury.address]);
      expect(plan[4].args).to.deep.equal([safe.address]);
      expect(plan[5].args).to.deep.equal([safe.address]);
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
      expect(plan[4].event).to.deep.equal({
        name: "RoleGranted",
        args: [ethers.id("ORACLE_ROLE"), safe.address],
      });
      expect(plan[4].verify).to.deep.equal({
        getter: "isOracle",
        args: [safe.address],
        expected: true,
      });
      expect(plan[5].event).to.deep.equal({
        name: "RoleRevoked",
        args: [ethers.id("ORACLE_ROLE"), safe.address],
      });
      expect(plan[5].verify).to.deep.equal({
        getter: "isOracle",
        args: [safe.address],
        expected: false,
      });
      // The deploy wallet's transfer is an offer: the Safe is the pending owner until it accepts.
      expect(plan[6].event).to.deep.equal({
        name: "OwnershipTransferStarted",
        args: [deployer.address, safe.address],
      });
      expect(plan[6].verify).to.deep.equal({
        getter: "pendingOwner",
        expected: safe.address,
        alsoDoneWhen: { getter: "owner" },
      });
      expect(plan[7].event).to.deep.equal(plan[6].event);
      expect(plan[7].verify).to.deep.equal(plan[6].verify);
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

    it("executes, proves each event and getter, and leaves fees restored and ownership offered to the Safe", async function () {
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
      expect(await contracts.aiAgent.isOracle(oracle.address)).to.equal(true);
      expect(await contracts.aiAgent.isOracle(safe.address)).to.equal(false);
      expect(await contracts.aiAgent.owner()).to.equal(deployer.address);
      expect(await contracts.escrow.owner()).to.equal(deployer.address);
      expect(await contracts.aiAgent.pendingOwner()).to.equal(safe.address);
      expect(await contracts.escrow.pendingOwner()).to.equal(safe.address);
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
      const plan = buildPlan({
        state,
        safeAddress: safe.address,
        rehearsalPromptFee: REHEARSAL_FEE,
      });

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
      expect(await contracts.aiAgent.owner()).to.equal(deployer.address);
      expect(await contracts.escrow.owner()).to.equal(deployer.address);
      expect(await contracts.aiAgent.pendingOwner()).to.equal(safe.address);
      expect(await contracts.escrow.pendingOwner()).to.equal(safe.address);
    });

    it("counts an offer the Safe has already accepted as done, so a run can be resumed after it", async function () {
      const { contracts, state, log, deployer, safe } = await loadFixture(deployFixture);
      const plan = buildPlan({
        state,
        safeAddress: safe.address,
        rehearsalPromptFee: REHEARSAL_FEE,
      });
      await runPlan({ plan, contracts, signer: deployer, dryRun: false, log });
      await contracts.aiAgent.connect(safe).acceptOwnership();
      await contracts.escrow.connect(safe).acceptOwnership();

      const offers = plan.filter((s) => s.method === "transferOwnership");
      const results = await runPlan({
        plan: offers,
        contracts,
        signer: deployer,
        dryRun: false,
        log,
      });

      expect(results.every((r) => r.skipped)).to.equal(true);
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

      await verifyGetter(target, stepDef, receipt, {
        attempts: 5,
        sleep: async (ms) => naps.push(ms),
      });

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
    it("has the Safe accept both proxies and then offer them back to the deploy wallet", async function () {
      const { contracts, deployer } = await loadFixture(deployFixture);

      const txs = await buildSafeReturnTxs({ contracts, returnTo: deployer.address });

      const agent = await contracts.aiAgent.getAddress();
      const escrow = await contracts.escrow.getAddress();
      const accept = contracts.aiAgent.interface.encodeFunctionData("acceptOwnership", []);
      const giveBack = contracts.aiAgent.interface.encodeFunctionData("transferOwnership", [
        deployer.address,
      ]);
      expect(txs).to.deep.equal([
        { to: agent, value: "0", data: accept },
        { to: escrow, value: "0", data: accept },
        { to: agent, value: "0", data: giveBack },
        { to: escrow, value: "0", data: giveBack },
      ]);
    });

    it("is a sequence the Safe can send as written, after which the deploy wallet accepts", async function () {
      const { contracts, state, log, deployer, safe } = await loadFixture(deployFixture);
      const plan = buildPlan({
        state,
        safeAddress: safe.address,
        rehearsalPromptFee: REHEARSAL_FEE,
      });
      await runPlan({ plan, contracts, signer: deployer, dryRun: false, log });

      for (const tx of await buildSafeReturnTxs({ contracts, returnTo: deployer.address })) {
        await safe.sendTransaction({ to: tx.to, data: tx.data });
      }
      expect(await contracts.aiAgent.owner()).to.equal(safe.address);

      const accepted = await acceptReturned({ contracts, signer: deployer, log });

      expect(accepted).to.deep.equal(["agent", "escrow"]);
      expect(await verifyReturned({ contracts, state })).to.deep.equal({
        ok: true,
        mismatches: [],
      });
      expect(await acceptReturned({ contracts, signer: deployer, log })).to.deep.equal([]);
    });
  });

  describe("verifyReturned", function () {
    it("reports an offer still open, then the Safe as owner, then passes once returned", async function () {
      const { contracts, state, log, deployer, safe } = await loadFixture(deployFixture);
      const plan = buildPlan({
        state,
        safeAddress: safe.address,
        rehearsalPromptFee: REHEARSAL_FEE,
      });
      await runPlan({ plan, contracts, signer: deployer, dryRun: false, log });
      const fields = (result) => result.mismatches.map((m) => m.field).sort();

      const offered = await verifyReturned({ contracts, state });
      expect(offered.ok).to.equal(false);
      expect(fields(offered)).to.deep.equal(["agentPendingOwner", "escrowPendingOwner"]);

      await contracts.aiAgent.connect(safe).acceptOwnership();
      await contracts.escrow.connect(safe).acceptOwnership();
      const held = await verifyReturned({ contracts, state });
      expect(fields(held)).to.deep.equal(["agentOwner", "escrowOwner"]);

      await contracts.aiAgent.connect(safe).transferOwnership(deployer.address);
      await contracts.escrow.connect(safe).transferOwnership(deployer.address);
      const offeredBack = await verifyReturned({ contracts, state });
      expect(fields(offeredBack)).to.deep.equal([
        "agentOwner",
        "agentPendingOwner",
        "escrowOwner",
        "escrowPendingOwner",
      ]);

      await acceptReturned({ contracts, signer: deployer, log });
      const after = await verifyReturned({ contracts, state });
      expect(after).to.deep.equal({ ok: true, mismatches: [] });
    });

    it("watches the live oracle: a rehearsal that leaves it without its role is reported", async function () {
      const { contracts, deployer, oracle } = await loadFixture(deployFixture);
      const watched = { ...contracts, oracleAddress: oracle.address };
      const state = await readState(watched);
      expect(state.oracle).to.equal(oracle.address);
      expect(state.oracleAuthorized).to.equal(true);

      await contracts.aiAgent.connect(deployer).removeOracle(oracle.address);

      const result = await verifyReturned({ contracts, state });
      expect(result.ok).to.equal(false);
      expect(result.mismatches).to.deep.equal([
        { field: "oracleAuthorized", expected: "true", actual: "false" },
      ]);
    });
    it("watches the encryption key: a rehearsal that leaves clients without it is reported", async function () {
      const { contracts, deployer, oracle } = await loadFixture(deployFixture);
      const key = await publishEncryptionKey(contracts.aiAgent, oracle);
      const state = await readState(contracts);

      // Removing the publisher withdraws the key clients encrypt to.
      await contracts.aiAgent.connect(deployer).removeOracle(oracle.address);

      const result = await verifyReturned({ contracts, state });
      expect(result.ok).to.equal(false);
      expect(result.mismatches).to.deep.equal([
        { field: "encryptionKey", expected: key, actual: "0x" },
        {
          field: "encryptionKeyPublisher",
          expected: oracle.address,
          actual: ethers.ZeroAddress,
        },
      ]);
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
        treasury: fixture.state.treasury,
        promptFee: String(fixture.state.promptFee),
        encryptionKey: "0x",
        encryptionKeyPublisher: ethers.ZeroAddress,
      });
      expect(await fixture.contracts.aiAgent.pendingOwner()).to.equal(fixture.safeContractAddress);
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
      await fixture.contracts.escrow.connect(fixture.stranger).acceptOwnership();
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
      expect(await fixture.contracts.aiAgent.pendingOwner()).to.equal(fixture.safeContractAddress);
      expect(await fixture.contracts.escrow.pendingOwner()).to.equal(fixture.safeContractAddress);
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
    it("says so when the snapshot was taken without the encryption key, and confirms the rest", async function () {
      const { contracts, state } = await loadFixture(deployFixture);
      // Its own log: the fixture's is shared with the tests before this one.
      const lines = [];
      const log = (line) => lines.push(String(line));
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rehearsal-older-"));
      const snapshotFile = path.join(dir, "snapshot.json");
      const older = { ...state, promptFee: String(state.promptFee) };
      delete older.encryptionKey;
      delete older.encryptionKeyPublisher;
      fs.writeFileSync(snapshotFile, JSON.stringify(older));

      await confirmPhase({ contracts, log, snapshotFile });

      expect(lines.join("\n")).to.match(/encryption key is not in the snapshot/);
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
