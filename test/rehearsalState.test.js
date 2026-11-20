const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { sameValue, isRevert } = require("../scripts/rehearsal/values");
const { readSnapshot } = require("../scripts/rehearsal/snapshot");

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

  describe("readSnapshot and the pair it was taken for", function () {
    function write(pair) {
      const file = scratchFile();
      fs.writeFileSync(file, JSON.stringify({ promptFee: "1", treasury: OTHER, pair }));
      return file;
    }

    it("reads the snapshot of the pair it is asked for", function () {
      const file = write({ agent: AGENT, escrow: ESCROW });

      const { state } = readSnapshot(file, { agent: AGENT, escrow: ESCROW });

      expect(state.promptFee).to.equal(1n);
    });

    it("refuses a snapshot whose escrow alone is another one", function () {
      const file = write({ agent: AGENT, escrow: OTHER });

      expect(() => readSnapshot(file, { agent: AGENT, escrow: ESCROW })).to.throw(/another pair/);
    });

    it("refuses a snapshot whose agent alone is another one", function () {
      const file = write({ agent: OTHER, escrow: ESCROW });

      expect(() => readSnapshot(file, { agent: AGENT, escrow: ESCROW })).to.throw(/another pair/);
    });
  });
});
