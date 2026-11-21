const crypto = require("crypto");
const { expect } = require("chai");

const { streamProof, LIMITS, parseSseEventId } = require("../src/stream/streamContract");
const {
  createAnswerStream,
  createOfflineStream,
  streamCounters,
} = require("../src/stream/answerStream");
const { decryptFrame } = require("./helpers/frameDecrypt");

// The answer stream builds the frames for one run of one answer, hands their ciphertext to a
// sink, and keeps the plaintext so that the stored record is a projection of exactly what was
// sent. Nothing in it may delay or lose a paid answer.

const KEY = crypto.randomBytes(32);
const ID = "457";

/** A sink that remembers every call; frames are decrypted for the assertions. */
function recordingSink() {
  const calls = [];
  return {
    calls,
    open: (id, info) => calls.push({ method: "open", id, info }),
    frame: (id, info) => calls.push({ method: "frame", id, info }),
    close: (id, info) => calls.push({ method: "close", id, info }),
    frames: () =>
      calls.filter((c) => c.method === "frame").map((c) => decryptFrame(c.info.ciphertext, KEY)),
  };
}

function newStream(extra = {}) {
  const sink = extra.sink ?? recordingSink();
  const stream = createAnswerStream({
    answerMessageId: ID,
    sessionKey: KEY,
    replica: "test-replica",
    sink,
    ...extra,
  });
  return { stream, sink };
}

const step = (title, description) => ({ title, description });
const source = (title, url) => ({ title, url });

describe("answer stream", () => {
  describe("run start", () => {
    it("opens the sink with the run, the replica and the expected proof, never the key", () => {
      const { stream, sink } = newStream();

      const open = sink.calls[0];
      expect(open.method).to.equal("open");
      expect(open.id).to.equal(ID);
      expect(open.info).to.deep.equal({
        run: stream.run,
        replica: "test-replica",
        expectedProof: streamProof(KEY, ID),
      });
      expect(JSON.stringify(open.info)).to.not.include(KEY.toString("base64"));
      expect(JSON.stringify(open.info)).to.not.include(KEY.toString("hex"));
    });

    it("sends reset as seq 0 of the run at once, reason start by default", () => {
      const { stream, sink } = newStream();

      const [reset] = sink.frames();
      expect(reset).to.deep.equal({
        v: 1,
        answerMessageId: ID,
        run: stream.run,
        seq: 0,
        replica: "test-replica",
        type: "reset",
        data: { reason: "start" },
      });
      expect(sink.calls[1].info).to.include({ run: stream.run, seq: 0 });
    });

    it("says retry when asked to", () => {
      const { sink } = newStream({ reason: "retry" });

      expect(sink.frames()[0].data).to.deep.equal({ reason: "retry" });
    });

    it("draws a new run id for each stream", () => {
      expect(newStream().stream.run).to.not.equal(newStream().stream.run);
      expect(newStream().stream.run).to.match(/^[0-9a-f]{16}$/);
    });
  });

  describe("order", () => {
    it("numbers frames contiguously from 0 and sends sources before the steps", async () => {
      const { stream, sink } = newStream();

      stream.sources([source("A", "https://a.test/1")]);
      stream.step(step("One", "First step taken."));
      stream.step(step("Two", "Second step taken."));
      await stream.flush();

      const frames = sink.frames();
      expect(frames.map((f) => f.seq)).to.deep.equal([0, 1, 2, 3]);
      expect(frames.map((f) => f.type)).to.deep.equal(["reset", "sources", "step", "step"]);
      expect(frames.every((f) => f.run === stream.run)).to.equal(true);
    });

    it("keeps the order in which steps were given even when their work finishes out of order", async () => {
      const { stream, sink } = newStream();
      const later = (ms, s) => () => new Promise((resolve) => setTimeout(() => resolve(s), ms));

      stream.step(later(30, step("Slow", "Arrived first, finished last.")));
      stream.step(later(1, step("Fast", "Arrived second, finished first.")));
      await stream.flush();

      expect(sink.frames().slice(1).map((f) => f.data.title)).to.deep.equal(["Slow", "Fast"]);
    });

    it("sends sources at most once per attempt and never after that attempt's first step", async () => {
      const { stream, sink } = newStream();

      stream.step(step("One", "A step before any sources."));
      stream.sources([source("Late", "https://late.test")]);
      stream.attempt();
      stream.sources([source("B", "https://b.test")]);
      stream.sources([source("C", "https://c.test")]);
      await stream.flush();

      const sources = sink.frames().filter((f) => f.type === "sources");
      expect(sources).to.have.length(1);
      expect(sources[0].data).to.deep.equal({
        attempt: 2,
        sources: [{ title: "B", url: "https://b.test" }],
      });
    });
  });

  describe("attempts", () => {
    it("sends an attempt frame for a fallback tier, not a reset, and keeps the earlier steps", async () => {
      const { stream, sink } = newStream();

      stream.step(step("One", "First provider, first step."));
      stream.step(step("Two", "First provider, second step."));
      stream.attempt();
      stream.step(step("Three", "Second provider's step."));
      await stream.flush();

      const frames = sink.frames();
      expect(frames.map((f) => f.type)).to.deep.equal(["reset", "step", "step", "attempt", "step"]);
      expect(frames[3].data).to.deep.equal({ attempt: 2 });
      expect(frames.filter((f) => f.type === "reset")).to.have.length(1);
      expect(stream.record().reasoning).to.deep.equal([
        { title: "One", description: "First provider, first step.", attempt: 1 },
        { title: "Two", description: "First provider, second step.", attempt: 1 },
        { title: "Three", description: "Second provider's step.", attempt: 2 },
      ]);
    });

    it("never numbers an attempt past the last tier", async () => {
      const { stream, sink } = newStream();

      for (let i = 0; i < 6; i += 1) stream.attempt();
      await stream.flush();

      expect(sink.frames().filter((f) => f.type === "attempt").map((f) => f.data.attempt)).to.deep.equal([
        2, 3, 4,
      ]);
    });
  });

  describe("the record is a projection of the frames", () => {
    it("equals the decrypted step and sources frames exactly", async () => {
      const { stream, sink } = newStream();

      stream.sources([source("A", "https://a.test/1"), source("B", "http://b.test/2")]);
      stream.step(step("GET_NEWS", "Read the latest headlines."));
      stream.attempt();
      stream.sources([source("C", "https://c.test/3")]);
      stream.step(step("Step 1", "Answered from the fallback."));
      await stream.flush();

      const frames = sink.frames();
      const projected = {
        reasoning: frames
          .filter((f) => f.type === "step")
          .map((f) => ({ title: f.data.title, description: f.data.description, attempt: f.data.attempt })),
        sources: frames
          .filter((f) => f.type === "sources")
          .flatMap((f) => f.data.sources.map((s) => ({ ...s, attempt: f.data.attempt }))),
      };
      expect(stream.record()).to.deep.equal(projected);
      expect(projected.sources).to.have.length(3);
    });

    it("truncates a long title and description before the frame, so the stored step is truncated identically", async () => {
      const { stream, sink } = newStream();

      stream.step(step("T".repeat(500), "D".repeat(10000)));
      await stream.flush();

      const sent = sink.frames()[1].data;
      expect(sent.title).to.have.length(LIMITS.stepTitleChars);
      expect(sent.description).to.have.length(LIMITS.stepDescriptionChars);
      expect(stream.record().reasoning[0]).to.deep.equal({ ...sent });
    });

    it("never splits a surrogate pair when it truncates", async () => {
      const { stream, sink } = newStream();

      stream.step(step(`${"a".repeat(LIMITS.stepTitleChars - 1)}😀`, "An emoji sits on the limit."));
      await stream.flush();

      const { title } = sink.frames()[1].data;
      expect(title).to.equal("a".repeat(LIMITS.stepTitleChars - 1));
    });

    it("neither streams nor stores steps past the limit for one attempt", async () => {
      const { stream, sink } = newStream();

      for (let i = 0; i < LIMITS.maxStepsPerAttempt + 10; i += 1) {
        stream.step(step(`S${i}`, `Step number ${i}.`));
      }
      stream.attempt();
      stream.step(step("Next", "The next attempt has its own allowance."));
      await stream.flush();

      const steps = sink.frames().filter((f) => f.type === "step");
      expect(steps).to.have.length(LIMITS.maxStepsPerAttempt + 1);
      expect(stream.record().reasoning).to.have.length(LIMITS.maxStepsPerAttempt + 1);
    });

    it("keeps only http and https sources, drops a too-long url, and caps the list and titles", async () => {
      const { stream, sink } = newStream();
      const list = [
        source("Good", "https://ok.test/a"),
        source("Script", "javascript:alert(1)"),
        source("Ftp", "ftp://files.test/x"),
        source("Huge", `https://ok.test/${"x".repeat(LIMITS.sourceUrlChars)}`),
        source("", "https://no-title.test"),
        source("Not a url", "not a url"),
        source("L".repeat(400), "https://ok.test/long-title"),
        ...Array.from({ length: 30 }, (_, i) => source(`More ${i}`, `https://ok.test/${i}`)),
      ];

      stream.sources(list);
      await stream.flush();

      const { sources } = sink.frames()[1].data;
      expect(sources.length).to.be.at.most(LIMITS.maxSourcesPerFrame);
      expect(sources[0]).to.deep.equal({ title: "Good", url: "https://ok.test/a" });
      expect(sources[1].title).to.have.length(LIMITS.sourceTitleChars);
      for (const s of sources) {
        expect(new URL(s.url).protocol).to.be.oneOf(["http:", "https:"]);
        expect(s.url.length).to.be.at.most(LIMITS.sourceUrlChars);
      }
    });

    it("trims a sources frame to fit the plaintext limit rather than sending an oversized frame", async () => {
      const { stream, sink } = newStream();
      const fat = Array.from({ length: 20 }, (_, i) =>
        source("T".repeat(300), `https://ok.test/${i}/${"p".repeat(1900)}`),
      );

      stream.sources(fat);
      await stream.flush();

      const call = sink.calls.find((c) => c.method === "frame" && c.info.seq === 1);
      const plain = JSON.stringify(decryptFrame(call.info.ciphertext, KEY));
      expect(Buffer.byteLength(plain, "utf-8")).to.be.at.most(LIMITS.framePlaintextBytes);
      expect(sink.frames()[1].data.sources.length).to.be.greaterThan(0);
      expect(stream.record().sources).to.have.length(sink.frames()[1].data.sources.length);
    });

    it("stops taking steps once the record has been read, so stored and streamed cannot differ", async () => {
      const { stream, sink } = newStream();

      stream.step(step("Before", "Read into the record."));
      await stream.flush();
      const record = stream.record();
      stream.step(step("After", "Too late for the record."));
      stream.sources([source("Late", "https://late.test")]);
      await stream.flush();

      expect(record.reasoning.map((s) => s.title)).to.deep.equal(["Before"]);
      expect(sink.frames().filter((f) => f.type === "step").map((f) => f.data.title)).to.deep.equal([
        "Before",
      ]);
      expect(stream.record()).to.deep.equal(record);
    });

    it("skips a step whose work gives nothing", async () => {
      const { stream, sink } = newStream();

      stream.step(() => null);
      stream.step(async () => null);
      stream.step(step("", "  "));
      stream.step(step("Kept", "This one is kept."));
      await stream.flush();

      expect(sink.frames().filter((f) => f.type === "step")).to.have.length(1);
    });
  });

  describe("answer and done", () => {
    it("sends the answer and then done, and closes the sink after done", async () => {
      const { stream, sink } = newStream();

      stream.answer({ text: "The answer.", answerMessageCID: "bafy-answer", reasoningDuration: 3 });
      stream.done("answered");
      await stream.flush();

      const frames = sink.frames();
      expect(frames.slice(-2)).to.deep.equal([
        { ...frames.at(-2), type: "answer", data: { text: "The answer.", answerMessageCID: "bafy-answer", reasoningDuration: 3 } },
        { ...frames.at(-1), type: "done", data: { outcome: "answered" } },
      ]);
      expect(sink.calls.at(-1)).to.deep.equal({
        method: "close",
        id: ID,
        info: { run: stream.run, outcome: "answered" },
      });
    });

    it("leaves reasoningDuration out of the answer frame when there is none", async () => {
      const { stream, sink } = newStream();

      stream.answer({ text: "Plain.", answerMessageCID: "bafy" });
      await stream.flush();

      expect(sink.frames().at(-1).data).to.deep.equal({ text: "Plain.", answerMessageCID: "bafy" });
    });

    it("sends at most one answer", async () => {
      const { stream, sink } = newStream();

      stream.answer({ text: "First.", answerMessageCID: "a" });
      stream.answer({ text: "Second.", answerMessageCID: "b" });
      await stream.flush();

      expect(sink.frames().filter((f) => f.type === "answer")).to.have.length(1);
    });

    it("omits the answer frame when its text is over 64 KiB of UTF-8", async () => {
      const { stream, sink } = newStream();

      stream.answer({ text: "é".repeat(LIMITS.answerTextBytes / 2 + 1), answerMessageCID: "big" });
      stream.done("answered");
      await stream.flush();

      expect(sink.frames().map((f) => f.type)).to.deep.equal(["reset", "done"]);
    });

    it("sends done exactly once and nothing after it", async () => {
      const { stream, sink } = newStream();

      stream.done("interrupted");
      stream.done("answered");
      stream.step(step("After", "Should not be sent."));
      stream.answer({ text: "Late.", answerMessageCID: "x" });
      stream.attempt();
      await stream.flush();

      expect(sink.frames().map((f) => f.type)).to.deep.equal(["reset", "done"]);
      expect(sink.frames().at(-1).data).to.deep.equal({ outcome: "interrupted" });
      expect(sink.calls.filter((c) => c.method === "close")).to.have.length(1);
    });

    it("ignores an outcome the contract does not name", async () => {
      const { stream, sink } = newStream();

      stream.done("exploded");
      await stream.flush();

      expect(sink.frames().map((f) => f.type)).to.deep.equal(["reset"]);
    });
  });

  describe("delivery can never hurt the answer", () => {
    it("a sink that throws on every call changes neither the record nor what the caller sees", async () => {
      const throwing = {
        open() {
          throw new Error("open broke");
        },
        frame() {
          throw new Error("frame broke");
        },
        close() {
          throw new Error("close broke");
        },
      };
      const before = streamCounters.snapshot().sinkFailures;
      const good = newStream();
      const bad = newStream({ sink: throwing });

      for (const { stream } of [good, bad]) {
        stream.sources([source("A", "https://a.test")]);
        stream.step(step("One", "The same step on both."));
        await stream.flush();
      }

      const strip = ({ reasoning, sources }) => ({ reasoning, sources });
      expect(strip(bad.stream.record())).to.deep.equal(strip(good.stream.record()));
      expect(() => bad.stream.done("answered")).to.not.throw();
      await bad.stream.flush();
      expect(streamCounters.snapshot().sinkFailures - before).to.be.at.least(4);
    });

    it("never waits on a sink that returns a promise that never settles", async () => {
      const hanging = {
        open: () => new Promise(() => {}),
        frame: () => new Promise(() => {}),
        close: () => new Promise(() => {}),
      };
      const { stream } = newStream({ sink: hanging });

      stream.step(step("One", "A step for a hanging sink."));
      stream.done("answered");
      const started = Date.now();
      await stream.flush();

      expect(Date.now() - started).to.be.lessThan(200);
      expect(stream.record().reasoning).to.have.length(1);
    });

    it("cuts off step work that hangs, and still sends what comes after it", async () => {
      const { stream, sink } = newStream({ taskTimeoutMs: 30 });

      stream.step(() => new Promise(() => {}));
      stream.step(step("After", "Arrives after the hung one."));
      stream.done("answered");
      await stream.flush();

      expect(sink.frames().map((f) => f.type)).to.deep.equal(["reset", "step", "done"]);
    });

    it("drops the result of step work that arrives after it was cut off", async () => {
      const { stream, sink } = newStream({ taskTimeoutMs: 20 });

      stream.step(() => new Promise((resolve) => setTimeout(() => resolve(step("Late", "Too late.")), 60)));
      await stream.flush();
      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(sink.frames().filter((f) => f.type === "step")).to.have.length(0);
      expect(stream.record().reasoning).to.have.length(0);
    });

    it("bounds how long flush can make the answer wait", async () => {
      const { stream } = newStream({ taskTimeoutMs: 10000, flushTimeoutMs: 40 });

      stream.step(() => new Promise(() => {}));
      const started = Date.now();
      await stream.flush();

      expect(Date.now() - started).to.be.lessThan(500);
    });

    it("step work that throws is skipped", async () => {
      const { stream, sink } = newStream();

      stream.step(() => {
        throw new Error("sanitiser blew up");
      });
      stream.step(async () => {
        throw new Error("async blow-up");
      });
      stream.step(step("Kept", "Still sent."));
      await stream.flush();

      expect(sink.frames().filter((f) => f.type === "step").map((f) => f.data.title)).to.deep.equal(["Kept"]);
    });

    it("never throws from any method, whatever it is given", async () => {
      const { stream } = newStream();

      expect(() => {
        stream.sources(null);
        stream.sources("nope");
        stream.sources([null, 1, { title: 2, url: {} }]);
        stream.step(undefined);
        stream.step(42);
        stream.answer(null);
        stream.answer({ text: 5 });
        stream.done(undefined);
      }).to.not.throw();
      await stream.flush();
      expect(stream.record()).to.deep.equal({ reasoning: [], sources: [] });
    });

    it("gives an inert stream, not a throw, when it cannot be built", async () => {
      for (const bad of [
        { sessionKey: Buffer.alloc(3) },
        { answerMessageId: "007" },
        { replica: "Not Valid" },
        { sink: null },
      ]) {
        let stream;
        expect(() => {
          stream = createAnswerStream({
            answerMessageId: ID,
            sessionKey: KEY,
            replica: "r1",
            sink: recordingSink(),
            ...bad,
          });
        }).to.not.throw();
        stream.step(step("One", "Goes nowhere."));
        stream.done("answered");
        await stream.flush();
        expect(stream.record().reasoning).to.be.an("array");
      }
    });

    it("bounds what one run can hold however many steps arrive", async () => {
      const { stream, sink } = newStream();

      for (let i = 0; i < 2000; i += 1) stream.step(step(`S${i}`, "x".repeat(4000)));
      for (let i = 0; i < 10; i += 1) stream.attempt();
      for (let i = 0; i < 2000; i += 1) stream.step(step(`T${i}`, "y".repeat(4000)));
      await stream.flush();

      const maxFrames = 1 + LIMITS.maxAttempts * (1 + LIMITS.maxStepsPerAttempt) + 2;
      expect(sink.frames().length).to.be.at.most(maxFrames);
      expect(stream.record().reasoning.length).to.be.at.most(LIMITS.maxAttempts * LIMITS.maxStepsPerAttempt);
    });
  });

  describe("event ids", () => {
    it("gives every frame a <run>.<seq> id the contract can read back", async () => {
      const { stream, sink } = newStream();

      stream.step(step("One", "First."));
      await stream.flush();

      for (const call of sink.calls.filter((c) => c.method === "frame")) {
        expect(parseSseEventId(`${call.info.run}.${call.info.seq}`)).to.deep.equal({
          run: stream.run,
          seq: call.info.seq,
        });
      }
    });
  });

  describe("offline stream", () => {
    it("builds the record from the same steps but sends nothing and needs no key", async () => {
      const stream = createOfflineStream();

      stream.sources([source("A", "https://a.test")]);
      stream.step(step("One", "Recorded offline."));
      stream.done("answered");
      await stream.flush();

      expect(stream.record()).to.deep.equal({
        reasoning: [{ title: "One", description: "Recorded offline.", attempt: 1 }],
        sources: [{ title: "A", url: "https://a.test", attempt: 1 }],
      });
    });
  });

  describe("counters", () => {
    it("counts the frames built, with no ids", async () => {
      const before = streamCounters.snapshot();
      const { stream } = newStream();

      stream.step(step("One", "Counted."));
      await stream.flush();

      const after = streamCounters.snapshot();
      expect(after.framesBuilt - before.framesBuilt).to.equal(2);
      expect(Object.keys(after).sort()).to.deep.equal(["framesBuilt", "sinkFailures"]);
    });
  });
});
