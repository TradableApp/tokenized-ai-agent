const { expect } = require("chai");
const fs = require("node:fs");
const path = require("node:path");

// STRUCTURAL GUARD over queryAIModel's instrumentation (CU-86d438hwt).
//
// This exists because of a bug that shipped past unit tests, a hand audit, and my own review.
//
// The tally calls were first placed like this:
//
//     providerTally.recordServed("chaingpt");
//     return asAnswer(await queryChainGPT(...));      // <- throws
//
// which counts a chaingpt SUCCESS and then, from the catch, a `deepseek` or `none` as well. One
// failed prompt increments two counters, and the mix — the whole reason the tally exists — is
// quietly wrong in exactly the outage it was built to make visible.
//
// The audit I wrote at the time asked "does a recordServed call precede each return?" and got a
// clean answer, because that is the WRONG QUESTION. The property is not proximity, it is ORDER:
// the tally must be recorded only after the awaited call has resolved. This encodes that.
//
// Structural rather than behavioural, deliberately: driving every dispatcher branch through
// handlePrompt with a failing provider stub costs far more than it catches, and the failure mode
// here is a textual one that a reader reproduces by writing the obvious thing.

describe("providerTally call-site ordering in queryAIModel", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/aiAgentOracle.js"), "utf-8");
  const lines = source.split("\n");
  const start = lines.findIndex((l) => l.startsWith("async function queryAIModel"));
  // Brace-counting rather than "first unindented }". The loose version happens to work today
  // only because queryAIModel is top-level and its closing brace is column 0; a refactor that
  // nests it, or a stray unindented brace inside a template literal, would silently shrink the
  // scanned range and make this whole file pass by covering nothing.
  const end = (() => {
    let depth = 0;
    for (let i = start; i < lines.length; i += 1) {
      depth += (lines[i].match(/\{/g) ?? []).length;
      depth -= (lines[i].match(/\}/g) ?? []).length;
      if (i > start && depth <= 0) return i;
    }

    return -1;
  })();

  it("locates the dispatcher (guards against this test silently covering nothing)", () => {
    expect(start).to.be.greaterThan(-1);
    expect(end).to.be.greaterThan(start);
    // The range must actually contain the instrumentation, or "no offenders" is vacuous.
    const body = lines.slice(start, end).join("\n");
    expect(body).to.include("providerTally.recordServed");
    expect(body).to.include("queryChainGPT");
    expect(body).to.include("queryDeepSeek");
  });

  it("never records a tier on the line before a `return` that still has to await", () => {
    const offenders = [];
    for (let i = start; i < end; i += 1) {
      if (!lines[i].includes("providerTally.recordServed(")) continue;
      // Look ahead past blank lines to the next statement.
      let j = i + 1;
      while (j < end && lines[j].trim() === "") j += 1;
      const next = lines[j] ?? "";
      if (next.includes("return") && next.includes("await")) {
        offenders.push(`L${i + 1}: ${lines[i].trim()} -> L${j + 1}: ${next.trim()}`);
      }
    }
    expect(
      offenders,
      `recordServed must fire AFTER the awaited call resolves, or a throw is counted twice:\n${offenders.join("\n")}`
    ).to.deep.equal([]);
  });

  it("still covers every return, which is the property the original audit did check", () => {
    let uncovered = 0;
    for (let i = start; i <= end; i += 1) {
      if (!/^\s*return /.test(lines[i])) continue;
      const window = lines.slice(Math.max(start, i - 6), i).join("\n");
      if (!window.includes("providerTally.recordServed")) uncovered += 1;
    }
    expect(uncovered, "every dispatcher return must record a tier").to.equal(0);
  });
});
