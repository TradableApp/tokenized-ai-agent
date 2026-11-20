const { expect } = require("chai");
const { ethers } = require("hardhat");
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
  assertPhaseCanDryRun,
  findEvent,
  verifyGetter,
  main,
} = require("../scripts/admin-rehearsal");
const { SnapshotNotDurable } = require("../scripts/rehearsal/values");
const { publishEncryptionKey: publishKey } = require("./helpers/encryptionKeyProof");
const {
  PROMPT_FEE,
  REHEARSAL_FEE,
  OFFERS_DONE,
  snapshotText,
  versionOneText,
  loadRehearsal,
  scratchFolders,
} = require("./helpers/rehearsalFixture");

const { scratchDir, removeScratchDirs } = scratchFolders();

describe("scripts/admin-rehearsal", function () {
  after(removeScratchDirs);

  /** Publishes a throwaway encryption key as `oracle` and returns it. */
  async function publishEncryptionKey(aiAgent, oracle) {
    const key = new ethers.SigningKey(ethers.id("admin-rehearsal-encryption-key"));
    await publishKey(aiAgent, oracle, key);
    return key.publicKey;
  }

  describe("readState", function () {
    it("captures the live owner, treasury and prompt fee", async function () {
      const { state, deployer, treasury } = await loadRehearsal();

      expect(state.agentOwner).to.equal(deployer.address);
      expect(state.escrowOwner).to.equal(deployer.address);
      expect(state.treasury).to.equal(treasury.address);
      expect(state.promptFee).to.equal(PROMPT_FEE);
    });

    it("captures the published encryption key and who published it", async function () {
      const { contracts, oracle } = await loadRehearsal();
      const before = await readState(contracts);
      expect(before.encryptionKey).to.equal("0x");
      expect(before.encryptionKeyPublisher).to.equal(ethers.ZeroAddress);

      const key = await publishEncryptionKey(contracts.aiAgent, oracle);

      const after = await readState(contracts);
      expect(after.encryptionKey).to.equal(key);
      expect(after.encryptionKeyPublisher).to.equal(oracle.address);
    });
    it("leaves the encryption key out for an agent that does not have it yet", async function () {
      const { contracts, deployer } = await loadRehearsal();
      // The agent's interface at the escrow's address: the owner reads work, the two key getters
      // revert, as they do on a proxy still running the version before the key.
      const olderAgent = contracts.aiAgent.attach(await contracts.escrow.getAddress());

      const state = await readState({ ...contracts, aiAgent: olderAgent });

      expect(state.agentOwner).to.equal(deployer.address);
      expect(state).to.not.have.property("encryptionKey");
      expect(state).to.not.have.property("encryptionKeyPublisher");
    });
    it("does not take a node's own error for a missing key, even when its text mentions a revert", async function () {
      const { contracts } = await loadRehearsal();
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
      const { state, safe, treasury } = await loadRehearsal();

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
      const { state, safe, deployer } = await loadRehearsal();

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
      expect(plan[6].verify).to.deep.equal({ getter: "pendingOwner", expected: safe.address });
      expect(plan[7].event).to.deep.equal(plan[6].event);
      expect(plan[7].verify).to.deep.equal(plan[6].verify);
    });

    it("rejects a Safe address that is zero, malformed or already the owner", async function () {
      const { state, deployer } = await loadRehearsal();

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
      const { state, safe } = await loadRehearsal();

      expect(() =>
        buildPlan({ state, safeAddress: safe.address, rehearsalPromptFee: PROMPT_FEE }),
      ).to.throw(/fee/i);
    });
  });

  describe("runPlan (dry run)", function () {
    it("prints every call and expected event without changing state", async function () {
      const { contracts, state, lines, log, deployer, safe } = await loadRehearsal();
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
      const { contracts, state, log, stranger, safe } = await loadRehearsal();
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
      const fixture = await loadRehearsal();
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
      const { contracts, state, log, deployer, oracle, treasury, safe } = await loadRehearsal();
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

    describe("when something fails after the node has taken the transaction", function () {
      async function runFee(fixture, { record, tamper = false }) {
        const plan = buildPlan({
          state: fixture.state,
          safeAddress: fixture.safe.address,
          rehearsalPromptFee: REHEARSAL_FEE,
        });
        const first = tamper
          ? { ...plan[0], event: { name: "PromptFeeUpdated", args: [PROMPT_FEE] } }
          : plan[0];
        const lines = [];
        let failure;
        try {
          await runPlan({
            plan: [first],
            contracts: fixture.contracts,
            signer: fixture.deployer,
            dryRun: false,
            log: (l) => lines.push(String(l)),
            record,
          });
        } catch (error) {
          failure = error;
        }
        return { failure, lines };
      }

      const hashIn = (lines) => lines.join("\n").match(/sent: +(0x[0-9a-f]{64})/)?.[1];

      it("records the step as sent before it waits for the transaction", async function () {
        const fixture = await loadRehearsal();
        const events = [];
        const escrow = fixture.contracts.escrow.connect(fixture.deployer);
        const watched = new Proxy(escrow, {
          get(target, property) {
            if (property === "connect") return () => watched;
            if (property !== "setPromptFee") return Reflect.get(target, property, target);
            return async (...args) => {
              const tx = await target.setPromptFee(...args);
              return new Proxy(tx, {
                get(sent, key) {
                  if (key !== "wait") return Reflect.get(sent, key, sent);
                  return async () => {
                    events.push("wait");
                    return sent.wait();
                  };
                },
              });
            };
          },
        });
        const plan = buildPlan({
          state: fixture.state,
          safeAddress: fixture.safe.address,
          rehearsalPromptFee: REHEARSAL_FEE,
        });

        await runPlan({
          plan: [plan[0]],
          contracts: { ...fixture.contracts, escrow: watched },
          signer: fixture.deployer,
          dryRun: false,
          log: () => {},
          record: async (id, entry) => events.push(entry.status),
        });

        expect(events).to.deep.equal(["sent", "wait", "done"]);
      });

      it("logs the hash as soon as the node returns it", async function () {
        const fixture = await loadRehearsal();

        const { failure, lines } = await runFee(fixture, { record: async () => {} });

        expect(failure).to.equal(undefined);
        expect(hashIn(lines)).to.match(/^0x[0-9a-f]{64}$/);
      });

      it("says a step whose sent record could not be written may land, and to send nothing by hand", async function () {
        const fixture = await loadRehearsal();
        const diskFull = new Error("ENOSPC: no space left on device");

        const { failure, lines } = await runFee(fixture, {
          record: async (id, entry) => {
            if (entry.status === "sent") throw diskFull;
          },
        });

        const hash = hashIn(lines);
        expect(failure.message).to.include(`[fee-set] sent as ${hash}`);
        expect(failure.message).to.match(
          /snapshot could not be written[\s\S]*may land[\s\S]*send nothing by hand/,
        );
        expect(failure.cause).to.equal(diskFull);
        expect(failure.message).to.not.match(/recorded as sent/);
      });

      it("says a step whose sent record was written but not made durable is on disk, may land, and to send nothing by hand", async function () {
        const fixture = await loadRehearsal();
        const notDurable = new SnapshotNotDurable(
          "The snapshot at s.json was written, but could not be made durable: EIO",
          { cause: new Error("EIO") },
        );

        const { failure, lines } = await runFee(fixture, {
          record: async (id, entry) => {
            if (entry.status === "sent") throw notDurable;
          },
        });

        expect(failure.message).to.include(`[fee-set] sent as ${hashIn(lines)}`);
        expect(failure.message).to.match(
          /recorded as sent[\s\S]*could not be made durable[\s\S]*may land[\s\S]*send nothing by hand/,
        );
        expect(failure.message).to.not.match(/could not be written/);
        expect(failure.cause).to.equal(notDurable);
      });

      it("says a step that landed but could not be recorded done landed, and to run again", async function () {
        const fixture = await loadRehearsal();
        const diskFull = new Error("ENOSPC: no space left on device");

        const { failure, lines } = await runFee(fixture, {
          record: async (id, entry) => {
            if (entry.status === "done") throw diskFull;
          },
        });

        expect(failure.message).to.include(hashIn(lines));
        expect(failure.message).to.match(/\[fee-set\][\s\S]*landed[\s\S]*run again/);
        expect(failure.cause).to.equal(diskFull);
      });

      it("says a step whose event check failed after it landed landed, naming its hash", async function () {
        const fixture = await loadRehearsal();

        const { failure, lines } = await runFee(fixture, { record: async () => {}, tamper: true });

        expect(failure.message).to.include(hashIn(lines));
        expect(failure.message).to.match(/PromptFeeUpdated[\s\S]*landed[\s\S]*run again/);
      });

      it("keeps the error a failed send was reported with", async function () {
        const fixture = await loadRehearsal();
        const plan = buildPlan({
          state: fixture.state,
          safeAddress: fixture.safe.address,
          rehearsalPromptFee: REHEARSAL_FEE,
        });

        const failure = await runPlan({
          plan,
          contracts: fixture.contracts,
          signer: fixture.stranger,
          dryRun: false,
          log: () => {},
        }).catch((error) => error);

        expect(failure.message).to.match(/\[fee-set\]/);
        expect(failure.cause).to.be.an("error");
      });
    });

    it("rejects when the emitted event does not match the plan", async function () {
      const { contracts, state, log, deployer, safe } = await loadRehearsal();
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

    it("follows the decisions it is given: skips, records as observed, and sends", async function () {
      const { contracts, state, deployer, safe } = await loadRehearsal();
      await contracts.escrow.connect(deployer).setPromptFee(REHEARSAL_FEE);
      const plan = buildPlan({
        state,
        safeAddress: safe.address,
        rehearsalPromptFee: REHEARSAL_FEE,
      });
      const decisions = plan.map((step) => ({
        step,
        action:
          { "fee-set": "observe", "treasury-set": "skip", "treasury-restore": "skip" }[step.id] ??
          "send",
        reason: "test",
      }));
      const recorded = [];

      await runPlan({
        plan,
        decisions,
        contracts,
        signer: deployer,
        dryRun: false,
        log: () => {},
        record: async (id, entry) => recorded.push([id, entry.status, entry.observed === true]),
      });

      expect(recorded[0]).to.deep.equal(["fee-set", "done", true]);
      expect(recorded.map(([id]) => id)).to.not.include("treasury-set");
      expect(await contracts.escrow.promptFee()).to.equal(PROMPT_FEE);
      expect(await contracts.aiAgent.pendingOwner()).to.equal(safe.address);
    });

    it("records each step as sent, with its hash, before it waits for it, and as done after its checks", async function () {
      const { contracts, state, deployer, safe } = await loadRehearsal();
      const plan = buildPlan({
        state,
        safeAddress: safe.address,
        rehearsalPromptFee: REHEARSAL_FEE,
      });
      const recorded = [];

      await runPlan({
        plan,
        contracts,
        signer: deployer,
        dryRun: false,
        log: () => {},
        record: async (id, entry) => recorded.push({ id, ...entry }),
      });

      expect(recorded).to.have.lengthOf(plan.length * 2);
      plan.forEach((step, i) => {
        const [sent, done] = [recorded[2 * i], recorded[2 * i + 1]];
        expect(sent).to.deep.include({ id: step.id, status: "sent" });
        expect(sent.nonce).to.be.a("number");
        expect(sent.txHash).to.match(/^0x[0-9a-f]{64}$/);
        expect(done).to.deep.include({ id: step.id, status: "done", txHash: sent.txHash });
        expect(done.blockNumber).to.be.a("number");
      });
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
      const { contracts, deployer } = await loadRehearsal();

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
      const { contracts, state, log, deployer, safe } = await loadRehearsal();
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
      const { contracts, state, log, deployer, safe } = await loadRehearsal();
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
      const { contracts, deployer, oracle } = await loadRehearsal();
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
      const { contracts, deployer, oracle } = await loadRehearsal();
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
      return path.join(scratchDir("rehearsal-"), "snapshot.json");
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
      const fixture = await loadRehearsal();
      const snapshotFile = scratchSnapshot();

      await run(fixture, { snapshotFile });

      const savedAt = fixture.lines.findIndex((l) => l.includes("Pre-rehearsal state saved"));
      const firstStepAt = fixture.lines.findIndex((l) => l.includes("[fee-set]"));
      expect(savedAt).to.be.greaterThan(-1);
      expect(savedAt).to.be.lessThan(firstStepAt);
      const { pair, safe, baseline, updatedAt, steps, ...saved } = JSON.parse(
        fs.readFileSync(snapshotFile, "utf8"),
      );
      expect(safe).to.equal(fixture.safeContractAddress);
      expect(pair.escrow).to.equal(await fixture.contracts.escrow.getAddress());
      expect(Date.parse(updatedAt)).to.not.be.NaN;
      expect(saved).to.deep.equal({
        version: 2,
        network: "hardhat",
        chainId: "31337",
        rehearsalPromptFee: String(REHEARSAL_FEE),
        confirmed: false,
      });
      // Every step the run sent is recorded done.
      expect(Object.values(steps).map((step) => step.status)).to.deep.equal(Array(8).fill("done"));
      expect(baseline).to.deep.equal({
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
      const fixture = await loadRehearsal();
      const snapshotFile = scratchSnapshot();

      await run(fixture, { dryRun: true, snapshotFile });

      expect(fs.existsSync(snapshotFile)).to.equal(false);
    });

    it("refuses before any transaction when the signer does not own both proxies", async function () {
      const fixture = await loadRehearsal();
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
      const fixture = await loadRehearsal();

      await expect(run(fixture, { safeAddress: fixture.safe.address })).to.be.rejectedWith(
        /no contract code/,
      );
    });

    it("resumes from an existing snapshot as the restore baseline instead of overwriting it", async function () {
      // Mid-run abort: the snapshot (fee 1) exists and the live fee is already 2. A re-run must
      // keep the ORIGINAL baseline, otherwise the confirm phase would bless the rehearsal value.
      const fixture = await loadRehearsal();
      const snapshotFile = scratchSnapshot();
      fs.writeFileSync(
        snapshotFile,
        await snapshotText(fixture.contracts, fixture.state, fixture.safeContractAddress),
      );
      const before = JSON.parse(fs.readFileSync(snapshotFile, "utf8"));
      await fixture.contracts.escrow.connect(fixture.deployer).setPromptFee(REHEARSAL_FEE);

      await run(fixture, { snapshotFile });

      const after = JSON.parse(fs.readFileSync(snapshotFile, "utf8"));
      expect(after.baseline).to.deep.equal(before.baseline);
      expect(after.steps["fee-set"]).to.deep.equal({ status: "done", observed: true });
      expect(after.steps["fee-restore"].status).to.equal("done");
      expect(fixture.lines.some((l) => /resum/i.test(l))).to.equal(true);
      expect(fixture.lines.some((l) => l.includes("Pre-rehearsal state saved"))).to.equal(false);
      expect(await fixture.contracts.escrow.promptFee()).to.equal(PROMPT_FEE);
      expect(await fixture.contracts.aiAgent.pendingOwner()).to.equal(fixture.safeContractAddress);
      expect(await fixture.contracts.escrow.pendingOwner()).to.equal(fixture.safeContractAddress);
    });
  });

  describe("forwardPhase and the pair a snapshot belongs to", function () {
    function scratch() {
      return path.join(scratchDir("rehearsal-pair-"), "snapshot.json");
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
        ...overrides,
      });
    }

    it("records the pair in the snapshot it writes", async function () {
      const fixture = await loadRehearsal();
      const snapshotFile = scratch();

      await run(fixture, { snapshotFile });

      expect(JSON.parse(fs.readFileSync(snapshotFile, "utf8")).pair).to.deep.equal({
        agent: await fixture.contracts.aiAgent.getAddress(),
        escrow: await fixture.contracts.escrow.getAddress(),
      });
    });

    // A file left by a rehearsal of another pair holds that pair's treasury and fee. Taken as
    // the baseline, its "restore" steps would write them to this pair.
    it("refuses a snapshot taken for another pair, before any transaction", async function () {
      const fixture = await loadRehearsal();
      const snapshotFile = scratch();
      const other = { ...fixture.state, treasury: fixture.stranger.address };
      fs.writeFileSync(
        snapshotFile,
        await snapshotText(fixture.contracts, other, fixture.safeContractAddress, {
          pair: { agent: fixture.stranger.address, escrow: fixture.stranger.address },
        }),
      );
      let executed = false;

      await expect(
        run(fixture, {
          snapshotFile,
          execute: async () => {
            executed = true;
            return [];
          },
        }),
      ).to.be.rejectedWith(/another pair/);
      expect(executed).to.equal(false);
    });

    // One address of the pair the same is still another pair: a new escrow beside the same agent
    // has its own treasury and fee.
    for (const differing of ["agent", "escrow"]) {
      it(`refuses a snapshot whose ${differing} alone is another one, before any transaction`, async function () {
        const fixture = await loadRehearsal();
        const snapshotFile = scratch();
        const pair = {
          agent: await fixture.contracts.aiAgent.getAddress(),
          escrow: await fixture.contracts.escrow.getAddress(),
          [differing]: fixture.stranger.address,
        };
        fs.writeFileSync(
          snapshotFile,
          await snapshotText(fixture.contracts, fixture.state, fixture.safeContractAddress, {
            pair,
          }),
        );
        let executed = false;

        await expect(
          run(fixture, {
            snapshotFile,
            execute: async () => {
              executed = true;
              return [];
            },
          }),
        ).to.be.rejectedWith(/another pair/);
        expect(executed).to.equal(false);
      });
    }

    it("refuses a snapshot that does not say which pair it was taken for", async function () {
      const fixture = await loadRehearsal();
      const snapshotFile = scratch();
      fs.writeFileSync(
        snapshotFile,
        JSON.stringify(
          Object.fromEntries(Object.entries(fixture.state).map(([k, v]) => [k, String(v)])),
        ),
      );

      await expect(run(fixture, { snapshotFile })).to.be.rejectedWith(/does not say which pair/);
    });

    it("refuses another pair's snapshot in the confirm phase too", async function () {
      const { contracts, state, safeContractAddress, stranger, log } = await loadRehearsal();
      const snapshotFile = scratch();
      fs.writeFileSync(
        snapshotFile,
        await snapshotText(contracts, state, safeContractAddress, {
          pair: { agent: stranger.address, escrow: stranger.address },
        }),
      );

      await expect(confirmPhase({ contracts, log, snapshotFile })).to.be.rejectedWith(
        /another pair/,
      );
    });

    // A finished rehearsal's snapshot is no longer a baseline: the settings may have been
    // changed on purpose since, and a resume from it would put the old ones back.
    it("starts from the live state when the snapshot's rehearsal was already confirmed", async function () {
      const fixture = await loadRehearsal();
      const { contracts, state, safeContractAddress, deployer, log } = fixture;
      const snapshotFile = scratch();
      fs.writeFileSync(
        snapshotFile,
        await snapshotText(contracts, state, safeContractAddress, { steps: OFFERS_DONE }),
      );
      await confirmPhase({ contracts, signer: deployer, log, snapshotFile });
      expect(JSON.parse(fs.readFileSync(snapshotFile, "utf8")).confirmed).to.equal(true);
      const laterFee = ethers.parseEther("5");
      await contracts.escrow.connect(deployer).setPromptFee(laterFee);

      await run(fixture, { snapshotFile });

      expect(fixture.lines.some((l) => /resum/i.test(l))).to.equal(false);
      expect(await contracts.escrow.promptFee()).to.equal(laterFee);
      const written = JSON.parse(fs.readFileSync(snapshotFile, "utf8"));
      expect(written.baseline.promptFee).to.equal(String(laterFee));
      expect(written.confirmed).to.equal(false);
    });

    it("refuses to resume with another Safe than the one the rehearsal was started with", async function () {
      const fixture = await loadRehearsal();
      const snapshotFile = scratch();
      fs.writeFileSync(
        snapshotFile,
        await snapshotText(fixture.contracts, fixture.state, fixture.stranger.address),
      );
      let executed = false;

      await expect(
        run(fixture, {
          snapshotFile,
          execute: async () => {
            executed = true;
            return [];
          },
        }),
      ).to.be.rejectedWith(/was started with the Safe/);
      expect(executed).to.equal(false);
    });

    it("records the Safe in the snapshot it writes", async function () {
      const fixture = await loadRehearsal();
      const snapshotFile = scratch();

      await run(fixture, { snapshotFile });

      expect(JSON.parse(fs.readFileSync(snapshotFile, "utf8")).safe).to.equal(
        fixture.safeContractAddress,
      );
    });

    it("refuses another pair's snapshot in a dry run too, and leaves the file as it is", async function () {
      const fixture = await loadRehearsal();
      const snapshotFile = scratch();
      fs.writeFileSync(
        snapshotFile,
        await snapshotText(fixture.contracts, fixture.state, fixture.safeContractAddress, {
          pair: { agent: fixture.stranger.address, escrow: fixture.stranger.address },
        }),
      );
      const before = fs.readFileSync(snapshotFile, "utf8");

      await expect(run(fixture, { snapshotFile, dryRun: true })).to.be.rejectedWith(/another pair/);
      expect(fs.readFileSync(snapshotFile, "utf8")).to.equal(before);
    });

    it("resumes this pair's snapshot in a dry run as a live run would, and leaves the file as it is", async function () {
      const fixture = await loadRehearsal();
      const snapshotFile = scratch();
      fs.writeFileSync(
        snapshotFile,
        await snapshotText(fixture.contracts, fixture.state, fixture.safeContractAddress),
      );
      const before = fs.readFileSync(snapshotFile, "utf8");

      await run(fixture, { snapshotFile, dryRun: true });

      expect(fs.readFileSync(snapshotFile, "utf8")).to.equal(before);
      expect(fixture.lines.some((l) => /resum/i.test(l))).to.equal(true);
    });

    // A node that did not answer is not a pair without the getter.
    for (const proxyName of ["aiAgent", "escrow"]) {
      it(`passes on a node's own error from ${proxyName}.pendingOwner() instead of calling the pair one-step`, async function () {
        const fixture = await loadRehearsal();
        const unanswered = new Proxy(fixture.contracts[proxyName], {
          get(target, property) {
            if (property === "pendingOwner") {
              return async () => {
                throw Object.assign(new Error("bad gateway"), { code: "SERVER_ERROR" });
              };
            }
            return Reflect.get(target, property, target);
          },
        });

        await expect(
          run(fixture, {
            contracts: { ...fixture.contracts, [proxyName]: unanswered },
            snapshotFile: scratch(),
            dryRun: true,
          }),
        ).to.be.rejectedWith("bad gateway");
      });
    }

    // A pair from before two-step ownership has no pendingOwner(). The dry run passed against
    // it and the live run stopped after the fee, treasury and oracle steps had been sent.
    for (const dryRun of [true, false]) {
      it(`refuses a pair that moves ownership in one step before anything is sent (dryRun=${dryRun})`, async function () {
        const fixture = await loadRehearsal();
        const oneStep = new Proxy(fixture.contracts.aiAgent, {
          get(target, property) {
            if (property === "pendingOwner") {
              return async () => {
                throw Object.assign(new Error("execution reverted"), { code: "CALL_EXCEPTION" });
              };
            }
            return Reflect.get(target, property, target);
          },
        });
        let executed = false;
        const snapshotFile = scratch();

        await expect(
          run(fixture, {
            contracts: { ...fixture.contracts, aiAgent: oneStep },
            dryRun,
            snapshotFile,
            execute: async () => {
              executed = true;
              return [];
            },
          }),
        ).to.be.rejectedWith(/agent has no pendingOwner\(\).*two steps/s);
        expect(executed).to.equal(false);
        expect(fs.existsSync(snapshotFile)).to.equal(false);
      });
    }
  });

  describe("the snapshot's own folder, and the file earlier versions left in the cache", function () {
    function folder() {
      return scratchDir("rehearsal-folder-");
    }

    /** A forward run with a snapshot and a legacy file of its own, recording whether it sent. */
    function forward(fixture, { snapshotFile, legacySnapshotFile, dryRun = false }) {
      fixture.lines = [];
      fixture.executed = false;
      return forwardPhase({
        contracts: fixture.contracts,
        signer: fixture.deployer,
        dryRun,
        log: (line) => fixture.lines.push(String(line)),
        safeAddress: fixture.safeContractAddress,
        rehearsalPromptFee: REHEARSAL_FEE,
        snapshotFile,
        legacySnapshotFile,
        execute: async () => {
          fixture.executed = true;
          return [];
        },
      });
    }

    for (const dryRun of [false, true]) {
      it(`refuses an unconfirmed snapshot of this pair in the cache, and leaves it there (dryRun=${dryRun})`, async function () {
        const fixture = await loadRehearsal();
        const dir = folder();
        const legacySnapshotFile = path.join(dir, "cache", "admin-rehearsal.hardhat.json");
        const snapshotFile = path.join(dir, "rehearsal-state", "snapshot.json");
        fs.mkdirSync(path.dirname(legacySnapshotFile));
        fs.writeFileSync(
          legacySnapshotFile,
          await versionOneText(fixture.contracts, fixture.state, {
            safe: fixture.safeContractAddress,
          }),
        );
        const before = fs.readFileSync(legacySnapshotFile, "utf8");

        const refusal = forward(fixture, { snapshotFile, legacySnapshotFile, dryRun });

        await expect(refusal).to.be.rejectedWith(/only record[\s\S]*move it aside/i);
        await expect(refusal).to.not.be.rejectedWith(/delete/i);
        expect(fixture.executed).to.equal(false);
        expect(fs.existsSync(snapshotFile)).to.equal(false);
        expect(fs.readFileSync(legacySnapshotFile, "utf8")).to.equal(before);
      });
    }

    it("warns about a snapshot of another pair in the cache, leaves it there and goes on", async function () {
      const fixture = await loadRehearsal();
      const dir = folder();
      const legacySnapshotFile = path.join(dir, "admin-rehearsal.hardhat.json");
      const snapshotFile = path.join(dir, "rehearsal-state", "snapshot.json");
      fs.writeFileSync(
        legacySnapshotFile,
        await versionOneText(fixture.contracts, fixture.state, {
          pair: { agent: fixture.stranger.address, escrow: fixture.stranger.address },
        }),
      );
      const before = fs.readFileSync(legacySnapshotFile, "utf8");

      await forward(fixture, { snapshotFile, legacySnapshotFile });

      expect(fixture.lines.some((l) => l.includes(legacySnapshotFile))).to.equal(true);
      expect(fixture.executed).to.equal(true);
      expect(fs.readFileSync(legacySnapshotFile, "utf8")).to.equal(before);
      expect(JSON.parse(fs.readFileSync(snapshotFile, "utf8")).version).to.equal(2);
    });

    it("starts from the live state when a version 1 snapshot in the new folder was confirmed", async function () {
      const fixture = await loadRehearsal();
      const snapshotFile = path.join(folder(), "snapshot.json");
      fs.writeFileSync(
        snapshotFile,
        await versionOneText(fixture.contracts, fixture.state, { confirmed: true }),
      );

      await forward(fixture, { snapshotFile });

      expect(fixture.executed).to.equal(true);
      const written = JSON.parse(fs.readFileSync(snapshotFile, "utf8"));
      expect(written).to.deep.include({ version: 2, confirmed: false });
    });

    for (const dryRun of [false, true]) {
      it(`refuses a version 1 snapshot in the new folder for a forward run, which records no steps (dryRun=${dryRun})`, async function () {
        const fixture = await loadRehearsal();
        const snapshotFile = path.join(folder(), "snapshot.json");
        fs.writeFileSync(snapshotFile, await versionOneText(fixture.contracts, fixture.state));
        const before = fs.readFileSync(snapshotFile, "utf8");

        await expect(forward(fixture, { snapshotFile, dryRun })).to.be.rejectedWith(
          /earlier version[\s\S]*confirm phase/,
        );
        expect(fixture.executed).to.equal(false);
        expect(fs.readFileSync(snapshotFile, "utf8")).to.equal(before);
      });

      it(`refuses a snapshot that is not JSON, and does not take it for a missing one (dryRun=${dryRun})`, async function () {
        const fixture = await loadRehearsal();
        const snapshotFile = path.join(folder(), "snapshot.json");
        fs.writeFileSync(snapshotFile, '{"version": 2, "baseline": {');

        await expect(forward(fixture, { snapshotFile, dryRun })).to.be.rejectedWith(
          /not JSON[\s\S]*move it aside/i,
        );
        expect(fixture.executed).to.equal(false);
        expect(fs.readFileSync(snapshotFile, "utf8")).to.equal('{"version": 2, "baseline": {');
      });
    }

    for (const [what, extra, refusal] of [
      ["network", { network: "baseSepolia" }, /network baseSepolia/],
      ["chain", { chainId: "84532" }, /chain 84532/],
    ]) {
      it(`refuses a snapshot of this pair taken on another ${what}`, async function () {
        const fixture = await loadRehearsal();
        const snapshotFile = path.join(folder(), "snapshot.json");
        fs.writeFileSync(
          snapshotFile,
          await snapshotText(fixture.contracts, fixture.state, fixture.safeContractAddress, extra),
        );

        await expect(forward(fixture, { snapshotFile })).to.be.rejectedWith(refusal);
        expect(fixture.executed).to.equal(false);
      });
    }

    it("confirms a version 1 snapshot moved into the new folder, and writes it back as version 2", async function () {
      const { contracts, state, deployer, log } = await loadRehearsal();
      const snapshotFile = path.join(folder(), "snapshot.json");
      fs.writeFileSync(snapshotFile, await versionOneText(contracts, state));

      await confirmPhase({ contracts, signer: deployer, log, snapshotFile });

      const written = JSON.parse(fs.readFileSync(snapshotFile, "utf8"));
      expect(written).to.deep.include({ version: 2, confirmed: true, steps: {} });
      expect(written.baseline.promptFee).to.equal(String(state.promptFee));
    });

    it("refuses to confirm while an unconfirmed snapshot of this pair is still in the cache", async function () {
      const { contracts, state, safeContractAddress, deployer, log } = await loadRehearsal();
      const dir = folder();
      const legacySnapshotFile = path.join(dir, "admin-rehearsal.hardhat.json");
      const snapshotFile = path.join(dir, "snapshot.json");
      fs.writeFileSync(legacySnapshotFile, await versionOneText(contracts, state));
      fs.writeFileSync(snapshotFile, await snapshotText(contracts, state, safeContractAddress));

      await expect(
        confirmPhase({ contracts, signer: deployer, log, snapshotFile, legacySnapshotFile }),
      ).to.be.rejectedWith(/only record/);
      expect(JSON.parse(fs.readFileSync(snapshotFile, "utf8")).confirmed).to.equal(false);
    });
  });

  describe("forwardPhase and what a rehearsal leaves behind", function () {
    function forward(fixture, { snapshotFile, dryRun = false }) {
      fixture.lines = [];
      fixture.executed = false;
      return forwardPhase({
        contracts: fixture.contracts,
        signer: fixture.deployer,
        dryRun,
        log: (line) => fixture.lines.push(String(line)),
        safeAddress: fixture.safeContractAddress,
        rehearsalPromptFee: REHEARSAL_FEE,
        snapshotFile,
        execute: async () => {
          fixture.executed = true;
          return [];
        },
      });
    }

    const scratch = () => path.join(scratchDir("rehearsal-left-"), "snapshot.json");

    // A lost snapshot after treasury-set would otherwise make the Safe the "original" treasury.
    for (const dryRun of [false, true]) {
      it(`refuses to take a baseline from live state that holds the Safe as treasury (dryRun=${dryRun})`, async function () {
        const fixture = await loadRehearsal();
        await fixture.contracts.escrow
          .connect(fixture.deployer)
          .setTreasury(fixture.safeContractAddress);
        const snapshotFile = scratch();

        await expect(forward(fixture, { snapshotFile, dryRun })).to.be.rejectedWith(
          /treasury\(\) is the Safe[\s\S]*Nothing was sent/,
        );
        expect(fixture.executed).to.equal(false);
        expect(fs.existsSync(snapshotFile)).to.equal(false);
      });
    }

    it("refuses after a confirmed rehearsal too, when the live fee is the rehearsal fee", async function () {
      const fixture = await loadRehearsal();
      const snapshotFile = scratch();
      fs.writeFileSync(
        snapshotFile,
        await snapshotText(fixture.contracts, fixture.state, fixture.safeContractAddress, {
          confirmed: true,
        }),
      );
      await fixture.contracts.escrow.connect(fixture.deployer).setPromptFee(REHEARSAL_FEE);

      await expect(forward(fixture, { snapshotFile })).to.be.rejectedWith(
        /promptFee\(\) is the rehearsal fee/,
      );
      expect(fixture.executed).to.equal(false);
    });

    it("does not look for leftovers when it resumes from this pair's unconfirmed snapshot", async function () {
      const fixture = await loadRehearsal();
      const snapshotFile = scratch();
      fs.writeFileSync(
        snapshotFile,
        await snapshotText(fixture.contracts, fixture.state, fixture.safeContractAddress),
      );
      await fixture.contracts.escrow
        .connect(fixture.deployer)
        .setTreasury(fixture.safeContractAddress);

      await forward(fixture, { snapshotFile });

      expect(fixture.executed).to.equal(true);
    });
  });

  describe("forwardPhase run again: what it sends and what it refuses", function () {
    const scratch = () => path.join(scratchDir("rehearsal-again-"), "snapshot.json");

    function forward(fixture, overrides = {}) {
      fixture.lines = [];
      return forwardPhase({
        contracts: fixture.contracts,
        signer: fixture.deployer,
        dryRun: false,
        log: (line) => fixture.lines.push(String(line)),
        safeAddress: fixture.safeContractAddress,
        rehearsalPromptFee: REHEARSAL_FEE,
        ...overrides,
      });
    }

    const nonce = (fixture) => ethers.provider.getTransactionCount(fixture.deployer.address);

    async function withSteps(fixture, snapshotFile, steps) {
      fs.writeFileSync(
        snapshotFile,
        await snapshotText(fixture.contracts, fixture.state, fixture.safeContractAddress, {
          steps,
        }),
      );
    }

    it("sends nothing again after a forward run that finished", async function () {
      const fixture = await loadRehearsal();
      const snapshotFile = scratch();
      await forward(fixture, { snapshotFile });
      const sentBefore = await nonce(fixture);

      await forward(fixture, { snapshotFile });

      expect(await nonce(fixture)).to.equal(sentBefore);
      expect(await fixture.contracts.escrow.promptFee()).to.equal(PROMPT_FEE);
    });

    it("does not send a restore that landed without being recorded", async function () {
      const fixture = await loadRehearsal();
      const snapshotFile = scratch();
      const done = { status: "done", txHash: "0x" + "ab".repeat(32), blockNumber: 1 };
      await withSteps(fixture, snapshotFile, { "fee-set": done });
      const sentBefore = await nonce(fixture);

      await forward(fixture, { snapshotFile });

      const steps = JSON.parse(fs.readFileSync(snapshotFile, "utf8")).steps;
      expect(steps["fee-restore"]).to.deep.equal({ status: "done", observed: true });
      // Treasury, oracle and the two offers: six transactions, none for the fee.
      expect((await nonce(fixture)) - sentBefore).to.equal(6);
    });

    it("settles a step recorded as sent from its receipt, and does not send it again", async function () {
      const fixture = await loadRehearsal();
      const snapshotFile = scratch();
      const tx = await fixture.contracts.escrow
        .connect(fixture.deployer)
        .setPromptFee(REHEARSAL_FEE);
      const receipt = await tx.wait();
      await withSteps(fixture, snapshotFile, {
        "fee-set": { status: "sent", txHash: tx.hash, nonce: tx.nonce },
      });

      await forward(fixture, { snapshotFile });

      const steps = JSON.parse(fs.readFileSync(snapshotFile, "utf8")).steps;
      expect(steps["fee-set"]).to.deep.equal({
        status: "done",
        txHash: tx.hash,
        blockNumber: receipt.blockNumber,
      });
      expect(steps["fee-restore"].status).to.equal("done");
      expect(await fixture.contracts.escrow.promptFee()).to.equal(PROMPT_FEE);
    });

    // A node that has pruned the state at the receipt's block cannot answer a read there.
    it("settles a sent step from its receipt and event, without reading state at its block", async function () {
      const fixture = await loadRehearsal();
      const snapshotFile = scratch();
      const tx = await fixture.contracts.escrow
        .connect(fixture.deployer)
        .setPromptFee(REHEARSAL_FEE);
      const receipt = await tx.wait();
      await withSteps(fixture, snapshotFile, {
        "fee-set": { status: "sent", txHash: tx.hash, nonce: tx.nonce },
      });
      const pruned = new Proxy(fixture.contracts.escrow, {
        get(target, property) {
          if (property === "connect") return () => pruned;
          if (property === "promptFee") {
            return async (...args) => {
              if (args.some((a) => a && typeof a === "object" && "blockTag" in a)) {
                throw new Error("missing trie node");
              }
              return target.promptFee(...args);
            };
          }
          return Reflect.get(target, property, target);
        },
      });

      await forward(fixture, {
        snapshotFile,
        contracts: { ...fixture.contracts, escrow: pruned },
        execute: async () => [],
      });

      const steps = JSON.parse(fs.readFileSync(snapshotFile, "utf8")).steps;
      expect(steps["fee-set"]).to.deep.equal({
        status: "done",
        txHash: tx.hash,
        blockNumber: receipt.blockNumber,
      });
    });

    it("refuses a sent step whose receipt does not carry the step's event", async function () {
      const fixture = await loadRehearsal();
      const snapshotFile = scratch();
      const other = await fixture.contracts.escrow
        .connect(fixture.deployer)
        .setPromptFee(ethers.parseEther("1.5"));
      await other.wait();
      await fixture.contracts.escrow.connect(fixture.deployer).setPromptFee(PROMPT_FEE);
      await withSteps(fixture, snapshotFile, {
        "fee-set": { status: "sent", txHash: other.hash, nonce: other.nonce },
      });

      await expect(forward(fixture, { snapshotFile })).to.be.rejectedWith(
        /\[fee-set\] PromptFeeUpdated arg 0/,
      );
    });

    it("refuses a sent step whose receipt holds no matching event, says it will keep stopping runs, and leaves the snapshot", async function () {
      const fixture = await loadRehearsal();
      const snapshotFile = scratch();
      const unrelated = await fixture.contracts.escrow
        .connect(fixture.deployer)
        .setTreasury(fixture.treasury.address);
      await unrelated.wait();
      await withSteps(fixture, snapshotFile, {
        "fee-set": { status: "sent", txHash: unrelated.hash, nonce: unrelated.nonce },
      });
      const before = fs.readFileSync(snapshotFile, "utf8");

      await expect(forward(fixture, { snapshotFile })).to.be.rejectedWith(
        /PromptFeeUpdated was not emitted[\s\S]*keep stopping every run[\s\S]*block explorer[\s\S]*move the snapshot aside/,
      );
      expect(fs.readFileSync(snapshotFile, "utf8")).to.equal(before);
    });

    it("forgets a sent step this node has no receipt for when its nonce is unused, and sends it", async function () {
      const fixture = await loadRehearsal();
      const snapshotFile = scratch();
      const nonce = await ethers.provider.getTransactionCount(fixture.deployer.address);
      await withSteps(fixture, snapshotFile, {
        "fee-set": { status: "sent", txHash: `0x${"ef".repeat(32)}`, nonce },
      });

      await forward(fixture, { snapshotFile });

      expect(fixture.lines.some((l) => l.includes("no receipt found on this node"))).to.equal(true);
      const steps = JSON.parse(fs.readFileSync(snapshotFile, "utf8")).steps;
      expect(steps["fee-set"].txHash).to.not.equal(`0x${"ef".repeat(32)}`);
      expect(steps["fee-set"].status).to.equal("done");
    });

    it("removes the Safe's oracle role when a resumed run finds the role it added still held", async function () {
      const fixture = await loadRehearsal();
      const snapshotFile = scratch();
      const done = { status: "done", txHash: "0x" + "ab".repeat(32), blockNumber: 1 };
      await withSteps(fixture, snapshotFile, { "oracle-add": done });
      await fixture.contracts.aiAgent
        .connect(fixture.deployer)
        .addOracle(fixture.safeContractAddress);

      await forward(fixture, { snapshotFile });

      expect(await fixture.contracts.aiAgent.isOracle(fixture.safeContractAddress)).to.equal(false);
      const steps = JSON.parse(fs.readFileSync(snapshotFile, "utf8")).steps;
      expect(steps["oracle-remove"].status).to.equal("done");
      expect(steps["oracle-remove"].observed).to.equal(undefined);
    });

    it("refuses a finished pair whose value is the rehearsal value again, sending nothing", async function () {
      const fixture = await loadRehearsal();
      const snapshotFile = scratch();
      const done = { status: "done", txHash: "0x" + "ab".repeat(32), blockNumber: 1 };
      await withSteps(fixture, snapshotFile, { "fee-set": done, "fee-restore": done });
      await fixture.contracts.escrow.connect(fixture.deployer).setPromptFee(REHEARSAL_FEE);
      const sentBefore = await nonce(fixture);

      await expect(forward(fixture, { snapshotFile })).to.be.rejectedWith(/rehearsal value/);
      expect(await nonce(fixture)).to.equal(sentBefore);
    });

    it("refuses to resume with another rehearsal fee than the one it was started with", async function () {
      const fixture = await loadRehearsal();
      const snapshotFile = scratch();
      await withSteps(fixture, snapshotFile, {});

      await expect(
        forward(fixture, { snapshotFile, rehearsalPromptFee: ethers.parseEther("3") }),
      ).to.be.rejectedWith(/was started with the rehearsal fee/);
    });

    for (const dryRun of [false, true]) {
      it(`refuses to start while the wallet has a transaction waiting to be mined (dryRun=${dryRun})`, async function () {
        const fixture = await loadRehearsal();
        const snapshotFile = scratch();
        await ethers.provider.send("evm_setAutomine", [false]);
        try {
          await fixture.deployer.sendTransaction({ to: fixture.stranger.address, value: 1n });

          await expect(forward(fixture, { snapshotFile, dryRun })).to.be.rejectedWith(
            /waiting to be mined/,
          );
          expect(fs.existsSync(snapshotFile)).to.equal(false);
        } finally {
          await ethers.provider.send("evm_setAutomine", [true]);
          await ethers.provider.send("evm_mine", []);
        }
      });
    }
  });

  describe("the dry run, on the same path as a live run", function () {
    const scratch = () => path.join(scratchDir("rehearsal-dry-"), "snapshot.json");
    const done = { status: "done", txHash: "0x" + "ab".repeat(32), blockNumber: 1 };

    function forward(fixture, overrides = {}) {
      fixture.lines = [];
      return forwardPhase({
        contracts: fixture.contracts,
        signer: fixture.deployer,
        dryRun: true,
        log: (line) => fixture.lines.push(String(line)),
        safeAddress: fixture.safeContractAddress,
        rehearsalPromptFee: REHEARSAL_FEE,
        ...overrides,
      });
    }

    async function withSteps(fixture, snapshotFile, steps) {
      fs.writeFileSync(
        snapshotFile,
        await snapshotText(fixture.contracts, fixture.state, fixture.safeContractAddress, {
          steps,
        }),
      );
      return fs.readFileSync(snapshotFile, "utf8");
    }

    const simulated = (fixture) =>
      fixture.lines.filter((l) => l.includes("call simulated OK")).length;

    it("simulates only the steps a resumed live run would send, and says which it would skip", async function () {
      const fixture = await loadRehearsal();
      const snapshotFile = scratch();
      const before = await withSteps(fixture, snapshotFile, { "fee-set": done });
      await fixture.contracts.escrow.connect(fixture.deployer).setPromptFee(REHEARSAL_FEE);
      const nonce = await ethers.provider.getTransactionCount(fixture.deployer.address);

      await forward(fixture, { snapshotFile });

      expect(simulated(fixture)).to.equal(7);
      expect(fixture.lines.some((l) => /would skip/.test(l))).to.equal(true);
      expect(fs.readFileSync(snapshotFile, "utf8")).to.equal(before);
      expect(await ethers.provider.getTransactionCount(fixture.deployer.address)).to.equal(nonce);
    });

    it("simulates nothing after a forward run that finished", async function () {
      const fixture = await loadRehearsal();
      const snapshotFile = scratch();
      await forward(fixture, { snapshotFile, dryRun: false });
      const before = fs.readFileSync(snapshotFile, "utf8");

      await forward(fixture, { snapshotFile });

      expect(simulated(fixture)).to.equal(0);
      expect(fs.readFileSync(snapshotFile, "utf8")).to.equal(before);
    });

    it("does not take what a resumed rehearsal set for a leftover", async function () {
      const fixture = await loadRehearsal();
      const snapshotFile = scratch();
      await withSteps(fixture, snapshotFile, { "treasury-set": done });
      await fixture.contracts.escrow
        .connect(fixture.deployer)
        .setTreasury(fixture.safeContractAddress);

      await forward(fixture, { snapshotFile });

      expect(simulated(fixture)).to.equal(7);
    });

    it("refuses what the live run would refuse: a finished pair back at the rehearsal value", async function () {
      const fixture = await loadRehearsal();
      const snapshotFile = scratch();
      await withSteps(fixture, snapshotFile, { "fee-set": done, "fee-restore": done });
      await fixture.contracts.escrow.connect(fixture.deployer).setPromptFee(REHEARSAL_FEE);

      await expect(forward(fixture, { snapshotFile })).to.be.rejectedWith(/rehearsal value/);
    });

    it("refuses what the live run would refuse: another rehearsal fee than the one started with", async function () {
      const fixture = await loadRehearsal();
      const snapshotFile = scratch();
      await withSteps(fixture, snapshotFile, {});

      await expect(
        forward(fixture, { snapshotFile, rehearsalPromptFee: ethers.parseEther("3") }),
      ).to.be.rejectedWith(/was started with the rehearsal fee/);
    });
  });

  describe("forwardPhase failure path", function () {
    it("keeps the snapshot and surfaces the step error when a transaction fails mid-run", async function () {
      const fixture = await loadRehearsal();
      const snapshotFile = path.join(scratchDir("rehearsal-"), "s.json");
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
      const { contracts, safe, deployer } = await loadRehearsal();
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
    it("accepts the ownership the Safe offered back, then confirms the snapshot", async function () {
      const fixture = await loadRehearsal();
      const { contracts, state, safeContractAddress, deployer, safe } = fixture;
      const lines = [];
      const log = (line) => lines.push(String(line));
      const snapshotFile = path.join(scratchDir("rehearsal-"), "s.json");
      fs.writeFileSync(
        snapshotFile,
        await snapshotText(contracts, state, safeContractAddress, { steps: OFFERS_DONE }),
      );
      const plan = buildPlan({
        state,
        safeAddress: safe.address,
        rehearsalPromptFee: REHEARSAL_FEE,
      });
      await runPlan({ plan, contracts, signer: deployer, dryRun: false, log });
      for (const tx of await buildSafeReturnTxs({ contracts, returnTo: deployer.address })) {
        await safe.sendTransaction({ to: tx.to, data: tx.data });
      }

      await confirmPhase({ contracts, signer: deployer, log, snapshotFile });

      expect(await contracts.aiAgent.owner()).to.equal(deployer.address);
      expect(await contracts.escrow.owner()).to.equal(deployer.address);
      expect(lines.join("\n")).to.match(/Confirm phase complete/);
    });

    it("does not confirm while the Safe has still to send its transactions", async function () {
      const fixture = await loadRehearsal();
      const { contracts, state, safeContractAddress, deployer, safe, log } = fixture;
      const snapshotFile = path.join(scratchDir("rehearsal-"), "s.json");
      fs.writeFileSync(
        snapshotFile,
        await snapshotText(contracts, state, safeContractAddress, { steps: OFFERS_DONE }),
      );
      const plan = buildPlan({
        state,
        safeAddress: safe.address,
        rehearsalPromptFee: REHEARSAL_FEE,
      });
      await runPlan({ plan, contracts, signer: deployer, dryRun: false, log });

      await expect(
        confirmPhase({ contracts, signer: deployer, log, snapshotFile }),
      ).to.be.rejectedWith(/not been fully returned/);
      // Still the baseline: marked confirmed here, the next forward run would start from the
      // live state, which holds the rehearsal's values, and the record of the old ones is gone.
      expect(JSON.parse(fs.readFileSync(snapshotFile, "utf8")).confirmed).to.equal(false);
    });

    // A forward run stopped between authorising the Safe as an oracle and removing it has moved
    // no ownership and changed nothing the snapshot holds.
    it("does not confirm while the Safe still holds the oracle role the rehearsal gave it", async function () {
      const { contracts, state, deployer, safe, log } = await loadRehearsal();
      const snapshotFile = path.join(scratchDir("rehearsal-"), "s.json");
      fs.writeFileSync(
        snapshotFile,
        await snapshotText(contracts, state, safe.address, { steps: OFFERS_DONE }),
      );
      await contracts.aiAgent.connect(deployer).addOracle(safe.address);

      await expect(
        confirmPhase({ contracts, signer: deployer, log, snapshotFile }),
      ).to.be.rejectedWith(/not been fully returned/);
      expect(JSON.parse(fs.readFileSync(snapshotFile, "utf8")).confirmed).to.equal(false);

      await contracts.aiAgent.connect(deployer).removeOracle(safe.address);
      await confirmPhase({ contracts, signer: deployer, log, snapshotFile });
      const written = JSON.parse(fs.readFileSync(snapshotFile, "utf8"));
      expect(written.confirmed).to.equal(true);
      expect(written.safe).to.equal(safe.address);
    });

    // The removal of the Safe's role can be as fresh as the acceptance, and as late to a node.
    it("reads the Safe's oracle role again with the rest, past a node that has not caught up", async function () {
      const { contracts, state, deployer, safe, log } = await loadRehearsal();
      const snapshotFile = path.join(scratchDir("rehearsal-"), "s.json");
      fs.writeFileSync(
        snapshotFile,
        await snapshotText(contracts, state, safe.address, { steps: OFFERS_DONE }),
      );
      const answers = [true, false];
      let reads = 0;
      const behind = new Proxy(contracts.aiAgent, {
        get(target, property) {
          if (property === "isOracle") return async () => answers[reads++];
          return Reflect.get(target, property, target);
        },
      });

      await confirmPhase({
        contracts: { ...contracts, aiAgent: behind },
        signer: deployer,
        log,
        snapshotFile,
        accept: async () => ["agent"],
        verify: async () => ({ ok: true, mismatches: [] }),
        sleep: async () => {},
      });

      expect(reads).to.equal(2);
      expect(JSON.parse(fs.readFileSync(snapshotFile, "utf8")).confirmed).to.equal(true);
    });

    it("gives up after its attempts and reports what still differs", async function () {
      const { contracts, state, safeContractAddress, deployer, log } = await loadRehearsal();
      const snapshotFile = path.join(scratchDir("rehearsal-"), "s.json");
      fs.writeFileSync(
        snapshotFile,
        await snapshotText(contracts, state, safeContractAddress, { steps: OFFERS_DONE }),
      );
      let reads = 0;
      let sleeps = 0;

      await expect(
        confirmPhase({
          contracts,
          signer: deployer,
          log,
          snapshotFile,
          accept: async () => ["agent"],
          verify: async () => {
            reads += 1;
            return { ok: false, mismatches: [{ field: "agentOwner", expected: "a", actual: "b" }] };
          },
          sleep: async () => {
            sleeps += 1;
          },
        }),
      ).to.be.rejectedWith(/not been fully returned/);
      expect(reads).to.equal(5);
      expect(sleeps).to.equal(4);
    });

    // The acceptance has just landed; a node behind that block still reports the Safe as owner.
    it("reads again after accepting, past a node that has not caught up", async function () {
      const { contracts, state, safeContractAddress, deployer, log } = await loadRehearsal();
      const snapshotFile = path.join(scratchDir("rehearsal-"), "s.json");
      fs.writeFileSync(
        snapshotFile,
        await snapshotText(contracts, state, safeContractAddress, { steps: OFFERS_DONE }),
      );
      const answers = [
        { ok: false, mismatches: [{ field: "agentOwner", expected: "a", actual: "b" }] },
        { ok: true, mismatches: [] },
      ];
      let reads = 0;

      await confirmPhase({
        contracts,
        signer: deployer,
        log,
        snapshotFile,
        accept: async () => ["agent"],
        verify: async () => answers[reads++],
        sleep: async () => {},
      });

      expect(reads).to.equal(2);
    });

    it("does not read again when it accepted nothing: the chain's answer is the answer", async function () {
      const { contracts, state, safeContractAddress, deployer, log } = await loadRehearsal();
      const snapshotFile = path.join(scratchDir("rehearsal-"), "s.json");
      fs.writeFileSync(
        snapshotFile,
        await snapshotText(contracts, state, safeContractAddress, { steps: OFFERS_DONE }),
      );
      let reads = 0;

      await expect(
        confirmPhase({
          contracts,
          signer: deployer,
          log,
          snapshotFile,
          accept: async () => [],
          verify: async () => {
            reads += 1;
            return { ok: false, mismatches: [{ field: "agentOwner", expected: "a", actual: "b" }] };
          },
          sleep: async () => {},
        }),
      ).to.be.rejectedWith(/not been fully returned/);
      expect(reads).to.equal(1);
    });

    it("explains how to produce a missing snapshot", async function () {
      const { contracts, log } = await loadRehearsal();
      const missing = path.join(os.tmpdir(), "rehearsal-missing", "snapshot.json");

      await expect(confirmPhase({ contracts, log, snapshotFile: missing })).to.be.rejectedWith(
        /run the forward phase first/,
      );
    });
    it("says so when the snapshot was taken without the encryption key, and confirms the rest", async function () {
      const { contracts, state, safeContractAddress, deployer } = await loadRehearsal();
      // Its own log: the fixture's is shared with the tests before this one.
      const lines = [];
      const log = (line) => lines.push(String(line));
      const dir = scratchDir("rehearsal-older-");
      const snapshotFile = path.join(dir, "snapshot.json");
      const older = { ...state };
      delete older.encryptionKey;
      delete older.encryptionKeyPublisher;
      fs.writeFileSync(
        snapshotFile,
        await snapshotText(contracts, older, safeContractAddress, { steps: OFFERS_DONE }),
      );

      await confirmPhase({ contracts, signer: deployer, log, snapshotFile });

      expect(lines.join("\n")).to.match(/encryption key is not in the snapshot/);
    });
  });

  describe("confirmPhase and a forward run that has not finished", function () {
    const scratch = () => path.join(scratchDir("rehearsal-unfinished-"), "snapshot.json");

    async function confirmWith(fixture, steps) {
      const snapshotFile = scratch();
      fs.writeFileSync(
        snapshotFile,
        await snapshotText(fixture.contracts, fixture.state, fixture.safeContractAddress, {
          steps,
        }),
      );
      const accepted = [];
      const refusal = confirmPhase({
        contracts: fixture.contracts,
        signer: fixture.deployer,
        log: () => {},
        snapshotFile,
        accept: async () => {
          accepted.push(true);
          return [];
        },
      });
      return { snapshotFile, refusal, accepted };
    }

    const confirmedIn = (file) => JSON.parse(fs.readFileSync(file, "utf8")).confirmed;

    // A set broadcast and not yet mined matches the baseline now and changes the fee later.
    it("refuses while a step is recorded as sent, naming it and its hash", async function () {
      const fixture = await loadRehearsal();
      const hash = `0x${"cd".repeat(32)}`;
      const { snapshotFile, refusal, accepted } = await confirmWith(fixture, {
        ...OFFERS_DONE,
        "fee-set": { status: "sent", txHash: hash, nonce: 0 },
      });

      await expect(refusal).to.be.rejectedWith(new RegExp(`fee-set[\\s\\S]*${hash}`));
      expect(accepted).to.deep.equal([]);
      expect(confirmedIn(snapshotFile)).to.equal(false);
    });

    it("refuses while the wallet has a transaction waiting to be mined", async function () {
      const fixture = await loadRehearsal();
      await ethers.provider.send("evm_setAutomine", [false]);
      try {
        await fixture.deployer.sendTransaction({ to: fixture.stranger.address, value: 1n });
        const { snapshotFile, refusal, accepted } = await confirmWith(fixture, OFFERS_DONE);

        await expect(refusal).to.be.rejectedWith(/waiting to be mined/);
        expect(accepted).to.deep.equal([]);
        expect(confirmedIn(snapshotFile)).to.equal(false);
      } finally {
        await ethers.provider.send("evm_setAutomine", [true]);
        await ethers.provider.send("evm_mine", []);
      }
    });

    // Stopped before the offers, the chain matches the baseline and no ownership was rehearsed.
    for (const missing of ["agent-owner-to-safe", "escrow-owner-to-safe"]) {
      it(`does not confirm a rehearsal whose ${missing} step is not recorded done`, async function () {
        const fixture = await loadRehearsal();
        const steps = { ...OFFERS_DONE };
        delete steps[missing];
        const { snapshotFile, refusal } = await confirmWith(fixture, steps);

        await expect(refusal).to.be.rejectedWith(new RegExp(`${missing}[\\s\\S]*forward phase`));
        expect(confirmedIn(snapshotFile)).to.equal(false);
      });
    }
  });

  describe("assertPhaseCanDryRun", function () {
    // The confirm phase sends the acceptance. A dry run of it would skip the mainnet flag and
    // send all the same.
    it("refuses a dry run of the confirm phase, which sends a transaction", function () {
      expect(() => assertPhaseCanDryRun({ phase: "confirm", dryRun: true })).to.throw(
        /confirm phase has no dry run/,
      );
      expect(() => assertPhaseCanDryRun({ phase: "confirm", dryRun: false })).to.not.throw();
      expect(() => assertPhaseCanDryRun({ phase: "forward", dryRun: true })).to.not.throw();
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

  describe("main", function () {
    const AGENT = "0x1111111111111111111111111111111111111111";
    const ESCROW = "0x2222222222222222222222222222222222222222";
    const SIGNER = "0x4444444444444444444444444444444444444444";
    const SAFE = "0x5555555555555555555555555555555555555555";
    let phaseBefore;

    // A main that read the process environment would stop at its first check here, before it
    // loaded a settings file or reached a network.
    before(function () {
      phaseBefore = process.env.REHEARSAL_PHASE;
      process.env.REHEARSAL_PHASE = "not-a-phase";
    });

    after(function () {
      if (phaseBefore === undefined) delete process.env.REHEARSAL_PHASE;
      else process.env.REHEARSAL_PHASE = phaseBefore;
    });

    /** main with every input a stand-in, recording what it reached. */
    function runMain({ env = {}, networkName = "baseSepolia" } = {}) {
      const calls = { loaded: null, attached: false, forward: null, confirm: null };
      const contracts = {
        aiAgent: { getAddress: async () => AGENT },
        escrow: { getAddress: async () => ESCROW },
      };
      const promise = main({
        env,
        networkName,
        loadEnvFile: (loadedInto) => {
          calls.loaded = loadedInto;
        },
        getSigners: async () => [{ address: SIGNER }],
        attach: async () => {
          calls.attached = true;
          return contracts;
        },
        forward: async (options) => {
          calls.forward = options;
        },
        confirm: async (options) => {
          calls.confirm = options;
        },
      });
      return { promise, calls, contracts };
    }

    it("refuses a dry run of the confirm phase before attaching to the contracts", async function () {
      const { promise, calls } = runMain({ env: { REHEARSAL_PHASE: "confirm", DRY_RUN: "1" } });

      await expect(promise).to.be.rejectedWith(/confirm phase has no dry run/);
      expect(calls.attached).to.equal(false);
      expect(calls.confirm).to.equal(null);
    });

    for (const phase of ["forward", "confirm"]) {
      it(`refuses a live ${phase} phase on Base mainnet without the flag, before attaching`, async function () {
        const { promise, calls } = runMain({
          env: { REHEARSAL_PHASE: phase, REHEARSAL_SAFE_ADDRESS: SAFE },
          networkName: "base",
        });

        await expect(promise).to.be.rejectedWith(/REHEARSAL_MAINNET_CONFIRMED=1/);
        expect(calls.attached).to.equal(false);
        expect(calls[phase]).to.equal(null);
      });
    }

    it("runs a live forward phase on Base mainnet when the flag is set", async function () {
      const { promise, calls } = runMain({
        env: { REHEARSAL_SAFE_ADDRESS: SAFE, REHEARSAL_MAINNET_CONFIRMED: "1" },
        networkName: "base",
      });

      await promise;

      expect(calls.forward).to.include({ dryRun: false, safeAddress: SAFE });
    });

    it("runs a dry run on Base mainnet without the flag", async function () {
      const { promise, calls } = runMain({
        env: { DRY_RUN: "1", REHEARSAL_SAFE_ADDRESS: SAFE },
        networkName: "base",
      });

      await promise;

      expect(calls.forward).to.include({ dryRun: true });
    });

    it("refuses a phase it does not know", async function () {
      const { promise, calls } = runMain({ env: { REHEARSAL_PHASE: "backward" } });

      await expect(promise).to.be.rejectedWith(/REHEARSAL_PHASE must be one of forward, confirm/);
      expect(calls.attached).to.equal(false);
    });

    it("loads the settings file into the environment it is given and reads them from it", async function () {
      const env = { REHEARSAL_SAFE_ADDRESS: SAFE, REHEARSAL_PROMPT_FEE: "3" };
      const { promise, calls, contracts } = runMain({ env });

      await promise;

      expect(calls.loaded).to.equal(env);
      expect(calls.forward.contracts).to.equal(contracts);
      expect(calls.forward.signer.address).to.equal(SIGNER);
      expect(calls.forward.rehearsalPromptFee).to.equal(ethers.parseEther("3"));
      expect(calls.confirm).to.equal(null);
    });

    for (const phase of ["forward", "confirm"]) {
      it(`gives the ${phase} phase the snapshot in its own folder, named by agent, and the cache file to check`, async function () {
        const { promise, calls } = runMain({
          env: { REHEARSAL_PHASE: phase, REHEARSAL_SAFE_ADDRESS: SAFE },
        });

        await promise;

        const root = path.resolve(__dirname, "..");
        expect(calls[phase]).to.deep.include({
          network: "baseSepolia",
          snapshotFile: path.join(
            root,
            "rehearsal-state",
            `admin-rehearsal.baseSepolia.${AGENT.toLowerCase()}.json`,
          ),
          legacySnapshotFile: path.join(root, "cache", "admin-rehearsal.baseSepolia.json"),
        });
      });
    }

    it("runs the confirm phase with the signer and the contracts", async function () {
      const { promise, calls, contracts } = runMain({ env: { REHEARSAL_PHASE: "confirm" } });

      await promise;

      expect(calls.confirm.contracts).to.equal(contracts);
      expect(calls.confirm.signer.address).to.equal(SIGNER);
      expect(calls.forward).to.equal(null);
    });
  });
});
