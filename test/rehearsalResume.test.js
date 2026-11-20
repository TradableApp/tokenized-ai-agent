const { expect } = require("chai");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const {
  findLeftovers,
  decideSteps,
  settleSentSteps,
  assertNoPendingTransactions,
} = require("../scripts/rehearsal/resume");
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

  describe("decideSteps", function () {
    const SAFE = "0x5555555555555555555555555555555555555555";
    const TREASURY = "0x6666666666666666666666666666666666666666";
    const OWNER = "0x7777777777777777777777777777777777777777";
    const ZERO = "0x0000000000000000000000000000000000000000";
    const BASE_FEE = 1n;
    const FEE = 2n;
    const IDS = [
      "fee-set",
      "fee-restore",
      "treasury-set",
      "treasury-restore",
      "oracle-add",
      "oracle-remove",
      "agent-owner-to-safe",
      "escrow-owner-to-safe",
    ];
    const plan = IDS.map((id) => ({ id }));
    const baseline = { promptFee: BASE_FEE, treasury: TREASURY, agentOwner: OWNER };
    const untouched = {
      promptFee: BASE_FEE,
      treasury: TREASURY,
      safeIsOracle: false,
      agentOwner: OWNER,
      escrowOwner: OWNER,
      agentPendingOwner: ZERO,
      escrowPendingOwner: ZERO,
    };
    const done = { status: "done", txHash: "0xab", blockNumber: 1 };

    function decide({ steps = {}, live = {} } = {}) {
      const decisions = decideSteps({
        plan,
        steps,
        live: { ...untouched, ...live },
        baseline,
        safe: SAFE,
        rehearsalPromptFee: FEE,
      });
      return Object.fromEntries(decisions.map((d) => [d.step.id, d]));
    }
    const actions = (decided, ...ids) => ids.map((id) => decided[id].action);

    it("sends every step of a rehearsal that has not started", function () {
      const decided = decide();

      expect(Object.keys(decided)).to.deep.equal(IDS);
      expect(actions(decided, ...IDS)).to.deep.equal(IDS.map(() => "send"));
    });

    describe("a set-and-restore pair (the fee)", function () {
      it("skips both when both are done and the fee is the baseline", function () {
        const decided = decide({ steps: { "fee-set": done, "fee-restore": done } });

        expect(actions(decided, "fee-set", "fee-restore")).to.deep.equal(["skip", "skip"]);
        expect(decided["fee-restore"].warn).to.not.equal(true);
      });

      it("refuses when both are done and the fee is the rehearsal fee again", function () {
        expect(() =>
          decide({ steps: { "fee-set": done, "fee-restore": done }, live: { promptFee: FEE } }),
        ).to.throw(/promptFee\(\)[\s\S]*rehearsal value[\s\S]*Nothing was sent/);
      });

      it("skips both with a warning when both are done and the fee is something else", function () {
        const decided = decide({
          steps: { "fee-set": done, "fee-restore": done },
          live: { promptFee: 5n },
        });

        expect(actions(decided, "fee-set", "fee-restore")).to.deep.equal(["skip", "skip"]);
        expect(decided["fee-restore"].warn).to.equal(true);
        expect(decided["fee-restore"].reason).to.include("5");
      });

      it("sends only the restore when the set is done and the fee is the rehearsal fee", function () {
        const decided = decide({ steps: { "fee-set": done }, live: { promptFee: FEE } });

        expect(actions(decided, "fee-set", "fee-restore")).to.deep.equal(["skip", "send"]);
      });

      it("records the restore as observed when the set is done and the fee is the baseline", function () {
        const decided = decide({ steps: { "fee-set": done } });

        expect(actions(decided, "fee-set", "fee-restore")).to.deep.equal(["skip", "observe"]);
      });

      it("refuses when the set is done and the fee is neither value", function () {
        expect(() => decide({ steps: { "fee-set": done }, live: { promptFee: 5n } })).to.throw(
          /promptFee\(\)[\s\S]*Nothing was sent/,
        );
      });

      it("records the set as observed and sends the restore when no set is recorded and the fee is the rehearsal fee", function () {
        const decided = decide({ live: { promptFee: FEE } });

        expect(actions(decided, "fee-set", "fee-restore")).to.deep.equal(["observe", "send"]);
      });

      it("refuses when no set is recorded and the fee is neither value", function () {
        expect(() => decide({ live: { promptFee: 5n } })).to.throw(/promptFee\(\)/);
      });

      it("refuses a restore recorded without its set", function () {
        expect(() => decide({ steps: { "fee-restore": done } })).to.throw(/fee-restore/);
      });

      it("refuses a step still recorded as sent, which must be settled first", function () {
        expect(() => decide({ steps: { "fee-set": { status: "sent", txHash: "0xab" } } })).to.throw(
          /fee-set[\s\S]*sent/,
        );
      });
    });

    describe("the treasury and the Safe's oracle role", function () {
      it("sends only the treasury's restore when the set is done and the Safe is the treasury", function () {
        const decided = decide({ steps: { "treasury-set": done }, live: { treasury: SAFE } });

        expect(actions(decided, "treasury-set", "treasury-restore")).to.deep.equal([
          "skip",
          "send",
        ]);
      });

      it("refuses when the treasury is neither the baseline nor the Safe", function () {
        expect(() => decide({ live: { treasury: OWNER } })).to.throw(/treasury\(\)/);
      });

      it("records the role as observed and removes it when the Safe holds it unrecorded", function () {
        const decided = decide({ live: { safeIsOracle: true } });

        expect(actions(decided, "oracle-add", "oracle-remove")).to.deep.equal(["observe", "send"]);
      });

      it("refuses when both are done and the Safe holds the role again", function () {
        expect(() =>
          decide({
            steps: { "oracle-add": done, "oracle-remove": done },
            live: { safeIsOracle: true },
          }),
        ).to.throw(/isOracle/);
      });
    });

    describe("the ownership offers", function () {
      it("skips an offer recorded as done", function () {
        const decided = decide({
          steps: { "agent-owner-to-safe": done },
          live: { agentPendingOwner: SAFE },
        });

        expect(decided["agent-owner-to-safe"].action).to.equal("skip");
      });

      it("records an offer already open to the Safe as observed, without sending it again", function () {
        const decided = decide({ live: { escrowPendingOwner: SAFE } });

        expect(decided["escrow-owner-to-safe"].action).to.equal("observe");
      });

      it("refuses when the Safe already owns the proxy", function () {
        expect(() => decide({ live: { agentOwner: SAFE } })).to.throw(
          /Safe already owns the agent/,
        );
      });
    });
  });

  describe("settleSentSteps", function () {
    const plan = [{ id: "fee-set" }, { id: "fee-restore" }];
    const sent = { status: "sent", txHash: "0xaa", nonce: 7 };

    function settle({ receipt, latest = 7, pending = latest, record = sent, check = () => {} }) {
      return settleSentSteps({
        plan,
        steps: { "fee-set": record },
        getReceipt: async () => receipt,
        getCounts: async () => ({ latest, pending }),
        check,
        log: () => {},
      });
    }

    it("marks a sent step done once its receipt succeeded and its event check passes", async function () {
      const checked = [];
      const steps = await settle({
        receipt: { status: 1, hash: "0xaa", blockNumber: 9 },
        check: (stepDef, receipt) => checked.push([stepDef.id, receipt.blockNumber]),
      });

      expect(steps).to.deep.equal({
        "fee-set": { status: "done", txHash: "0xaa", blockNumber: 9 },
      });
      expect(checked).to.deep.equal([["fee-set", 9]]);
    });

    it("passes on a failed check rather than marking the step done", async function () {
      await expect(
        settle({
          receipt: { status: 1, hash: "0xaa", blockNumber: 9 },
          check: () => {
            throw new Error("event not emitted");
          },
        }),
      ).to.be.rejectedWith(/event not emitted/);
    });

    it("forgets a step whose transaction reverted", async function () {
      expect(await settle({ receipt: { status: 0, hash: "0xaa", blockNumber: 9 } })).to.deep.equal(
        {},
      );
    });

    it("forgets a step with no receipt whose nonce is unused while nothing is pending", async function () {
      expect(await settle({ receipt: null, latest: 7, pending: 7 })).to.deep.equal({});
    });

    it("refuses a step with no receipt whose nonce the wallet has used: it or a replacement landed", async function () {
      await expect(settle({ receipt: null, latest: 8 })).to.be.rejectedWith(
        /fee-set[\s\S]*landed[\s\S]*cannot show it/,
      );
    });

    it("refuses a step with no receipt while the wallet has a transaction pending", async function () {
      await expect(settle({ receipt: null, latest: 7, pending: 8 })).to.be.rejectedWith(
        /fee-set[\s\S]*wait[\s\S]*run again/i,
      );
    });

    it("refuses a step with no receipt and no nonce recorded, which it cannot place", async function () {
      await expect(
        settle({ receipt: null, record: { status: "sent", txHash: "0xaa" } }),
      ).to.be.rejectedWith(/fee-set[\s\S]*no nonce/);
    });

    it("leaves steps recorded as done as they are", async function () {
      const doneStep = { status: "done", txHash: "0xbb", blockNumber: 3 };
      const steps = await settleSentSteps({
        plan,
        steps: { "fee-set": doneStep },
        getReceipt: async () => {
          throw new Error("not asked");
        },
        getCounts: async () => {
          throw new Error("not asked");
        },
        check: () => {},
        log: () => {},
      });

      expect(steps).to.deep.equal({ "fee-set": doneStep });
    });
  });

  describe("assertNoPendingTransactions", function () {
    const ADDRESS = "0x4444444444444444444444444444444444444444";
    const provider = (pending, latest) => ({
      getTransactionCount: async (address, tag) => (tag === "pending" ? pending : latest),
    });

    it("passes when nothing is waiting", async function () {
      expect(await assertNoPendingTransactions({ provider: provider(4, 4), address: ADDRESS })).to
        .be.undefined;
    });

    it("refuses while the wallet has a transaction waiting to be mined", async function () {
      await expect(
        assertNoPendingTransactions({ provider: provider(5, 4), address: ADDRESS }),
      ).to.be.rejectedWith(/1 transaction[\s\S]*Nothing was sent/);
    });
  });
});
