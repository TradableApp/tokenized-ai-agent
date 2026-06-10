"use strict";

const chai = require("chai");

const { expect } = chai;

const { reconcileCursor } = require("../src/blockCursor");

describe("reconcileCursor (reorg/revert-aware polling cursor)", function () {
  it("leaves the cursor unchanged on a normal forward chain", () => {
    // head ahead of cursor — the poll loop will scan [cursor+1 .. head]
    expect(reconcileCursor(10, 15)).to.equal(10);
  });

  it("leaves the cursor unchanged when the head equals the cursor", () => {
    expect(reconcileCursor(12, 12)).to.equal(12);
  });

  it("rewinds to just below the new head when the chain reorgs/reverts", () => {
    // Repro for the snapshot-revert / Base-reorg bug: head dropped from 12 to 10.
    // Returning head-1 (9) means the next poll re-scans block 10 onward — the
    // re-mined blocks — instead of waiting for the head to climb back past 12.
    expect(reconcileCursor(12, 10)).to.equal(9);
  });

  it("clamps at 0 when the head reverts all the way to genesis", () => {
    expect(reconcileCursor(12, 0)).to.equal(0);
  });

  it("never returns a negative cursor", () => {
    expect(reconcileCursor(5, 0)).to.be.at.least(0);
  });
});
