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

      p.begin("room-A", { sources: [{ title: "A source", url: "https://example.test/a" }] });
      p.begin("room-B", { sources: [{ title: "B source", url: "https://example.test/b" }] });

      // Interleaved exactly as a p-queue with concurrency 5 would deliver them.
      p.recordThought("room-A", "A first", "GET_ASSET_SENTIMENT");
      p.recordThought("room-B", "B first", "GET_NEWS");
      p.recordThought("room-A", "A second");
      p.recordThought("room-B", "B second");

      const a = p.finish("room-A");
      const b = p.finish("room-B");

      expect(a.reasoning.map(s => s.description)).to.deep.equal(["A first", "A second"]);
      expect(b.reasoning.map(s => s.description)).to.deep.equal(["B first", "B second"]);
      expect(a.sources).to.deep.equal([{ title: "A source", url: "https://example.test/a" }]);
      expect(b.sources).to.deep.equal([{ title: "B source", url: "https://example.test/b" }]);
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
      p.begin("room-A", { sources: [] });
      expect(p.size()).to.equal(1);
      p.finish("room-A");
      expect(p.size(), "a finished run must not be retained — the oracle is long-lived").to.equal(0);
    });

    it("flushes what it has when a run is abandoned", () => {
      // ElizaOS emits RUN_TIMEOUT as well as RUN_ENDED. A timed-out run must still surrender
      // its partial reasoning rather than silently discarding it.
      const p = createRunProvenance();
      p.begin("room-A", { sources: [] });
      p.recordThought("room-A", "got this far", "GET_ASSET_SENTIMENT");

      const out = p.finish("room-A");
      expect(out.reasoning).to.have.length(1);
      expect(p.size()).to.equal(0);
    });

    it("evicts the oldest run when the cap is reached", () => {
      // Defence in depth: if a run never ends (crash between begin and finish), the map must not
      // grow without bound inside a process that runs for weeks in a TEE.
      const p = createRunProvenance({ maxRuns: 2 });
      p.begin("r1", { sources: [] });
      p.begin("r2", { sources: [] });
      p.begin("r3", { sources: [] });

      expect(p.size()).to.equal(2);
      expect(p.finish("r1"), "the oldest run should have been evicted").to.deep.equal({
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
      p.begin("room-A", { sources: [] });
      p.actionStarted("room-A", "GET_ASSET_SENTIMENT");
      p.recordThought("room-A", "Cache miss — fetching fresh metrics");
      p.actionCompleted("room-A", "GET_ASSET_SENTIMENT");
      p.recordThought("room-A", "Weighing the macro backdrop");

      expect(p.finish("room-A").reasoning).to.deep.equal([
        { title: "GET_ASSET_SENTIMENT", description: "Cache miss — fetching fresh metrics" },
        { title: "Step 2", description: "Weighing the macro backdrop" },
      ]);
    });

    it("produces exactly the MessageFile contract", () => {
      // formatters.js writes these straight into the encrypted MessageFile, and the dApp types
      // them as {title,description} / {title,url}. e2e T-REASON-01 asserts the hrefs round-trip.
      const p = createRunProvenance();
      p.begin("room-A", { sources: [{ title: "S", url: "https://example.test/s" }] });
      p.recordThought("room-A", "thinking", "ACT");

      const out = p.finish("room-A");
      expect(Object.keys(out).sort()).to.deep.equal(["reasoning", "sources"]);
      expect(out.reasoning[0]).to.have.all.keys("title", "description");
      expect(out.sources[0]).to.have.all.keys("title", "url");
    });

    it("never throws on malformed input", () => {
      const p = createRunProvenance();
      p.begin("room-A", undefined);
      expect(() => p.recordThought("room-A", null)).to.not.throw();
      expect(() => p.recordThought("room-A", "   ")).to.not.throw();
      expect(p.finish("room-A")).to.deep.equal({ reasoning: [], sources: [] });
    });
  });
});
