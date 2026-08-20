const { expect } = require("chai");
const proxyquire = require("proxyquire").noCallThru();

// Which AI tier actually served each answer (CU-86d438hwt).
//
// THE FAILURE THIS EXISTS TO CATCH is documented in queryAIModel's own comment: a retired or
// misspelled GOOGLE_* model id makes Gemini 404 the generateContent call, queryElizaOS throws,
// and the dispatcher falls through to ChainGPT "with no reasoning or sources. The answer
// degrades silently rather than erroring". It happened, it was fixed, and nothing would have
// told us it was happening — every prompt still got an answer, just a worse one.
//
// A tier mix in the heartbeat turns that from invisible into obvious: elizaos drops to zero,
// chaingpt jumps, and the shape of the degradation is visible in Slack the same day.
//
// COUNTERS, NOT GAUGES — deliberately cumulative rather than drained per beat. A drained tally
// loses its window whenever a beat fails, and beats are explicitly allowed to fail. Monotonic
// counters are loss-tolerant: a missed beat costs resolution, never data, because the next
// beat's total still includes it. Core takes the difference between consecutive beats.

function load() {
  return proxyquire("../src/providerTally", {});
}

describe("providerTally", () => {
  it("starts at zero for every known tier", () => {
    const { createTally } = load();
    const t = createTally();
    expect(t.snapshot()).to.deep.equal({
      tradable: 0,
      elizaos: 0,
      chaingpt: 0,
      deepseek: 0,
      mock: 0,
      none: 0,
    });
  });

  it("counts each tier that serves", () => {
    const { createTally } = load();
    const t = createTally();
    t.recordServed("elizaos");
    t.recordServed("elizaos");
    t.recordServed("chaingpt");

    const s = t.snapshot();
    expect(s.elizaos).to.equal(2);
    expect(s.chaingpt).to.equal(1);
    expect(s.deepseek).to.equal(0);
  });

  it("is CUMULATIVE — reading does not reset it", () => {
    const { createTally } = load();
    const t = createTally();
    t.recordServed("elizaos");
    expect(t.snapshot().elizaos).to.equal(1);
    // A drained tally would report 0 here, and a failed beat would silently eat the window.
    expect(t.snapshot().elizaos).to.equal(1);
    t.recordServed("elizaos");
    expect(t.snapshot().elizaos).to.equal(2);
  });

  it("returns a COPY, so a consumer cannot corrupt the counters", () => {
    const { createTally } = load();
    const t = createTally();
    t.recordServed("elizaos");
    const s = t.snapshot();
    s.elizaos = 9999;
    expect(t.snapshot().elizaos).to.equal(1);
  });

  it("ignores an unknown tier instead of throwing or inventing a bucket", () => {
    const { createTally } = load();
    const t = createTally();
    // This runs on the paid answer path. A typo must never be able to throw here, and a
    // silently-created bucket would drift from what core knows how to render.
    expect(() => t.recordServed("gpt5-turbo-ultra")).to.not.throw();
    expect(t.snapshot()).to.not.have.property("gpt5-turbo-ultra");
    expect(t.recordServed).to.be.a("function");
  });

  it("tracks `none` when every tier failed, so a total outage is not an absence of data", () => {
    const { createTally } = load();
    const t = createTally();
    t.recordServed("none");
    // Zero across the board would be indistinguishable from "no prompts arrived". A total
    // provider outage must look different from a quiet hour.
    expect(t.snapshot().none).to.equal(1);
  });

  it("exposes a module-level singleton, since the dispatcher and the heartbeat are separate modules", () => {
    const mod = load();
    expect(mod.providerTally).to.exist;
    expect(mod.providerTally.snapshot).to.be.a("function");
    expect(mod.providerTally.recordServed).to.be.a("function");
  });
});
