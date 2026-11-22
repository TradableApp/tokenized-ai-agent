const { expect } = require("chai");

const { createRunProvenance } = require("../src/runProvenance");

// Run-correlated provenance collector.
//
// WHY THIS EXISTS RATHER THAN A LOCAL ARRAY. Today queryElizaOS accumulates reasoning in a
// closure-local array, which is safe precisely because each call owns one. Moving to ElizaOS's
// live signals changes that: `runtime.registerEvent(ACTION_STARTED, …)` registers on the
// RUNTIME, which is shared, while the oracle processes prompts through a p-queue with
// CONCURRENCY 5. A handler that simply appends would interleave thoughts from different users'
// prompts into each other's answers — and then write that into an immutable, already-paid-for
// MessageFile on decentralised storage. Correlation is therefore the core requirement, not a
// refinement.
//
// The same reasoning forces registration ONCE at startup rather than per prompt: a handler
// registered per call leaks one per prompt, and every leaked handler multiplies the cross-talk.
//
// It holds a run's sources and the action in flight. The steps themselves are the live stream's
// (`stream/answerStream.js`): a thought becomes a step there, from the thought itself, so this
// collector keeps no reasoning of its own.

describe("run provenance collector", () => {
  describe("correlation (the reason this is not a local array)", () => {
    it("keeps concurrent runs completely separate", () => {
      const p = createRunProvenance();

      const rA = p.begin("room-A", { sources: [{ title: "A source", url: "https://example.test/a" }] });
      const rB = p.begin("room-B", { sources: [{ title: "B source", url: "https://example.test/b" }] });

      // Interleaved exactly as a p-queue with concurrency 5 would deliver them.
      p.actionStarted("room-A", "GET_ASSET_SENTIMENT");
      p.actionStarted("room-B", "GET_NEWS");

      expect(p.currentActionOf(rA)).to.equal("GET_ASSET_SENTIMENT");
      expect(p.currentActionOf(rB)).to.equal("GET_NEWS");
      expect(p.finish(rA)).to.deep.equal({ sources: [{ title: "A source", url: "https://example.test/a" }] });
      expect(p.finish(rB)).to.deep.equal({ sources: [{ title: "B source", url: "https://example.test/b" }] });
    });

    it("keeps two concurrent runs in the SAME room separate", () => {
      // roomId is stable per conversation, so a second PromptSubmitted entering the queue while
      // the first is in flight shares the room. Each run still gets its own handle and keeps its
      // own sources.
      const p = createRunProvenance();

      const runA = p.begin("room-shared", { sources: [{ title: "A", url: "https://x.test/a" }] });
      const runB = p.begin("room-shared", { sources: [{ title: "B", url: "https://x.test/b" }] });

      expect(runA, "begin must hand back a handle unique to the run").to.not.equal(runB);
      expect(p.finish(runA).sources).to.deep.equal([{ title: "A", url: "https://x.test/a" }]);
      expect(p.finish(runB).sources).to.deep.equal([{ title: "B", url: "https://x.test/b" }]);
    });

    it("does not attribute an action when two runs share a room", () => {
      // ACTION_STARTED carries only roomId, so with two runs in one room attribution is
      // genuinely ambiguous. Absent attribution beats wrong attribution when it is permanent.
      const p = createRunProvenance();
      const runA = p.begin("room-shared", { sources: [] });
      const runB = p.begin("room-shared", { sources: [] });

      p.actionStarted("room-shared", "GET_ASSET_SENTIMENT");

      expect(p.currentActionOf(runA)).to.equal("");
      expect(p.currentActionOf(runB)).to.equal("");
    });

    it("drops the action already in flight when a room becomes ambiguous", () => {
      // soleRunIn stops a NEW action from being attributed while a room holds two runs, but an
      // action attributed while the room was still solo would stay pinned to that run, and its
      // ACTION_COMPLETED is dropped by the same guard. Ambiguity must therefore invalidate
      // attribution already in flight, not merely block new attribution.
      const rp = createRunProvenance();

      const runA = rp.begin("room-shared", { sources: [] });
      rp.actionStarted("room-shared", "GET_ASSET_SENTIMENT");

      // Second prompt for the SAME conversation: the room is now ambiguous.
      rp.begin("room-shared", { sources: [] });

      // ACTION_COMPLETED for A's action lands, but soleRunIn drops it: nothing clears the label.
      rp.actionCompleted("room-shared", "GET_ASSET_SENTIMENT");

      expect(
        rp.currentActionOf(runA),
        "a completed action must not keep titling later thoughts",
      ).to.equal("");
    });

    it("attributes normally once the room is unambiguous again", () => {
      const p = createRunProvenance();
      const runA = p.begin("room-1", { sources: [] });
      p.actionStarted("room-1", "GET_ASSET_SENTIMENT");

      expect(p.currentActionOf(runA)).to.equal("GET_ASSET_SENTIMENT");
    });

    it("ignores events for a run it never saw, instead of inventing one", () => {
      // A late or stray event must not conjure a run that then leaks, and must not throw on the
      // answer path.
      const p = createRunProvenance();
      expect(() => p.actionStarted("never-began", "ACT")).to.not.throw();
      expect(p.currentActionOf("never-began")).to.equal("");
      expect(p.size()).to.equal(0);
      expect(p.finish("never-began")).to.deep.equal({ sources: [] });
    });
  });

  describe("leak safety", () => {
    it("forgets a run once finished", () => {
      const p = createRunProvenance();
      const run = p.begin("room-A", { sources: [] });
      expect(p.size()).to.equal(1);
      p.finish(run);
      expect(p.size(), "a finished run must not be retained — the oracle is long-lived").to.equal(0);
    });

    it("surrenders its sources when a run is abandoned", () => {
      // ElizaOS emits RUN_TIMEOUT as well as RUN_ENDED. A timed-out run still hands back what
      // it gathered rather than silently discarding it.
      const p = createRunProvenance();
      const run = p.begin("room-A", { sources: [{ title: "S", url: "https://example.test/s" }] });

      expect(p.finish(run).sources).to.have.length(1);
      expect(p.size()).to.equal(0);
    });

    it("evicts the oldest run when the cap is reached", () => {
      // Defence in depth: if a run never ends (crash between begin and finish), the map must not
      // grow without bound inside a process that runs for weeks in a TEE.
      const p = createRunProvenance({ maxRuns: 2 });
      const r1 = p.begin("r1", { sources: [{ title: "S", url: "https://example.test/s" }] });
      p.begin("r2", { sources: [] });
      p.begin("r3", { sources: [] });

      expect(p.size()).to.equal(2);
      expect(p.finish(r1), "the oldest run should have been evicted").to.deep.equal({ sources: [] });
    });
  });

  describe("output shape", () => {
    it("hands back the sources in the MessageFile shape and nothing else", () => {
      // formatters.js writes the sources straight into the encrypted MessageFile, and the dApp
      // types them as {title,url}. The reasoning comes from the stream's record, not from here.
      const p = createRunProvenance();
      const run = p.begin("room-A", { sources: [{ title: "S", url: "https://example.test/s" }] });

      const out = p.finish(run);
      expect(Object.keys(out)).to.deep.equal(["sources"]);
      expect(out.sources[0]).to.have.all.keys("title", "url");
    });

    it("never throws on malformed input", () => {
      const p = createRunProvenance();
      const run = p.begin("room-A", undefined);
      expect(() => p.actionStarted("room-A", null)).to.not.throw();
      expect(p.currentActionOf(run)).to.equal("");
      expect(p.finish(run)).to.deep.equal({ sources: [] });
    });

    it("keeps no reasoning of its own: a thought becomes a step only in the live stream", () => {
      const p = createRunProvenance();

      expect(p).to.not.have.property("recordThought");
    });
  });
});

describe("finish is idempotent", () => {
  // LOAD-BEARING FOR aiAgentOracle's onComplete. That callback finishes the run in its success
  // branch and again in its catch, so if the success branch throws AFTER finishing, finish is
  // called twice. The catch is only correct because the second call is a no-op.
  //
  // Pinned here rather than asserted in a comment at the call site: the guarantee lives in this
  // module, so this is where a change that broke it would be made.
  it("returns empty provenance and does not throw on a second call", () => {
    const provenance = createRunProvenance();
    const runId = provenance.begin("room-1", { sources: [{ title: "S", url: "https://example.test/s" }] });

    const first = provenance.finish(runId);
    expect(first.sources, "the first call returns the real provenance").to.have.length(1);

    const second = provenance.finish(runId);
    expect(second).to.deep.equal({ sources: [] });
    expect(provenance.size(), "and the run stays released").to.equal(0);
  });
});

describe("the action in flight", () => {
  it("tells which action is in flight for a run, so a thought can keep the action it arrived under", () => {
    const p = createRunProvenance();
    const run = p.begin("room-A");

    expect(p.currentActionOf(run)).to.equal("");
    p.actionStarted("room-A", "GET_NEWS");
    expect(p.currentActionOf(run)).to.equal("GET_NEWS");
    p.actionCompleted("room-A", "GET_NEWS");
    expect(p.currentActionOf(run)).to.equal("");
    expect(p.currentActionOf("never-began")).to.equal("");
  });
});
