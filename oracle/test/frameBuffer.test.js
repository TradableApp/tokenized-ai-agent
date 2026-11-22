const { expect } = require("chai");
const sinon = require("sinon");

const { STREAM_HTTP } = require("../src/stream/streamContract");
const { createFrameBuffer, BUFFER_LIMITS } = require("../src/stream/frameBuffer");

/**
 * The frame buffer is the stream server's memory: what each answer's current run has sent, so a
 * reader that connects late or reconnects gets the frames it missed. It knows nothing about HTTP.
 */

const RUN_A = "0123456789abcdef";
const RUN_B = "fedcba9876543210";
const PROOF = "zmsj4OksK8D2N9JMs__j2qRCsgSGomdTiRR9Dl6UUb4";
const GRACE_MS = 120000;
// A well-formed sealed frame: base64 IV, a dot, base64 ciphertext. Made up.
const sealed = (n = 8) => `oKGio6Slpqeoqaqr.${"A".repeat(n)}`;

function openWithFrames(buffer, id, run, count) {
  buffer.open(id, { run, replica: "deadbeef", expectedProof: PROOF });
  for (let seq = 0; seq < count; seq += 1) buffer.append(id, { run, seq, ciphertext: sealed() });
}

describe("frameBuffer", () => {
  let clock;
  let buffer;

  beforeEach(() => {
    clock = sinon.useFakeTimers();
    buffer = createFrameBuffer({ graceMs: GRACE_MS });
  });

  afterEach(() => {
    buffer.dispose();
    clock.restore();
  });

  it("has the limits the plan sets: 1 MiB per answer, 64 MiB in all, 512 open answers", () => {
    expect(BUFFER_LIMITS.maxAnswerBytes).to.equal(1024 * 1024);
    expect(BUFFER_LIMITS.maxTotalBytes).to.equal(64 * 1024 * 1024);
    expect(BUFFER_LIMITS.maxOpenAnswers).to.equal(512);
  });

  describe("replay", () => {
    it("replays the current run from seq 0 when there is no cursor", () => {
      openWithFrames(buffer, "42", RUN_A, 3);
      expect(buffer.framesAfter("42", null).map((f) => f.seq)).to.deep.equal([0, 1, 2]);
    });

    it("replays only the frames after a cursor in the current run", () => {
      openWithFrames(buffer, "42", RUN_A, 3);
      const frames = buffer.framesAfter("42", { run: RUN_A, seq: 0 });
      expect(frames.map((f) => f.seq)).to.deep.equal([1, 2]);
      expect(frames.every((f) => f.run === RUN_A && f.ciphertext === sealed())).to.equal(true);
    });

    it("replays the current run from seq 0 when the cursor names another run", () => {
      openWithFrames(buffer, "42", RUN_A, 3);
      expect(buffer.framesAfter("42", { run: RUN_B, seq: 1 }).map((f) => f.seq)).to.deep.equal([
        0, 1, 2,
      ]);
    });

    it("gives nothing for a cursor at the last frame", () => {
      openWithFrames(buffer, "42", RUN_A, 3);
      expect(buffer.framesAfter("42", { run: RUN_A, seq: 2 })).to.deep.equal([]);
    });

    it("starts again when a new run opens: the earlier run's frames are gone", () => {
      openWithFrames(buffer, "42", RUN_A, 3);
      openWithFrames(buffer, "42", RUN_B, 1);
      expect(buffer.lookup("42").run).to.equal(RUN_B);
      expect(buffer.framesAfter("42", { run: RUN_A, seq: 0 }).map((f) => f.run)).to.deep.equal([
        RUN_B,
      ]);
    });
  });

  describe("what it refuses to keep", () => {
    it("ignores a frame of another run, a repeated seq and a skipped seq", () => {
      openWithFrames(buffer, "42", RUN_A, 2);
      expect(buffer.append("42", { run: RUN_B, seq: 2, ciphertext: sealed() })).to.equal(false);
      expect(buffer.append("42", { run: RUN_A, seq: 1, ciphertext: sealed() })).to.equal(false);
      expect(buffer.append("42", { run: RUN_A, seq: 5, ciphertext: sealed() })).to.equal(false);
      expect(buffer.framesAfter("42", null)).to.have.length(2);
    });

    it("ignores a frame for an answer that was never opened", () => {
      expect(buffer.append("7", { run: RUN_A, seq: 0, ciphertext: sealed() })).to.equal(false);
      expect(buffer.lookup("7").state).to.equal("unknown");
    });

    it("refuses a frame after its run was closed", () => {
      openWithFrames(buffer, "42", RUN_A, 1);
      buffer.close("42", { run: RUN_A, outcome: "answered" });
      expect(buffer.append("42", { run: RUN_A, seq: 1, ciphertext: sealed() })).to.equal(false);
      expect(buffer.framesAfter("42", null).map((f) => f.seq)).to.deep.equal([0]);
    });

    it("refuses ciphertext that is not the sealed iv.ct shape, so nothing can break an SSE line", () => {
      buffer.open("42", { run: RUN_A, replica: "deadbeef", expectedProof: PROOF });
      for (const bad of ["abc\ndata: x", "no-dot", "a.b c", "", 42, null]) {
        expect(buffer.append("42", { run: RUN_A, seq: 0, ciphertext: bad }), String(bad)).to.equal(
          false,
        );
      }
    });
  });

  describe("after done", () => {
    it("keeps a finished answer for the grace period, then answers 'gone' for ten minutes", () => {
      openWithFrames(buffer, "42", RUN_A, 2);
      buffer.close("42", { run: RUN_A, outcome: "answered" });
      expect(buffer.lookup("42").state).to.equal("finished");

      // One millisecond short of the grace period (GRACE_MS = 120000) it is still replayable.
      clock.tick(GRACE_MS - 1);
      expect(buffer.lookup("42").state).to.equal("finished");
      expect(buffer.framesAfter("42", null)).to.have.length(2);

      // At the grace period the frames are dropped and a tombstone takes their place.
      clock.tick(1);
      expect(buffer.lookup("42").state).to.equal("gone");
      expect(buffer.framesAfter("42", null)).to.deep.equal([]);

      // The tombstone lasts STREAM_HTTP.tombstoneMs (10 minutes = 600000 ms) from the drop.
      expect(STREAM_HTTP.tombstoneMs).to.equal(10 * 60 * 1000);
      clock.tick(STREAM_HTTP.tombstoneMs - 1);
      expect(buffer.lookup("42").state).to.equal("gone");
      clock.tick(1);
      expect(buffer.lookup("42").state).to.equal("unknown");
    });

    it("leaves no tombstone after an interrupted run, since a retry may follow", () => {
      openWithFrames(buffer, "42", RUN_A, 2);
      buffer.close("42", { run: RUN_A, outcome: "interrupted" });
      clock.tick(GRACE_MS);
      expect(buffer.lookup("42").state).to.equal("unknown");
    });

    it("lets a new run open over a finished one and over a tombstone", () => {
      openWithFrames(buffer, "42", RUN_A, 2);
      buffer.close("42", { run: RUN_A, outcome: "abandoned" });
      openWithFrames(buffer, "42", RUN_B, 1);
      expect(buffer.lookup("42")).to.include({ state: "open", run: RUN_B });

      buffer.close("42", { run: RUN_B, outcome: "answered" });
      clock.tick(GRACE_MS);
      expect(buffer.lookup("42").state).to.equal("gone");
      openWithFrames(buffer, "42", RUN_A, 1);
      expect(buffer.lookup("42").state).to.equal("open");
    });

    it("ignores a close for a run that is not the current one", () => {
      openWithFrames(buffer, "42", RUN_A, 1);
      expect(buffer.close("42", { run: RUN_B, outcome: "answered" })).to.equal(false);
      expect(buffer.lookup("42").state).to.equal("open");
    });

    it("keeps the proof for a finished answer until it is dropped", () => {
      openWithFrames(buffer, "42", RUN_A, 1);
      buffer.close("42", { run: RUN_A, outcome: "answered" });
      expect(buffer.lookup("42").expectedProof).to.equal(PROOF);
      clock.tick(GRACE_MS);
      expect(buffer.lookup("42").expectedProof).to.equal(undefined);
    });
  });

  describe("caps", () => {
    const frameBytes = sealed(100).length; // what one frame counts against the caps

    it("marks an answer unavailable when its run grows past its byte cap", () => {
      const small = createFrameBuffer({
        graceMs: GRACE_MS,
        limits: { ...BUFFER_LIMITS, maxAnswerBytes: frameBytes * 2 },
      });
      small.open("42", { run: RUN_A, replica: "deadbeef", expectedProof: PROOF });
      expect(small.append("42", { run: RUN_A, seq: 0, ciphertext: sealed(100) })).to.equal(true);
      expect(small.append("42", { run: RUN_A, seq: 1, ciphertext: sealed(100) })).to.equal(true);
      expect(small.append("42", { run: RUN_A, seq: 2, ciphertext: sealed(100) })).to.equal(false);
      expect(small.lookup("42").state).to.equal("unavailable");
      expect(small.stats().bytes, "its frames are freed").to.equal(0);
      small.dispose();
    });

    it("makes room under the total cap by dropping finished answers first", () => {
      const small = createFrameBuffer({
        graceMs: GRACE_MS,
        limits: { ...BUFFER_LIMITS, maxTotalBytes: frameBytes * 2 },
      });
      small.open("1", { run: RUN_A, replica: "deadbeef", expectedProof: PROOF });
      small.append("1", { run: RUN_A, seq: 0, ciphertext: sealed(100) });
      small.close("1", { run: RUN_A, outcome: "answered" });
      small.open("2", { run: RUN_B, replica: "deadbeef", expectedProof: PROOF });
      small.append("2", { run: RUN_B, seq: 0, ciphertext: sealed(100) });

      expect(small.append("2", { run: RUN_B, seq: 1, ciphertext: sealed(100) })).to.equal(true);
      expect(small.lookup("1").state, "the finished answer was dropped").to.equal("gone");

      // Nothing finished is left to drop: the growing answer is marked unavailable.
      expect(small.append("2", { run: RUN_B, seq: 2, ciphertext: sealed(100) })).to.equal(false);
      expect(small.lookup("2").state).to.equal("unavailable");
      small.dispose();
    });

    it("refuses a new answer past the open-answer cap, unless a finished one can make room", () => {
      const small = createFrameBuffer({
        graceMs: GRACE_MS,
        limits: { ...BUFFER_LIMITS, maxOpenAnswers: 2 },
      });
      const open = (id) =>
        small.open(id, { run: RUN_A, replica: "deadbeef", expectedProof: PROOF });
      expect(open("1")).to.equal(true);
      expect(open("2")).to.equal(true);
      expect(open("3")).to.equal(false);
      expect(small.lookup("3").state).to.equal("unavailable");

      small.close("1", { run: RUN_A, outcome: "answered" });
      expect(open("4")).to.equal(true);
      expect(small.lookup("1").state).to.equal("gone");
      // A refused answer that is later opened is served normally.
      small.close("2", { run: RUN_A, outcome: "answered" });
      expect(open("3")).to.equal(true);
      expect(small.lookup("3").state).to.equal("open");
      small.dispose();
    });
  });

  describe("subscribers", () => {
    it("hears each new frame, and an end when the run is closed", () => {
      openWithFrames(buffer, "42", RUN_A, 1);
      const heard = [];
      buffer.subscribe("42", (event) => heard.push(event));
      buffer.append("42", { run: RUN_A, seq: 1, ciphertext: sealed() });
      buffer.close("42", { run: RUN_A, outcome: "answered" });
      expect(heard.map((e) => e.kind)).to.deep.equal(["frame", "end"]);
      expect(heard[0].frame.seq).to.equal(1);
    });

    it("hears the new run's frames when a run replaces the one it was following", () => {
      openWithFrames(buffer, "42", RUN_A, 1);
      const heard = [];
      buffer.subscribe("42", (event) => heard.push(event));
      openWithFrames(buffer, "42", RUN_B, 1);
      expect(heard.map((e) => e.kind)).to.deep.equal(["frame"]);
      expect(heard[0].frame).to.include({ run: RUN_B, seq: 0 });
    });

    it("hears an end when the answer becomes unavailable or is dropped", () => {
      const small = createFrameBuffer({
        graceMs: GRACE_MS,
        limits: { ...BUFFER_LIMITS, maxAnswerBytes: 10 },
      });
      small.open("42", { run: RUN_A, replica: "deadbeef", expectedProof: PROOF });
      const heard = [];
      small.subscribe("42", (event) => heard.push(event.kind));
      small.append("42", { run: RUN_A, seq: 0, ciphertext: sealed(100) });
      expect(heard).to.deep.equal(["end"]);
      small.dispose();
    });

    it("keeps going when one subscriber throws", () => {
      openWithFrames(buffer, "42", RUN_A, 1);
      const heard = [];
      buffer.subscribe("42", () => {
        throw new Error("boom");
      });
      buffer.subscribe("42", (event) => heard.push(event.kind));
      expect(() =>
        buffer.append("42", { run: RUN_A, seq: 1, ciphertext: sealed() }),
      ).to.not.throw();
      expect(heard).to.deep.equal(["frame"]);
    });

    it("stops calling a subscriber that unsubscribed", () => {
      openWithFrames(buffer, "42", RUN_A, 1);
      const heard = [];
      const unsubscribe = buffer.subscribe("42", (event) => heard.push(event.kind));
      unsubscribe();
      buffer.append("42", { run: RUN_A, seq: 1, ciphertext: sealed() });
      expect(heard).to.deep.equal([]);
    });
  });
});
