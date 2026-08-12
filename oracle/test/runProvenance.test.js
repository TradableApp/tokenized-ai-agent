const { expect } = require("chai");

const { createRunProvenance } = require("../src/runProvenance");

// Run-correlated provenance collector — CU-86d3ud1va, part 2.
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
// WHY NOW rather than when streaming lands. ElizaOS already exposes everything needed — sources
// are known before inference (composeState), actions and thoughts arrive during
// (ACTION_STARTED/COMPLETED, onResponse), the answer lands last. Building the buffered version
// on a run-correlated collector means future streaming to the dApp is a TRANSPORT change; the
// closure array would have to be thrown away instead.

describe("run provenance collector", () => {
  describe("correlation (the reason this is not a local array)", () => {
    it("keeps concurrent runs completely separate", () => {
      const p = createRunProvenance();

      const rA = p.begin("room-A", { sources: [{ title: "A source", url: "https://example.test/a" }] });
      const rB = p.begin("room-B", { sources: [{ title: "B source", url: "https://example.test/b" }] });

      // Interleaved exactly as a p-queue with concurrency 5 would deliver them.
      p.recordThought(rA, "A first", "GET_ASSET_SENTIMENT");
      p.recordThought(rB, "B first", "GET_NEWS");
      p.recordThought(rA, "A second");
      p.recordThought(rB, "B second");

      const a = p.finish(rA);
      const b = p.finish(rB);

      expect(a.reasoning.map(s => s.description)).to.deep.equal(["A first", "A second"]);
      expect(b.reasoning.map(s => s.description)).to.deep.equal(["B first", "B second"]);
      expect(a.sources).to.deep.equal([{ title: "A source", url: "https://example.test/a" }]);
      expect(b.sources).to.deep.equal([{ title: "B source", url: "https://example.test/b" }]);
    });


    it("keeps two concurrent runs in the SAME room separate", () => {
      // The gap review caught: the test above interleaves two DIFFERENT rooms, which proves
      // isolation across conversations and says nothing about two prompts for the SAME one.
      // roomId is stable per conversation, so a second PromptSubmitted entering the queue while
      // the first is in flight collides — and the failure is the bad kind: thoughts attributed
      // to the wrong answer, written into an immutable, already-paid-for MessageFile.
      const p = createRunProvenance();

      const runA = p.begin("room-shared", { sources: [{ title: "A", url: "https://x.test/a" }] });
      const runB = p.begin("room-shared", { sources: [{ title: "B", url: "https://x.test/b" }] });

      expect(runA, "begin must hand back a handle unique to the run").to.not.equal(runB);

      p.recordThought(runA, "A only");
      p.recordThought(runB, "B only");

      expect(p.finish(runA).reasoning.map(s => s.description)).to.deep.equal(["A only"]);
      expect(p.finish(runB).reasoning.map(s => s.description)).to.deep.equal(["B only"]);
    });

    it("does not attribute an action when two runs share a room", () => {
      // ACTION_STARTED carries only roomId, so with two runs in one room attribution is
      // genuinely ambiguous. Absent attribution beats wrong attribution when it is permanent.
      const p = createRunProvenance();
      const runA = p.begin("room-shared", { sources: [] });
      const runB = p.begin("room-shared", { sources: [] });

      p.actionStarted("room-shared", "GET_ASSET_SENTIMENT");
      p.recordThought(runA, "ambiguous");

      expect(p.finish(runA).reasoning[0].title).to.equal("Step 1");
      p.finish(runB);
    });

    it("drops the action already in flight when a room becomes ambiguous", () => {
      // The gap the soleRunIn guard does NOT close. soleRunIn stops a NEW action from being
      // attributed while a room holds two runs — but an action attributed while the room was
      // still solo stays pinned to that run, and its ACTION_COMPLETED is dropped by the very
      // same guard. So the label is never cleared, and every later thought inherits an action
      // that has already finished.
      //
      // That is a worse failure than the one the guard prevents: not "no attribution" but
      // "wrong attribution that looks right", written into an immutable, already-paid-for
      // MessageFile. Ambiguity must therefore invalidate attribution already in flight, not
      // merely block new attribution.
      const rp = createRunProvenance();

      const runA = rp.begin("room-shared", { sources: [] });
      rp.actionStarted("room-shared", "GET_ASSET_SENTIMENT");

      // Second prompt for the SAME conversation — the room is now ambiguous.
      const runB = rp.begin("room-shared", { sources: [] });

      // ACTION_COMPLETED for A's action lands, but soleRunIn drops it: nothing clears the label.
      rp.actionCompleted("room-shared", "GET_ASSET_SENTIMENT");
      rp.recordThought(runA, "Now weighing the macro backdrop");

      const a = rp.finish(runA);
      rp.finish(runB);

      expect(
        a.reasoning[0].title,
        "a completed action must not keep titling later thoughts",
      ).to.equal("Step 1");
    });

    it("attributes normally once the room is unambiguous again", () => {
      const p = createRunProvenance();
      const runA = p.begin("room-1", { sources: [] });
      p.actionStarted("room-1", "GET_ASSET_SENTIMENT");
      p.recordThought(runA, "attributed");

      expect(p.finish(runA).reasoning[0].title).to.equal("GET_ASSET_SENTIMENT");
    });

    it("ignores events for a run it never saw, instead of inventing one", () => {
      // A late or stray event must not conjure a run that then leaks, and must not throw on the
      // answer path.
      const p = createRunProvenance();
      expect(() => p.recordThought("never-began", "orphan")).to.not.throw();
      expect(p.size()).to.equal(0);
      expect(p.finish("never-began")).to.deep.equal({ reasoning: [], sources: [] });
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

    it("flushes what it has when a run is abandoned", () => {
      // ElizaOS emits RUN_TIMEOUT as well as RUN_ENDED. A timed-out run must still surrender
      // its partial reasoning rather than silently discarding it.
      const p = createRunProvenance();
      const run = p.begin("room-A", { sources: [] });
      p.recordThought(run, "got this far", "GET_ASSET_SENTIMENT");

      const out = p.finish(run);
      expect(out.reasoning).to.have.length(1);
      expect(p.size()).to.equal(0);
    });

    it("evicts the oldest run when the cap is reached", () => {
      // Defence in depth: if a run never ends (crash between begin and finish), the map must not
      // grow without bound inside a process that runs for weeks in a TEE.
      const p = createRunProvenance({ maxRuns: 2 });
      const r1 = p.begin("r1", { sources: [] });
      p.begin("r2", { sources: [] });
      p.begin("r3", { sources: [] });

      expect(p.size()).to.equal(2);
      expect(p.finish(r1), "the oldest run should have been evicted").to.deep.equal({
        reasoning: [],
        sources: [],
      });
    });
  });

  describe("output shape", () => {
    it("titles steps by the action in flight when the thought carries none", () => {
      // ACTION_STARTED tells us which action is running; onResponse delivers the thought without
      // that attribution. Pairing them is the whole point of listening to both.
      const p = createRunProvenance();
      const run = p.begin("room-A", { sources: [] });
      p.actionStarted("room-A", "GET_ASSET_SENTIMENT");
      p.recordThought(run, "Cache miss — fetching fresh metrics");
      p.actionCompleted("room-A", "GET_ASSET_SENTIMENT");
      p.recordThought(run, "Weighing the macro backdrop");

      expect(p.finish(run).reasoning).to.deep.equal([
        { title: "GET_ASSET_SENTIMENT", description: "Cache miss — fetching fresh metrics" },
        { title: "Step 2", description: "Weighing the macro backdrop" },
      ]);
    });

    it("produces exactly the MessageFile contract", () => {
      // formatters.js writes these straight into the encrypted MessageFile, and the dApp types
      // them as {title,description} / {title,url}. e2e T-REASON-01 asserts the hrefs round-trip.
      const p = createRunProvenance();
      const run = p.begin("room-A", { sources: [{ title: "S", url: "https://example.test/s" }] });
      p.recordThought(run, "thinking", "ACT");

      const out = p.finish(run);
      expect(Object.keys(out).sort()).to.deep.equal(["reasoning", "sources"]);
      expect(out.reasoning[0]).to.have.all.keys("title", "description");
      expect(out.sources[0]).to.have.all.keys("title", "url");
    });

    it("never throws on malformed input", () => {
      const p = createRunProvenance();
      const run = p.begin("room-A", undefined);
      expect(() => p.recordThought(run, null)).to.not.throw();
      expect(() => p.recordThought(run, "   ")).to.not.throw();
      expect(p.finish(run)).to.deep.equal({ reasoning: [], sources: [] });
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
    const runId = provenance.begin({ roomId: "room-1" });
    provenance.recordThought(runId, "thinking");

    const first = provenance.finish(runId);
    expect(first.reasoning.length, "the first call returns the real provenance").to.be.greaterThan(
      0,
    );

    const second = provenance.finish(runId);
    expect(second).to.deep.equal({ reasoning: [], sources: [] });
    expect(provenance.size(), "and the run stays released").to.equal(0);
  });
});
