const crypto = require("crypto");
const { expect } = require("chai");
const sinon = require("sinon");
const proxyquire = require("proxyquire").noCallThru();
const { ethers } = require("ethers");

const { withTestKeys } = require("./helpers/oracleTestKeys");
const { decryptFrame } = require("./helpers/frameDecrypt");
const { initInboundPrompt } = require("../src/inboundPrompt");
const { streamProof } = require("../src/stream/streamContract");

// The answer path and the live stream, end to end with fakes: what is stored is what was
// streamed, the answer frame goes only after this run's submitAnswer receipt, every exit ends the
// run, and nothing the stream does can delay or lose a paid answer.

const SESSION_KEY = crypto.randomBytes(32);
const USER = "0x00000000000000000000000000000000000000aa";
const ALREADY_FINALIZED_SELECTOR = "0x5a1c0b3d";

const encryptForOracle = (obj) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", SESSION_KEY, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(obj)), cipher.final(), cipher.getAuthTag()]);
  return `${iv.toString("base64")}.${body.toString("base64")}`;
};
const promptPayload = (promptText, extra = {}) =>
  ethers.toUtf8Bytes(
    encryptForOracle({
      promptText,
      isNewConversation: false,
      previousMessageId: "1",
      previousMessageCID: "bafy-parent",
      ...extra,
    }),
  );
const fakeEvent = () => ({ blockNumber: 1, getBlock: () => Promise.resolve({ timestamp: Date.now() }) });

/** A sink that keeps every call in order, and decrypts frames for the assertions. */
function recordingSink(events) {
  const calls = [];
  const push = (method) => (id, info) => {
    calls.push({ method, id, info });
    events?.push(`sink.${method}`);
  };
  return {
    calls,
    open: push("open"),
    frame: push("frame"),
    close: push("close"),
    frames: (id) =>
      calls
        .filter((c) => c.method === "frame" && (id === undefined || c.id === id))
        .map((c) => decryptFrame(c.info.ciphertext, SESSION_KEY)),
  };
}

/**
 * ElizaOS stand-in. Each prompt text maps to a script: the thoughts it emits, then either an
 * answer or a failure.
 */
function makeEliza(scriptFor) {
  const handlers = {};
  const runtime = {
    agentId: "agent-uuid",
    ensureConnection: sinon.stub().resolves(),
    createMemory: sinon.stub().resolves(),
    getMemoryById: sinon.stub().resolves(null),
    composeState: sinon.stub().callsFake(async (message) => ({
      values: {},
      text: "",
      data: {
        providers: {
          MARKET_INTELLIGENCE: {
            data: { latestNews: scriptFor(message.content.text).sources ?? [] },
          },
        },
      },
    })),
    registerEvent: (event, handler) => {
      handlers[event] = handler;
    },
  };
  class ElizaOS {
    async addAgents() {
      return ["fake-agent-id"];
    }
    async startAgents() {}
    getAgent() {
      return runtime;
    }
    async handleMessage(_target, message, options) {
      const script = scriptFor(message.content.text);
      for (const thought of script.thoughts ?? []) {
        if (script.gapMs) await new Promise((resolve) => setTimeout(resolve, script.gapMs));
        await options.onResponse({ thought });
      }
      if (script.fail) {
        options.onError(script.fail);
        return {};
      }
      await options.onResponse({ text: script.answer, actions: ["REPLY"] });
      options.onComplete();
      return {};
    }
  }
  return { ElizaOS, runtime };
}

function loadOracle({ scriptFor = () => ({ thoughts: [], answer: "An answer." }), mockAi = false, events } = {}) {
  process.env.PRIVATE_KEY = ethers.Wallet.createRandom().privateKey;
  if (mockAi) process.env.MOCK_AI = "true";
  else delete process.env.MOCK_AI;

  const uploads = [];
  const contract = {
    target: "0xMockedContractAddress",
    isJobFinalized: sinon.stub().resolves(false),
    submitAnswer: sinon.stub().callsFake(async () => ({
      wait: async () => {
        events?.push("receipt");
        return { hash: "0xTxHash" };
      },
    })),
    interface: {
      getError: (name) => (name === "JobAlreadyFinalized" ? { selector: ALREADY_FINALIZED_SELECTOR } : null),
      parseLog: sinon.stub(),
      getEvent: (name) => ({ topicHash: `topic:${name}` }),
    },
  };
  const components = {
    provider: { getNetwork: sinon.stub().resolves({ chainId: 1 }), getBlockNumber: sinon.stub().resolves(1) },
    signer: { address: "0xOracleAddress" },
    contract,
    isSapphire: false,
  };
  const eliza = makeEliza(scriptFor);
  const stubs = {
    "./storage/storage": {
      initializeStorage: sinon.stub().resolves(),
      uploadData: sinon.stub().callsFake(async (buffer) => {
        const cid = `bafy${crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 16)}`;
        uploads.push({ cid, text: buffer.toString("utf-8") });
        return cid;
      }),
      fetchData: sinon.stub().resolves(
        encryptForOracle({ id: "1", role: "user", content: "Earlier prompt", parentCID: null }),
      ),
      queryTransactionByTags: sinon.stub().resolves(null),
    },
    "./contractUtility": { initializeOracle: sinon.stub().returns(components) },
    "./roflUtility": { submitTx: sinon.stub().resolves("0xRoflTxHash") },
    "./oracleHeartbeat": { startOracleHeartbeat: sinon.stub().resolves({ stop() {} }) },
    "./alerting": { sendAlert: sinon.stub().resolves() },
    "./answerActivity": { recordAnswerActivity: sinon.stub().resolves() },
    "./geminiDirect": {
      classifyIntent: sinon.stub().resolves("MARKET"),
      queryGeminiDirect: sinon.stub().resolves("Direct Gemini answer."),
    },
    "./ecies": {
      eciesDecrypt: sinon.stub().resolves(SESSION_KEY),
      eciesEncrypt: sinon.stub().resolves(Buffer.from("enc")),
      publicKeyFromPrivateKey: sinon.stub().returns(`04${"0f".repeat(64)}`),
    },
    "@elizaos/core": {
      setAllowedEnvVars() {},
      ElizaOS: eliza.ElizaOS,
      elizaLogger: { info() {}, log() {}, error() {}, warn() {}, debug() {} },
      stringToUuid: (s) => s,
      createUniqueUuid: (_ns, s) => s,
      ChannelType: { DM: "DM", WORLD: "WORLD" },
      EventType: { ACTION_STARTED: "ACTION_STARTED", ACTION_COMPLETED: "ACTION_COMPLETED" },
    },
    "./elizaos/plugins/plugin-senseai/dist/index.js": { default: {} },
    "./elizaos/character.js": {},
    "@sentry/node": {
      init() {},
      captureException: sinon.stub(),
      captureMessage: sinon.stub(),
      startSpan: (_o, fn) => fn && fn({}),
      getCurrentScope: () => ({ setTag() {}, setUser() {} }),
    },
  };
  const oracle = withTestKeys(proxyquire("../src/aiAgentOracle", stubs), stubs["./ecies"]);
  oracle.initForTest(components);
  const sink = recordingSink(events);
  oracle.setStreamSink(sink);

  /** The stored answer MessageFile, decrypted. */
  const storedAnswer = () =>
    uploads
      .map((u) => {
        try {
          return { cid: u.cid, file: decryptFrame(u.text, SESSION_KEY) };
        } catch {
          return null;
        }
      })
      .filter((u) => u && u.file.role === "assistant");

  return { oracle, stubs, contract, sink, uploads, storedAnswer };
}

/** What the stored record must be: the projection of the run's step and sources frames. */
function projection(frames) {
  return {
    reasoning: frames
      .filter((f) => f.type === "step")
      .map((f) => ({ title: f.data.title, description: f.data.description, attempt: f.data.attempt })),
    sources: frames
      .filter((f) => f.type === "sources")
      .flatMap((f) => f.data.sources.map((s) => ({ ...s, attempt: f.data.attempt }))),
  };
}

const runsOf = (frames) => [...new Set(frames.map((f) => f.run))];

describe("answer path and live stream", function () {
  this.timeout(10000);

  before(async () => {
    await initInboundPrompt();
  });

  afterEach(() => {
    sinon.restore();
    delete process.env.MOCK_AI;
    delete process.env.CHAIN_GPT_API_KEY;
  });

  describe("stored equals streamed", () => {
    it("stores the projection of the sink's frames, and the answer frame carries the stored text and CID", async () => {
      const events = [];
      const { oracle, sink, storedAnswer } = loadOracle({
        events,
        scriptFor: () => ({
          sources: [{ title: "BTC ETF inflows accelerate", url: "https://example.test/a" }],
          thoughts: ["Reading the latest market headlines.", "Weighing the macro backdrop today."],
          answer: "Bitcoin looks firm this week.",
        }),
      });

      await oracle.handlePrompt(USER, 9, 456, 457, promptPayload("How is BTC?"), "0xkey", fakeEvent());
      await oracle.flushStreamsForTest();

      const frames = sink.frames("457");
      const [stored] = storedAnswer();
      expect(stored, "an answer was stored").to.exist;
      expect({ reasoning: stored.file.reasoning, sources: stored.file.sources }).to.deep.equal(projection(frames));
      expect(stored.file.reasoning).to.have.length(2);
      expect(stored.file.sources).to.have.length(1);

      const answer = frames.find((f) => f.type === "answer");
      expect(answer.data.text).to.equal(stored.file.content);
      expect(Buffer.from(answer.data.text).equals(Buffer.from(stored.file.content))).to.equal(true);
      expect(answer.data.answerMessageCID).to.equal(stored.cid);
      expect(answer.data.reasoningDuration).to.equal(stored.file.reasoningDuration);
      expect(frames.map((f) => f.type)).to.deep.equal(["reset", "sources", "step", "step", "answer", "done"]);
      expect(frames.at(-1).data).to.deep.equal({ outcome: "answered" });
      expect(frames.map((f) => f.seq)).to.deep.equal([0, 1, 2, 3, 4, 5]);
      expect(runsOf(frames)).to.have.length(1);
    });

    it("opens the run with the proof for this answer, never the key", async () => {
      const { oracle, sink } = loadOracle();

      await oracle.handlePrompt(USER, 9, 456, 457, promptPayload("Hello there"), "0xkey", fakeEvent());

      const open = sink.calls.find((c) => c.method === "open");
      expect(open.id).to.equal("457");
      expect(open.info.expectedProof).to.equal(streamProof(SESSION_KEY, "457"));
      expect(JSON.stringify(sink.calls.map((c) => c.info))).to.not.include(SESSION_KEY.toString("base64"));
    });

    it("sends the answer frame only after this run's submitAnswer receipt", async () => {
      const events = [];
      const { oracle, sink } = loadOracle({ events });

      await oracle.handlePrompt(USER, 9, 456, 457, promptPayload("Hello there"), "0xkey", fakeEvent());
      await oracle.flushStreamsForTest();

      // sink.calls and the sink.* entries of `events` are pushed together, so the answer's
      // position among the sink calls finds its place in the event log.
      const answerCall = sink.calls.findIndex(
        (c) => c.method === "frame" && decryptFrame(c.info.ciphertext, SESSION_KEY).type === "answer",
      );
      const sinkEventAt = events.reduce((at, e, i) => (e.startsWith("sink.") ? [...at, i] : at), []);
      const receiptAt = events.indexOf("receipt");
      expect(receiptAt).to.be.greaterThan(-1);
      expect(answerCall).to.be.greaterThan(-1);
      expect(sinkEventAt[answerCall]).to.be.greaterThan(receiptAt);
    });

    it("keeps the steps of a failed ElizaOS run, marked attempt 1, when ChainGPT answers", async () => {
      process.env.CHAIN_GPT_API_KEY = "test-key";
      sinon.stub(global, "fetch").resolves({ ok: true, text: async () => "ChainGPT answer here." });
      const { oracle, sink, storedAnswer } = loadOracle({
        scriptFor: () => ({
          thoughts: ["Reading the latest market headlines.", "Checking the funding rates now."],
          fail: new Error("model 404"),
        }),
      });

      await oracle.handlePrompt(USER, 9, 456, 457, promptPayload("How is ETH?"), "0xkey", fakeEvent());
      await oracle.flushStreamsForTest();

      const frames = sink.frames("457");
      const [stored] = storedAnswer();
      expect(stored.file.content).to.equal("ChainGPT answer here.");
      expect(stored.file.reasoning).to.deep.equal([
        { title: "Step 1", description: "Reading the latest market headlines.", attempt: 1 },
        { title: "Step 2", description: "Checking the funding rates now.", attempt: 1 },
      ]);
      expect(frames.map((f) => f.type)).to.deep.equal(["reset", "step", "step", "attempt", "answer", "done"]);
      expect(frames[3].data).to.deep.equal({ attempt: 2 });
      expect({ reasoning: stored.file.reasoning, sources: stored.file.sources }).to.deep.equal(projection(frames));
    });

    it("drops a tool payload thought from both the stream and the store", async () => {
      const { oracle, sink, storedAnswer } = loadOracle({
        scriptFor: () => ({
          thoughts: ['{"tool":"get_simple_price","args":{"ids":"bitcoin"}}', "Reading the latest market headlines."],
          answer: "An answer.",
        }),
      });

      await oracle.handlePrompt(USER, 9, 456, 457, promptPayload("Price?"), "0xkey", fakeEvent());

      const steps = sink.frames("457").filter((f) => f.type === "step");
      expect(steps.map((s) => s.data.description)).to.deep.equal(["Reading the latest market headlines."]);
      expect(storedAnswer()[0].file.reasoning.map((s) => s.description)).to.deep.equal([
        "Reading the latest market headlines.",
      ]);
    });

    it("never crosses frames between two jobs of one conversation running at once", async () => {
      const { oracle, sink, storedAnswer } = loadOracle({
        scriptFor: (text) => ({
          gapMs: 5,
          thoughts: [1, 2, 3].map((i) => `Thinking about ${text} step ${i} now.`),
          answer: `Answer for ${text}.`,
        }),
      });

      await Promise.all([
        oracle.handlePrompt(USER, 9, 456, 457, promptPayload("alpha"), "0xkey", fakeEvent()),
        oracle.handlePrompt(USER, 9, 458, 459, promptPayload("beta"), "0xkey", fakeEvent()),
      ]);
      await oracle.flushStreamsForTest();

      for (const [id, word] of [
        ["457", "alpha"],
        ["459", "beta"],
      ]) {
        const frames = sink.frames(id);
        expect(frames.every((f) => f.answerMessageId === id), id).to.equal(true);
        expect(runsOf(frames)).to.have.length(1);
        const steps = frames.filter((f) => f.type === "step");
        expect(steps).to.have.length(3);
        expect(steps.every((s) => s.data.description.includes(word))).to.equal(true);
        const stored = storedAnswer().find((s) => s.file.id === id);
        expect({ reasoning: stored.file.reasoning, sources: stored.file.sources }).to.deep.equal(projection(frames));
      }
    });
  });

  describe("every exit ends the run", () => {
    it("ends with done abandoned and no answer frame when submitAnswer reverts with JobAlreadyFinalized", async () => {
      const { oracle, sink, contract } = loadOracle();
      const revert = Object.assign(new Error("reverted"), { data: `${ALREADY_FINALIZED_SELECTOR}00` });
      contract.submitAnswer.rejects(revert);

      await oracle.handlePrompt(USER, 9, 456, 457, promptPayload("Hello there"), "0xkey", fakeEvent());
      await oracle.flushStreamsForTest();

      const frames = sink.frames("457");
      expect(frames.some((f) => f.type === "answer")).to.equal(false);
      expect(frames.at(-1)).to.include({ type: "done" });
      expect(frames.at(-1).data).to.deep.equal({ outcome: "abandoned" });
    });

    it("ends with done abandoned when the prompt is cancelled while the model runs", async () => {
      const { oracle, sink, contract } = loadOracle();
      contract.isJobFinalized.onFirstCall().resolves(false).onSecondCall().resolves(true);

      await oracle.handlePrompt(USER, 9, 456, 457, promptPayload("Hello there"), "0xkey", fakeEvent());
      await oracle.flushStreamsForTest();

      const frames = sink.frames("457");
      expect(frames.some((f) => f.type === "answer")).to.equal(false);
      expect(frames.at(-1).data).to.deep.equal({ outcome: "abandoned" });
      expect(contract.submitAnswer.called).to.equal(false);
    });

    it("ends with done abandoned when the job is finalized just before submission", async () => {
      const { oracle, sink, contract } = loadOracle();
      contract.isJobFinalized.onThirdCall().resolves(true);

      await oracle.handlePrompt(USER, 9, 456, 457, promptPayload("Hello there"), "0xkey", fakeEvent());
      await oracle.flushStreamsForTest();

      const frames = sink.frames("457");
      expect(frames.some((f) => f.type === "answer")).to.equal(false);
      expect(frames.at(-1).data).to.deep.equal({ outcome: "abandoned" });
    });

    it("ends with done abandoned for a payload that does not decrypt", async () => {
      const { oracle, sink } = loadOracle();
      const garbage = ethers.toUtf8Bytes("not.anything");

      await oracle.handlePrompt(USER, 9, 456, 457, garbage, "0xkey", fakeEvent()).catch(() => {});
      await oracle.flushStreamsForTest();

      const frames = sink.frames("457");
      expect(frames.map((f) => f.type)).to.deep.equal(["reset", "done"]);
      expect(frames.at(-1).data).to.deep.equal({ outcome: "abandoned" });
    });

    it("ends with done interrupted on a failed upload, and the retry is a new run that opens with reset retry", async () => {
      const { oracle, sink, stubs } = loadOracle();
      stubs["./storage/storage"].uploadData.onFirstCall().rejects(new Error("gateway down"));

      let thrown;
      await oracle
        .handlePrompt(USER, 9, 456, 457, promptPayload("Hello there"), "0xkey", fakeEvent())
        .catch((error) => {
          thrown = error;
        });
      await oracle.flushStreamsForTest();
      expect(thrown, "the failure still reaches the retry queue").to.exist;

      await oracle.handlePrompt(USER, 9, 456, 457, promptPayload("Hello there"), "0xkey", fakeEvent());
      await oracle.flushStreamsForTest();

      const frames = sink.frames("457");
      const [first, second] = runsOf(frames);
      expect(second, "a second run").to.exist;
      const firstFrames = frames.filter((f) => f.run === first);
      const secondFrames = frames.filter((f) => f.run === second);
      expect(firstFrames[0].data).to.deep.equal({ reason: "start" });
      expect(firstFrames.at(-1).data).to.deep.equal({ outcome: "interrupted" });
      expect(secondFrames[0]).to.include({ type: "reset", seq: 0 });
      expect(secondFrames[0].data).to.deep.equal({ reason: "retry" });
      expect(secondFrames.at(-1).data).to.deep.equal({ outcome: "answered" });
      expect(frames.filter((f) => f.type === "answer")).to.have.length(1);
    });
  });

  describe("streaming can never delay or lose a paid answer", () => {
    const brokenSinks = {
      "throws on every call": {
        open() {
          throw new Error("open");
        },
        frame() {
          throw new Error("frame");
        },
        close() {
          throw new Error("close");
        },
      },
      "returns promises that never settle": {
        open: () => new Promise(() => {}),
        frame: () => new Promise(() => {}),
        close: () => new Promise(() => {}),
      },
      "is not a sink at all": null,
    };

    for (const [name, broken] of Object.entries(brokenSinks)) {
      it(`answers and stores the same record when the sink ${name}`, async () => {
        const script = () => ({
          sources: [{ title: "A source", url: "https://example.test/s" }],
          thoughts: ["Reading the latest market headlines."],
          answer: "The same answer either way.",
        });
        const good = loadOracle({ scriptFor: script });
        await good.oracle.handlePrompt(USER, 9, 456, 457, promptPayload("Same"), "0xkey", fakeEvent());

        const bad = loadOracle({ scriptFor: script });
        bad.oracle.setStreamSink(broken);
        const started = Date.now();
        await bad.oracle.handlePrompt(USER, 9, 456, 457, promptPayload("Same"), "0xkey", fakeEvent());

        expect(Date.now() - started).to.be.lessThan(3000);
        expect(bad.contract.submitAnswer.calledOnce).to.equal(true);
        const strip = (f) => ({ content: f.content, reasoning: f.reasoning, sources: f.sources });
        expect(strip(bad.storedAnswer()[0].file)).to.deep.equal(strip(good.storedAnswer()[0].file));
      });
    }

    it("does not wait for the answer frame to be delivered before it returns", async () => {
      const { oracle, contract } = loadOracle();
      let frameCalls = 0;
      oracle.setStreamSink({
        open() {},
        frame() {
          frameCalls += 1;
          if (frameCalls > 2) throw new Error("late frames fail");
        },
        close() {},
      });

      await oracle.handlePrompt(USER, 9, 456, 457, promptPayload("Hello there"), "0xkey", fakeEvent());

      expect(contract.submitAnswer.calledOnce).to.equal(true);
    });
  });

  describe("mock mode goes through the same tap", () => {
    it("streams and stores the reasoning sentinel's steps and sources through the stream", async () => {
      const { oracle, sink, storedAnswer } = loadOracle({ mockAi: true });

      await oracle.handlePrompt(USER, 9, 456, 457, promptPayload("Explain BTC __E2E_REASONING__"), "0xkey", fakeEvent());
      await oracle.flushStreamsForTest();

      const frames = sink.frames("457");
      const [stored] = storedAnswer();
      expect(frames.map((f) => f.type)).to.deep.equal(["reset", "sources", "step", "step", "answer", "done"]);
      expect({ reasoning: stored.file.reasoning, sources: stored.file.sources }).to.deep.equal(projection(frames));
      expect(stored.file.reasoning.map((s) => s.title)).to.deep.equal([
        "Interpreting the request",
        "Synthesising the answer",
      ]);
      expect(stored.file.sources.map((s) => s.url)).to.deep.equal([
        "https://tradable.app/docs",
        "https://senseai.tradable.app",
      ]);
      expect(stored.file.reasoningDuration).to.equal(3);
    });

    it("spaces the mock steps by __E2E_STEP_MS__", async () => {
      const { oracle, sink } = loadOracle({ mockAi: true });

      const started = Date.now();
      await oracle.handlePrompt(
        USER,
        9,
        456,
        457,
        promptPayload("Explain BTC __E2E_REASONING__ __E2E_STEP_MS__:60"),
        "0xkey",
        fakeEvent(),
      );

      expect(Date.now() - started).to.be.at.least(110);
      expect(sink.frames("457").filter((f) => f.type === "step")).to.have.length(2);
    });

    it("caps __E2E_STEP_MS__ at five seconds", () => {
      const { oracle } = loadOracle({ mockAi: true });

      expect(oracle.parseMockStepMs("__E2E_STEP_MS__:999999")).to.equal(5000);
      expect(oracle.parseMockStepMs("__E2E_STEP_MS__:25")).to.equal(25);
      expect(oracle.parseMockStepMs("nothing")).to.equal(0);
      expect(oracle.parseMockStepMs(undefined)).to.equal(0);
    });

    it("re-runs once on __E2E_RERUN__: an interrupted first run, then a real second run that opens with reset retry", async () => {
      const { oracle, sink, storedAnswer, contract } = loadOracle({ mockAi: true });

      await oracle.handlePrompt(USER, 9, 456, 457, promptPayload("Explain BTC __E2E_REASONING__ __E2E_RERUN__"), "0xkey", fakeEvent());
      await oracle.flushStreamsForTest();

      const frames = sink.frames("457");
      const [first, second] = runsOf(frames);
      const firstFrames = frames.filter((f) => f.run === first);
      const secondFrames = frames.filter((f) => f.run === second);
      expect(firstFrames.map((f) => f.type)).to.deep.equal(["reset", "sources", "step", "done"]);
      expect(firstFrames.at(-1).data).to.deep.equal({ outcome: "interrupted" });
      expect(secondFrames[0].data).to.deep.equal({ reason: "retry" });
      expect(secondFrames.at(-1).data).to.deep.equal({ outcome: "answered" });
      expect(contract.submitAnswer.calledOnce).to.equal(true);
      const [stored] = storedAnswer();
      expect({ reasoning: stored.file.reasoning, sources: stored.file.sources }).to.deep.equal(projection(secondFrames));
    });

    it("ends with done abandoned on the drop sentinel", async () => {
      const { oracle, sink } = loadOracle({ mockAi: true });

      await oracle.handlePrompt(USER, 9, 456, 457, promptPayload("never __E2E_DROP__"), "0xkey", fakeEvent());
      await oracle.flushStreamsForTest();

      const frames = sink.frames("457");
      expect(frames.at(-1).data).to.deep.equal({ outcome: "abandoned" });
      expect(frames.some((f) => f.type === "answer")).to.equal(false);
    });
  });

  describe("regeneration", () => {
    it("streams the regenerated answer under its own id and stores the projection", async () => {
      const { oracle, sink, storedAnswer } = loadOracle({
        scriptFor: () => ({ thoughts: ["Reconsidering the previous answer now."], answer: "A better answer." }),
      });
      const payload = ethers.toUtf8Bytes(
        encryptForOracle({ promptMessageCID: "bafy-prompt", originalAnswerMessageCID: "bafy-old", instructions: "shorter" }),
      );

      await oracle.handleRegeneration(USER, 9, 456, 457, 460, payload, "0xkey", fakeEvent());
      await oracle.flushStreamsForTest();

      const frames = sink.frames("460");
      const [stored] = storedAnswer();
      expect(frames.map((f) => f.type)).to.deep.equal(["reset", "step", "answer", "done"]);
      expect(frames.find((f) => f.type === "answer").data.text).to.equal(stored.file.content);
      expect({ reasoning: stored.file.reasoning, sources: stored.file.sources }).to.deep.equal(projection(frames));
    });
  });
});
