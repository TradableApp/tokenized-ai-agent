const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  sameValue,
  isRevert,
  RehearsalError,
  describeFailure,
} = require("../scripts/rehearsal/values");
const {
  snapshotPath,
  legacySnapshotPath,
  writeSnapshot,
  readSnapshot,
  checkLegacySnapshot,
} = require("../scripts/rehearsal/snapshot");

describe("scripts/rehearsal", function () {
  const AGENT = "0x1111111111111111111111111111111111111111";
  const ESCROW = "0x2222222222222222222222222222222222222222";
  const OTHER = "0x3333333333333333333333333333333333333333";

  function scratchFile(name = "snapshot.json") {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rehearsal-state-")), name);
  }

  describe("sameValue", function () {
    it("compares amounts as numbers whatever their type", function () {
      expect(sameValue(2n, "2")).to.equal(true);
      expect(sameValue("2", 2n)).to.equal(true);
      expect(sameValue(2n, 3n)).to.equal(false);
    });

    it("compares addresses without regard to letter case", function () {
      expect(sameValue(AGENT.toUpperCase().replace("0X", "0x"), AGENT)).to.equal(true);
      expect(sameValue(AGENT, ESCROW)).to.equal(false);
    });
  });

  describe("describeFailure", function () {
    it("is only the message for one of the script's own refusals", function () {
      expect(describeFailure(new RehearsalError("Nothing was sent."))).to.equal(
        "Nothing was sent.",
      );
    });

    it("carries the stack of anything else, so an unexpected failure can be traced", function () {
      const error = new TypeError("cannot read properties of undefined");

      const text = describeFailure(error);

      expect(text).to.include("cannot read properties of undefined");
      expect(text).to.include(error.stack);
    });

    it("carries the stack of the error a refusal was made from", function () {
      const cause = new Error("socket hang up");
      const text = describeFailure(new RehearsalError("[fee-set] failed", { cause }));

      expect(text).to.include("[fee-set] failed");
      expect(text).to.include(cause.stack);
    });
  });

  describe("isRevert", function () {
    it("takes a call exception for a revert", function () {
      expect(isRevert({ code: "CALL_EXCEPTION", message: "x" })).to.equal(true);
    });

    it("never takes a node's own coded error for a revert, whatever its text", function () {
      expect(isRevert({ code: "SERVER_ERROR", message: "request reverted" })).to.equal(false);
    });

    it("takes an uncoded error that says it reverted for a revert", function () {
      expect(isRevert(new Error("VM Exception: reverted"))).to.equal(true);
      expect(isRevert(new Error("socket hang up"))).to.equal(false);
    });
  });

  const PAIR = { agent: AGENT, escrow: ESCROW };
  const EXPECTED = { pair: PAIR, network: "baseSepolia", chainId: 84532n };

  /** A snapshot as the forward phase keeps it in memory. */
  function snapshot(overrides = {}) {
    return {
      network: "baseSepolia",
      chainId: 84532n,
      pair: PAIR,
      safe: OTHER,
      rehearsalPromptFee: 2n,
      baseline: { agentOwner: AGENT, treasury: ESCROW, promptFee: 1n },
      steps: {},
      confirmed: false,
      ...overrides,
    };
  }

  /** Text that never appears in a message: the file is moved aside, never deleted. */
  function expectNoDelete(fn) {
    let message = "";
    try {
      fn();
    } catch (error) {
      message = error.message;
    }
    expect(message).to.not.equal("");
    expect(message).to.match(/move it aside/i);
    expect(message).to.not.match(/delete/i);
    return message;
  }

  describe("snapshotPath", function () {
    it("is in its own folder, outside Hardhat's cache, named by network and agent", function () {
      const file = snapshotPath({ root: "/repo", network: "baseSepolia", agent: AGENT });

      expect(file).to.equal(
        path.join("/repo", "rehearsal-state", `admin-rehearsal.baseSepolia.${AGENT}.json`),
      );
    });

    it("names the agent the same whatever the letter case it is given in", function () {
      const mixed = snapshotPath({
        root: "/repo",
        network: "base",
        agent: "0xAbCd000000000000000000000000000000000001",
      });
      const lower = snapshotPath({
        root: "/repo",
        network: "base",
        agent: "0xabcd000000000000000000000000000000000001",
      });

      expect(mixed).to.equal(lower);
      expect(mixed).to.equal(
        path.join(
          "/repo",
          "rehearsal-state",
          "admin-rehearsal.base.0xabcd000000000000000000000000000000000001.json",
        ),
      );
    });

    it("is a different file for another agent on the same network", function () {
      expect(snapshotPath({ root: "/r", network: "base", agent: AGENT })).to.not.equal(
        snapshotPath({ root: "/r", network: "base", agent: OTHER }),
      );
    });
  });

  describe("legacySnapshotPath", function () {
    it("is the file earlier versions wrote in Hardhat's cache, named by network only", function () {
      expect(legacySnapshotPath({ root: "/repo", network: "baseSepolia" })).to.equal(
        path.join("/repo", "cache", "admin-rehearsal.baseSepolia.json"),
      );
    });
  });

  describe("writeSnapshot", function () {
    it("writes version 2 with every field, amounts as text", function () {
      const file = scratchFile();

      writeSnapshot(file, snapshot({ steps: { "fee-set": { status: "sent", txHash: "0xab" } } }));

      const written = JSON.parse(fs.readFileSync(file, "utf8"));
      expect(written).to.deep.include({
        version: 2,
        network: "baseSepolia",
        chainId: "84532",
        pair: PAIR,
        safe: OTHER,
        rehearsalPromptFee: "2",
        baseline: { agentOwner: AGENT, treasury: ESCROW, promptFee: "1" },
        steps: { "fee-set": { status: "sent", txHash: "0xab" } },
        confirmed: false,
      });
      expect(Date.parse(written.updatedAt)).to.not.be.NaN;
    });

    it("creates the folder, and leaves no temporary file beside the snapshot", function () {
      const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rehearsal-state-")), "nested");
      const file = path.join(dir, "snapshot.json");

      writeSnapshot(file, snapshot());

      expect(fs.readdirSync(dir)).to.deep.equal(["snapshot.json"]);
    });

    it("replaces the snapshot whole", function () {
      const file = scratchFile();
      writeSnapshot(file, snapshot({ steps: { a: { status: "done" }, b: { status: "done" } } }));

      writeSnapshot(file, snapshot({ steps: { a: { status: "done" } } }));

      expect(JSON.parse(fs.readFileSync(file, "utf8")).steps).to.deep.equal({
        a: { status: "done" },
      });
    });

    it("leaves the snapshot that was there as it was when the new one cannot be written", function () {
      const file = scratchFile();
      writeSnapshot(file, snapshot());
      const before = fs.readFileSync(file, "utf8");
      // The temporary file cannot be created where a folder of the same name stands.
      fs.mkdirSync(`${file}.tmp-${process.pid}`);

      expect(() => writeSnapshot(file, snapshot({ confirmed: true }))).to.throw();

      expect(fs.readFileSync(file, "utf8")).to.equal(before);
    });
  });

  describe("readSnapshot", function () {
    it("is null where there is no snapshot", function () {
      expect(readSnapshot(scratchFile(), EXPECTED)).to.equal(null);
    });

    it("reads back what was written, amounts as numbers", function () {
      const file = scratchFile();
      const steps = { "fee-set": { status: "done", txHash: "0xab", blockNumber: 7 } };
      writeSnapshot(file, snapshot({ steps }));

      const read = readSnapshot(file, EXPECTED);

      expect(read).to.deep.include({
        version: 2,
        safe: OTHER,
        rehearsalPromptFee: 2n,
        steps,
        confirmed: false,
      });
      expect(read.baseline).to.deep.equal({ agentOwner: AGENT, treasury: ESCROW, promptFee: 1n });
    });

    it("refuses a file that is not JSON, and never takes it for a missing snapshot", function () {
      const file = scratchFile();
      fs.writeFileSync(file, '{"version": 2, "pair": ');

      const message = expectNoDelete(() => readSnapshot(file, EXPECTED));

      expect(message).to.include(file);
      expect(message).to.match(/not JSON/);
    });

    it("refuses a version 2 snapshot of another escrow", function () {
      const file = scratchFile();
      writeSnapshot(file, snapshot({ pair: { agent: AGENT, escrow: OTHER } }));

      expect(expectNoDelete(() => readSnapshot(file, EXPECTED))).to.match(/another pair/);
    });

    it("refuses a version 2 snapshot of another network", function () {
      const file = scratchFile();
      writeSnapshot(file, snapshot({ network: "base" }));

      expect(expectNoDelete(() => readSnapshot(file, EXPECTED))).to.match(/network base/);
    });

    it("refuses a version 2 snapshot of another chain", function () {
      const file = scratchFile();
      writeSnapshot(file, snapshot({ chainId: 8453n }));

      expect(expectNoDelete(() => readSnapshot(file, EXPECTED))).to.match(/chain 8453/);
    });

    it("refuses a snapshot written by a version of the script it does not know", function () {
      const file = scratchFile();
      fs.writeFileSync(file, JSON.stringify({ version: 3, pair: PAIR }));

      expect(expectNoDelete(() => readSnapshot(file, EXPECTED))).to.match(/version 3/);
    });

    describe("a version 1 snapshot, from before steps were recorded", function () {
      function write(pair, extra = {}) {
        const file = scratchFile();
        const raw = { promptFee: "1", treasury: OTHER, ...(pair ? { pair } : {}), ...extra };
        fs.writeFileSync(file, JSON.stringify(raw));
        return file;
      }

      it("is read as version 1 with its values as the baseline and no steps", function () {
        const file = write(PAIR, { safe: OTHER, confirmed: true });

        const read = readSnapshot(file, EXPECTED);

        expect(read).to.deep.include({ version: 1, safe: OTHER, confirmed: true, steps: {} });
        expect(read.baseline).to.deep.equal({ promptFee: 1n, treasury: OTHER });
      });

      it("is refused when its escrow alone is another one", function () {
        const file = write({ agent: AGENT, escrow: OTHER });

        expect(expectNoDelete(() => readSnapshot(file, EXPECTED))).to.match(/another pair/);
      });

      it("is refused when its agent alone is another one", function () {
        const file = write({ agent: OTHER, escrow: ESCROW });

        expect(expectNoDelete(() => readSnapshot(file, EXPECTED))).to.match(/another pair/);
      });

      it("is refused when it does not say which pair it was taken for", function () {
        const file = write(null);

        expect(expectNoDelete(() => readSnapshot(file, EXPECTED))).to.match(
          /does not say which pair/,
        );
      });
    });
  });

  describe("checkLegacySnapshot", function () {
    const MOVE_TO = "/repo/rehearsal-state/admin-rehearsal.baseSepolia.x.json";

    function legacy(content) {
      const file = scratchFile("admin-rehearsal.baseSepolia.json");
      fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
      return file;
    }

    function check(file) {
      const lines = [];
      checkLegacySnapshot({ file, pair: PAIR, moveTo: MOVE_TO, log: (l) => lines.push(String(l)) });
      return lines;
    }

    it("does nothing where there is no file", function () {
      expect(check(scratchFile())).to.deep.equal([]);
    });

    it("refuses an unconfirmed one of this pair, which may be the only baseline, and leaves it", function () {
      const file = legacy({ promptFee: "1", pair: PAIR });
      const before = fs.readFileSync(file, "utf8");

      const message = expectNoDelete(() => check(file));

      expect(message).to.include(file);
      expect(message).to.include(MOVE_TO);
      expect(message).to.match(/only record/);
      expect(fs.readFileSync(file, "utf8")).to.equal(before);
    });

    for (const [what, content] of [
      ["a confirmed one of this pair", { promptFee: "1", pair: PAIR, confirmed: true }],
      ["one of another pair", { promptFee: "1", pair: { agent: AGENT, escrow: OTHER } }],
    ]) {
      it(`warns about ${what}, uses nothing of it and leaves it where it is`, function () {
        const file = legacy(content);
        const before = fs.readFileSync(file, "utf8");

        const lines = check(file);

        expect(lines).to.have.lengthOf(1);
        expect(lines[0]).to.include(file);
        expect(lines[0]).to.match(/left where it is/);
        expect(lines[0]).to.not.match(/delete/i);
        expect(fs.readFileSync(file, "utf8")).to.equal(before);
      });
    }

    // The old in-place write, cut off part-way, leaves exactly such a file of this pair.
    for (const [what, content, why] of [
      ["one that does not say which pair", { promptFee: "1" }, /does not say which pair/],
      ["one that is not JSON", '{"promptFee": "1", "pa', /not JSON/],
    ]) {
      it(`refuses ${what}, which may be the only baseline, and leaves it`, function () {
        const file = legacy(content);
        const before = fs.readFileSync(file, "utf8");

        const message = expectNoDelete(() => check(file));

        expect(message).to.include(file);
        expect(message).to.match(why);
        expect(fs.readFileSync(file, "utf8")).to.equal(before);
      });
    }

    it("reports a file it cannot read as what it is, not as a file that is not JSON", function () {
      const file = scratchFile("admin-rehearsal.baseSepolia.json");
      fs.mkdirSync(file);

      const message = expectNoDelete(() => check(file));

      expect(message).to.include("EISDIR");
      expect(message).to.not.match(/not JSON/);
    });
  });
});
