const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { expect } = require("chai");

const {
  streamProof,
  LIMITS,
  parseSseEventId,
  MAX_SEALED_FRAME_CHARS,
} = require("../src/stream/streamContract");
const {
  createAnswerStream,
  createOfflineStream,
  streamCounters,
  noteThoughtDropped,
  setThoughtDropListener,
  THOUGHT_DROP_KINDS,
  DEFAULT_TASK_TIMEOUT_MS,
  DEFAULT_FLUSH_TIMEOUT_MS,
  FLUSH_MARGIN_MS,
} = require("../src/stream/answerStream");
const { THOUGHT_SANITIZE_TIMEOUT_MS } = require("../src/stream/thoughtSanitizer");
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

    it("never sends or stores a javascript: or data: source beside an https one", async () => {
      const { stream, sink } = newStream();
      const unsafe = [
        source("Script link", "javascript:alert(document.domain)"),
        source("Script link, mixed case", "  JaVaScRiPt:alert(1)"),
        source("Data link", "data:text/html,<script>alert(1)</script>"),
        source("Data link, base64", "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="),
      ];

      stream.sources([unsafe[0], source("Safe", "https://ok.test/safe"), ...unsafe.slice(1)]);
      await stream.flush();

      const sent = sink.frames().filter((f) => f.type === "sources").flatMap((f) => f.data.sources);
      expect(sent).to.deep.equal([{ title: "Safe", url: "https://ok.test/safe" }]);
      expect(stream.record().sources).to.deep.equal([{ attempt: 1, title: "Safe", url: "https://ok.test/safe" }]);
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

    it("omits the answer frame when its content id is over the limit or not an id", async () => {
      for (const cid of ["x".repeat(LIMITS.answerCidChars + 1), "bafy/../x", "", "bafy x"]) {
        const { stream, sink } = newStream();

        stream.answer({ text: "Fine.", answerMessageCID: cid });
        stream.done("answered");
        await stream.flush();

        expect(sink.frames().map((f) => f.type), cid).to.deep.equal(["reset", "done"]);
      }
    });

    it("sends the largest legal answer, within the answer frame limit once sealed", async () => {
      const { stream, sink } = newStream();
      const cid = "A".repeat(LIMITS.answerCidChars);

      stream.answer({ text: "\x01".repeat(LIMITS.answerTextBytes), answerMessageCID: cid, reasoningDuration: 1 });
      await stream.flush();

      const sent = sink.calls.filter((c) => c.method === "frame").at(-1).info.ciphertext;
      const frame = decryptFrame(sent, KEY);
      expect(frame.type).to.equal("answer");
      expect(frame.data.answerMessageCID).to.equal(cid);
      expect(Buffer.byteLength(JSON.stringify(frame), "utf-8")).to.be.at.most(LIMITS.answerFramePlaintextBytes);
      expect(sent.length).to.be.at.most(MAX_SEALED_FRAME_CHARS);
    });

    it("builds the answer frame against the answer frame limit, never unbounded", () => {
      const source = fs.readFileSync(path.join(__dirname, "../src/stream/answerStream.js"), "utf-8");

      expect(source).to.match(/emit\(FRAME_TYPES\.ANSWER, data, LIMITS\.answerFramePlaintextBytes\)/);
      expect(source).to.not.match(/Infinity/);
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
      expect(Object.keys(after).sort()).to.deep.equal([
        "framesBuilt",
        "sealFailures",
        "sinkFailures",
        "thoughtsDropped",
      ]);
      expect(Object.keys(after.thoughtsDropped).sort()).to.deep.equal(
        [...THOUGHT_DROP_KINDS].sort(),
      );
    });

    it("counts a dropped thought by its kind only, and hands the kind to the listener", () => {
      const heard = [];
      setThoughtDropListener((kind) => heard.push(kind));
      try {
        const before = streamCounters.snapshot().thoughtsDropped;
        noteThoughtDropped("timeout");
        noteThoughtDropped("unavailable");
        noteThoughtDropped("not-a-kind");
        const after = streamCounters.snapshot().thoughtsDropped;

        expect(after.timeout - before.timeout).to.equal(1);
        expect(after.unavailable - before.unavailable).to.equal(1);
        expect(Object.keys(after)).to.not.include("not-a-kind");
        expect(heard).to.deep.equal(["timeout", "unavailable"]);
      } finally {
        setThoughtDropListener(null);
      }
    });

    it("is not hurt by a listener that throws", () => {
      setThoughtDropListener(() => {
        throw new Error("alert broke");
      });
      try {
        expect(() => noteThoughtDropped("timeout")).to.not.throw();
      } finally {
        setThoughtDropListener(null);
      }
    });

    it("hands out a copy, so a reader cannot change the counts", () => {
      const snapshot = streamCounters.snapshot();
      snapshot.thoughtsDropped.timeout += 1000;

      expect(streamCounters.snapshot().thoughtsDropped.timeout).to.not.equal(
        snapshot.thoughtsDropped.timeout,
      );
    });
  });

  describe("work queued for a run", () => {
    it("starts each piece of work when it is queued, so slow work does not hold back the work behind it", async () => {
      const { stream } = newStream();
      const started = [];
      const work = (name) => () => {
        started.push(name);
        return new Promise((resolve) => setTimeout(() => resolve(step(name, `${name} step.`)), 20));
      };

      stream.step(work("One"));
      stream.step(work("Two"));
      stream.step(work("Three"));
      await Promise.resolve();

      expect(started).to.deep.equal(["One", "Two", "Three"]);
      await stream.flush();
      expect(stream.record().reasoning.map((s) => s.title)).to.deep.equal(["One", "Two", "Three"]);
    });

    it("derives the flush bound from the task bound, which outlasts the thought sanitiser's own limit", () => {
      // Every piece of work is settled (applied or cut off) within the task bound of being queued,
      // so a flush waits at most that long for the work queued before it, plus a margin.
      expect(DEFAULT_FLUSH_TIMEOUT_MS).to.equal(DEFAULT_TASK_TIMEOUT_MS + FLUSH_MARGIN_MS);
      expect(DEFAULT_TASK_TIMEOUT_MS).to.be.greaterThan(THOUGHT_SANITIZE_TIMEOUT_MS);
    });

    it("waits for slow work queued before it, however many pieces are queued", async () => {
      const { stream } = newStream({ taskTimeoutMs: 200, flushTimeoutMs: 300 });
      const slow = (name) => () =>
        new Promise((resolve) => setTimeout(() => resolve(step(name, `${name} step.`)), 150));

      // Run one after the other these would need 600 ms; started when queued they need 150.
      for (const name of ["A", "B", "C", "D"]) stream.step(slow(name));
      await stream.flush();

      expect(stream.record().reasoning.map((s) => s.title)).to.deep.equal(["A", "B", "C", "D"]);
    });

    it("numbers a step by its place in the attempt when its work gives a function of that number", async () => {
      const { stream, sink } = newStream();
      const later = (ms, description) => () =>
        new Promise((resolve) =>
          setTimeout(() => resolve((index) => step(`Step ${index + 1}`, description)), ms),
        );

      stream.step(later(30, "Arrived first, finished last."));
      stream.step(() => null);
      stream.step(later(1, "Arrived third, finished first."));
      stream.attempt();
      stream.step(later(1, "The next attempt counts again."));
      await stream.flush();

      expect(
        sink
          .frames()
          .filter((f) => f.type === "step")
          .map((f) => f.data.title),
      ).to.deep.equal(["Step 1", "Step 2", "Step 1"]);
    });

    it("counts a step whose work finishes after the record was read, and neither streams nor stores it", async () => {
      const { stream, sink } = newStream();
      const before = streamCounters.snapshot().thoughtsDropped.late;

      stream.step(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve(step("Late", "Finished too late.")), 30),
          ),
      );
      const record = stream.record();
      await stream.flush();

      expect(streamCounters.snapshot().thoughtsDropped.late - before).to.equal(1);
      expect(sink.frames().filter((f) => f.type === "step")).to.have.length(0);
      expect(record.reasoning).to.deep.equal([]);
      expect(stream.record()).to.deep.equal(record);
    });

    it("counts a step whose work is cut off and then gives a step", async () => {
      const { stream } = newStream({ taskTimeoutMs: 20 });
      const before = streamCounters.snapshot().thoughtsDropped.late;

      stream.step(
        () => new Promise((resolve) => setTimeout(() => resolve(step("Late", "Too late.")), 60)),
      );
      stream.step(() => new Promise((resolve) => setTimeout(() => resolve(null), 60)));
      await stream.flush();
      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(streamCounters.snapshot().thoughtsDropped.late - before).to.equal(1);
    });
  });

  describe("sealing", () => {
    it("sends no sources frame, and does not retry a shorter list, when the sources cannot be sealed", async () => {
      let calls = 0;
      const ivSource = () => {
        calls += 1;
        if (calls === 2) throw new Error("no randomness");
        return crypto.randomBytes(12);
      };
      const before = streamCounters.snapshot().sealFailures;
      const { stream, sink } = newStream({ ivSource });

      stream.sources([source("A", "https://a.test/1"), source("B", "https://b.test/2")]);
      stream.step(step("One", "After the sources."));
      await stream.flush();

      expect(sink.frames().map((f) => f.type)).to.deep.equal(["reset", "step"]);
      expect(stream.record().sources).to.deep.equal([]);
      expect(streamCounters.snapshot().sealFailures - before).to.equal(1);
    });

    it("seals every frame of a run with its own IV, across every frame type", async () => {
      const { stream, sink } = newStream();

      stream.sources([source("A", "https://a.test")]);
      stream.step(step("One", "First."));
      stream.attempt();
      stream.step(step("Two", "Second."));
      stream.answer({ text: "The answer.", answerMessageCID: "bafy" });
      stream.done("answered");
      await stream.flush();

      const calls = sink.calls.filter((c) => c.method === "frame");
      expect(sink.frames().map((f) => f.type)).to.deep.equal([
        "reset",
        "sources",
        "step",
        "attempt",
        "step",
        "answer",
        "done",
      ]);
      const ivs = calls.map((c) => c.info.ciphertext.split(".")[0]);
      expect(new Set(ivs).size).to.equal(ivs.length);
      for (const iv of ivs) expect(Buffer.from(iv, "base64")).to.have.length(12);
    });

    it("takes no sequence number for a frame it could not seal, so the frames after it leave no gap", async () => {
      let calls = 0;
      const ivSource = () => {
        calls += 1;
        if (calls === 3) throw new Error("no randomness");
        return crypto.randomBytes(12);
      };
      const before = streamCounters.snapshot();
      const { stream, sink } = newStream({ ivSource });

      stream.step(step("One", "Sealed."));
      stream.step(step("Two", "Not sealed."));
      stream.step(step("Three", "Sealed again."));
      stream.done("answered");
      await stream.flush();

      const frames = sink.frames();
      expect(frames.map((f) => f.seq)).to.deep.equal([0, 1, 2, 3]);
      expect(sink.calls.filter((c) => c.method === "frame").map((c) => c.info.seq)).to.deep.equal([
        0, 1, 2, 3,
      ]);
      expect(frames.filter((f) => f.type === "step").map((f) => f.data.title)).to.deep.equal([
        "One",
        "Three",
      ]);
      expect(stream.record().reasoning.map((s) => s.title)).to.deep.equal(["One", "Three"]);
      const after = streamCounters.snapshot();
      expect(after.sealFailures - before.sealFailures).to.equal(1);
      expect(after.sinkFailures - before.sinkFailures).to.equal(0);
    });
  });
});
