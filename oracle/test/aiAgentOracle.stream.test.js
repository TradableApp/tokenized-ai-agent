const crypto = require("crypto");
const { expect } = require("chai");
const sinon = require("sinon");
const proxyquire = require("proxyquire").noCallThru();
const { ethers } = require("ethers");

const { withTestKeys } = require("./helpers/oracleTestKeys");
const { decryptFrame } = require("./helpers/frameDecrypt");
const { initInboundPrompt } = require("../src/inboundPrompt");
const { streamProof } = require("../src/stream/streamContract");
const { streamCounters } = require("../src/stream/answerStream");
const outbound = require("../src/outboundSanitizer");

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
      previousMessageCID: "bafkr6iparentaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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
 * ElizaOS stand-in. Each prompt text maps to a script: the intermediate responses it emits (a
 * text with the action that wrote it, and a thought or not), the thoughts it emits, then either
 * an answer or a failure.
 */
function makeEliza(scriptFor) {
  const handlers = {};
  const runtime = {
    agentId: "agent-uuid",
    // The runtime's own logger, which the oracle replaces with a cleaned one.
    logger: { warn() {}, error() {}, info() {}, debug() {}, child() { return this; } },
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
      for (const emission of script.intermediate ?? []) await options.onResponse(emission);
      for (const thought of script.thoughts ?? []) {
        if (script.gapMs) await new Promise((resolve) => setTimeout(resolve, script.gapMs));
        await options.onResponse({ thought });
      }
      if (script.fail) {
        options.onError(script.fail);
        if (script.lateThought) await options.onResponse({ thought: script.lateThought });
        return {};
      }
      await options.onResponse({ text: script.answer, actions: ["REPLY"] });
      options.onComplete();
      if (script.lateThought) await options.onResponse({ thought: script.lateThought });
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
    provider: {
      getNetwork: sinon.stub().resolves({ chainId: 1 }),
      getBlockNumber: sinon.stub().resolves(1),
      getTransactionReceipt: sinon.stub().resolves(null),
    },
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
    // The oracle hands the plugin its error describer at load and refuses a build without it.
    "./elizaos/plugins/plugin-senseai/dist/index.js": {
      default: {},
      setErrorDescriber: () => {},
    },
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

  return { oracle, stubs, contract, provider: components.provider, sink, uploads, storedAnswer };
}

/**
 * submitAnswer sends a transaction whose receipt wait throws (an RPC drop or a timeout), and the
 * fallback check then finds the job finalized; `receipt` is what the node then returns for this
 * run's own transaction hash.
 */
function receiptWaitFails({ contract, provider }, receipt) {
  contract.submitAnswer.callsFake(async () => ({
    hash: "0xOwnTx",
    wait: async () => {
      throw new Error("timeout waiting for the receipt");
    },
  }));
  // Calls: start of the job, before storage, in the tx mutex, then the fallback check.
  contract.isJobFinalized.onCall(3).resolves(true);
  provider.getTransactionReceipt.withArgs("0xOwnTx").resolves(receipt);
}

const activityKinds = (stubs) =>
  stubs["./answerActivity"].recordAnswerActivity.getCalls().map((call) => call.args[0].kind);

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

/** Thoughts counted as dropped since `before`, all kinds together (none counted if no counter). */
const droppedSince = (before) => {
  const now = streamCounters.snapshot().thoughtsDropped ?? {};
  return Object.keys(now).reduce((sum, kind) => sum + now[kind] - (before?.[kind] ?? 0), 0);
};

/** A Brain whose import resolves after `ms`, with a sanitiser that keeps every thought. */
const brainLoadingIn = (ms) => () =>
  new Promise((resolve) => setTimeout(() => resolve({ sanitizeOutboundText: (text) => text }), ms));

describe("answer path and live stream", function () {
  this.timeout(10000);

  before(async () => {
    await initInboundPrompt();
  });

  afterEach(() => {
    sinon.restore();
    outbound._resetForTests();
    delete process.env.MOCK_AI;
    delete process.env.CHAIN_GPT_API_KEY;
  });

  describe("steps still being sanitised when the run completes", () => {
    const THOUGHTS = [
      "First thought about the market.",
      "Second thought about the market.",
      "Third thought about the market.",
    ];

    it("stores or counts every thought when the Brain loads only after the run completed", async function () {
      // About 6 s of real timers (the 3.5 s load, 2 s sanitiser limits, the 3 s flush); room for a
      // loaded machine.
      this.timeout(30000);
      // The Brain's import resolves 3.5 s in, long after ElizaOS said it was done. A thought the
      // sanitiser accepts must then be stored and streamed; one it gives up on must be counted.
      // Nothing may vanish without either.
      outbound._setSanitizerForTests(null, { loader: brainLoadingIn(3500) });
      sinon.stub(console, "warn");
      const before = streamCounters.snapshot().thoughtsDropped;
      const { oracle, sink, storedAnswer } = loadOracle({
        scriptFor: () => ({ thoughts: THOUGHTS, answer: "An answer here." }),
      });

      await oracle.handlePrompt(
        USER,
        9,
        458,
        459,
        promptPayload("How is BTC?"),
        "0xkey",
        fakeEvent(),
      );
      await oracle.flushStreamsForTest();

      const frames = sink.frames("459");
      const [stored] = storedAnswer();
      const storedSteps = stored.file.reasoning ?? [];
      expect({ reasoning: storedSteps, sources: stored.file.sources ?? [] }).to.deep.equal(
        projection(frames),
      );
      expect(
        storedSteps.length + droppedSince(before),
        "every thought is stored or counted as dropped",
      ).to.equal(THOUGHTS.length);
    });

    it("waits for steps whose sanitising finishes after the run completed, and stores them", async () => {
      outbound._setSanitizerForTests(null, { loader: brainLoadingIn(300) });
      const { oracle, sink, storedAnswer } = loadOracle({
        scriptFor: () => ({ thoughts: THOUGHTS, answer: "An answer here." }),
      });

      await oracle.handlePrompt(
        USER,
        9,
        460,
        461,
        promptPayload("How is BTC?"),
        "0xkey",
        fakeEvent(),
      );

      const [stored] = storedAnswer();
      expect(stored.file.reasoning.map((s) => s.description)).to.deep.equal(THOUGHTS);
      await oracle.flushStreamsForTest();
      expect({
        reasoning: stored.file.reasoning,
        sources: stored.file.sources ?? [],
      }).to.deep.equal(projection(sink.frames("461")));
    });

    it("neither streams nor stores a thought that arrives after a failed run ended, and counts it", async () => {
      process.env.CHAIN_GPT_API_KEY = "test-key";
      sinon.stub(global, "fetch").resolves({ ok: true, text: async () => "ChainGPT answer here." });
      const before = streamCounters.snapshot().thoughtsDropped;
      const { oracle, sink, storedAnswer } = loadOracle({
        scriptFor: () => ({
          thoughts: ["Reading the latest market headlines.", "Checking the funding rates now."],
          fail: new Error("model 404"),
          lateThought: "A thought that came after the run had failed.",
        }),
      });

      await oracle.handlePrompt(
        USER,
        9,
        456,
        457,
        promptPayload("How is ETH?"),
        "0xkey",
        fakeEvent(),
      );
      await oracle.flushStreamsForTest();

      const frames = sink.frames("457");
      const [stored] = storedAnswer();
      expect(stored.file.reasoning.map((s) => [s.description, s.attempt])).to.deep.equal([
        ["Reading the latest market headlines.", 1],
        ["Checking the funding rates now.", 1],
      ]);
      expect({ reasoning: stored.file.reasoning, sources: stored.file.sources }).to.deep.equal(
        projection(frames),
      );
      expect(streamCounters.snapshot().thoughtsDropped?.late - (before?.late ?? 0)).to.equal(1);
    });

    it("alerts once, by kind, when thoughts are dropped because the sanitiser cannot be loaded", async () => {
      outbound._setSanitizerForTests(null, { loadFails: true });
      sinon.stub(console, "error");
      const { oracle, stubs } = loadOracle({
        scriptFor: () => ({
          thoughts: ["Reading the latest market headlines."],
          answer: "An answer.",
        }),
      });

      await oracle.handlePrompt(USER, 9, 456, 457, promptPayload("One"), "0xkey", fakeEvent());
      await oracle.handlePrompt(USER, 9, 458, 459, promptPayload("Two"), "0xkey", fakeEvent());

      const alerts = stubs["./alerting"].sendAlert
        .getCalls()
        .filter((c) => /thought/i.test(c.args[0]));
      expect(alerts).to.have.length(1);
      expect(alerts[0].args[1]).to.include("kind: unavailable");
    });
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
      // No fallback: the file is what it was before attempts were recorded.
      expect(stored.file).to.not.have.property("answerAttempt");

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
      // The file says ChainGPT's attempt answered, so a reader can tell ElizaOS's steps were earlier.
      expect(stored.file.answerAttempt).to.equal(2);
      expect(stored.file.answerAttempt).to.equal(frames[3].data.attempt);
    });

    it("never puts an intermediate response text in any frame, only its thought as a step", async () => {
      const INTERMEDIATE = [
        "Let me look up the latest prices for you (first draft).",
        "Here is what the tool returned so far (second draft).",
      ];
      const { oracle, sink, storedAnswer } = loadOracle({
        scriptFor: () => ({
          intermediate: [
            { text: INTERMEDIATE[0], thought: "Fetching the current prices now.", actions: ["CALL_MCP_TOOL"] },
            { text: INTERMEDIATE[1], actions: ["CALL_MCP_TOOL"] },
          ],
          thoughts: ["Weighing the macro backdrop today."],
          answer: "Bitcoin looks firm this week.",
        }),
      });

      await oracle.handlePrompt(USER, 9, 456, 457, promptPayload("How is BTC?"), "0xkey", fakeEvent());
      await oracle.flushStreamsForTest();

      const frames = sink.frames("457");
      const [stored] = storedAnswer();
      expect(stored.file.content).to.equal("Bitcoin looks firm this week.");
      for (const text of INTERMEDIATE) {
        for (const frame of frames) expect(JSON.stringify(frame), frame.type).to.not.include(text);
        expect(JSON.stringify(stored.file)).to.not.include(text);
      }
      expect(frames.filter((f) => f.type === "step").map((f) => f.data.description)).to.deep.equal([
        "Fetching the current prices now.",
        "Weighing the macro backdrop today.",
      ]);
      expect(frames.find((f) => f.type === "answer").data.text).to.equal(stored.file.content);
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

    it("ends answered, with the answer frame, when the receipt wait fails but this run's own submission was mined", async () => {
      const loaded = loadOracle();
      const { oracle, sink, stubs, provider, storedAnswer } = loaded;
      receiptWaitFails(loaded, { hash: "0xOwnTx", status: 1 });

      await oracle.handlePrompt(USER, 9, 456, 457, promptPayload("Hello there"), "0xkey", fakeEvent());
      await oracle.flushStreamsForTest();

      const frames = sink.frames("457");
      const [stored] = storedAnswer();
      expect(provider.getTransactionReceipt.calledWith("0xOwnTx")).to.equal(true);
      expect(frames.map((f) => f.type).slice(-2)).to.deep.equal(["answer", "done"]);
      expect(frames.at(-1).data).to.deep.equal({ outcome: "answered" });
      expect(frames.find((f) => f.type === "answer").data.text).to.equal(stored.file.content);
      expect(frames.find((f) => f.type === "answer").data.answerMessageCID).to.equal(stored.cid);
      expect(activityKinds(stubs)).to.deep.equal(["answer"]);
    });

    for (const [label, receipt] of [
      ["reverted", { hash: "0xOwnTx", status: 0 }],
      ["not found", null],
    ]) {
      it(`ends abandoned, with no answer frame, when the receipt wait fails and this run's submission was ${label}`, async () => {
        const loaded = loadOracle();
        const { oracle, sink, stubs } = loaded;
        receiptWaitFails(loaded, receipt);

        await oracle.handlePrompt(USER, 9, 456, 457, promptPayload("Hello there"), "0xkey", fakeEvent());
        await oracle.flushStreamsForTest();

        const frames = sink.frames("457");
        expect(frames.some((f) => f.type === "answer")).to.equal(false);
        expect(frames.at(-1).data).to.deep.equal({ outcome: "abandoned" });
        expect(activityKinds(stubs)).to.deep.equal([]);
      });
    }

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
        encryptForOracle({ promptMessageCID: "bafkr6ipromptaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", originalAnswerMessageCID: "bafkr6ioldaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", instructions: "shorter" }),
      );

      await oracle.handleRegeneration(USER, 9, 456, 457, 460, payload, "0xkey", fakeEvent());
      await oracle.flushStreamsForTest();

      const frames = sink.frames("460");
      const [stored] = storedAnswer();
      expect(frames.map((f) => f.type)).to.deep.equal(["reset", "step", "answer", "done"]);
      expect(frames.find((f) => f.type === "answer").data.text).to.equal(stored.file.content);
      expect({ reasoning: stored.file.reasoning, sources: stored.file.sources }).to.deep.equal(projection(frames));
    });

    // The regeneration handler opens, flushes and ends its stream as handlePrompt does; each exit
    // is pinned here too, so a done() dropped from one of its branches is caught.
    const regenPayload = () =>
      ethers.toUtf8Bytes(
        encryptForOracle({ promptMessageCID: "bafkr6ipromptaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", originalAnswerMessageCID: "bafkr6ioldaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", instructions: "shorter" }),
      );
    const regenerate = (oracle, payload = regenPayload()) =>
      oracle.handleRegeneration(USER, 9, 456, 457, 460, payload, "0xkey", fakeEvent());

    describe("every exit ends the run", () => {
      it("ends with done abandoned and no answer frame when submitAnswer reverts with JobAlreadyFinalized", async () => {
        const { oracle, sink, contract } = loadOracle();
        contract.submitAnswer.rejects(Object.assign(new Error("reverted"), { data: `${ALREADY_FINALIZED_SELECTOR}00` }));

        await regenerate(oracle);
        await oracle.flushStreamsForTest();

        const frames = sink.frames("460");
        expect(frames.some((f) => f.type === "answer")).to.equal(false);
        expect(frames.at(-1).data).to.deep.equal({ outcome: "abandoned" });
      });

      it("ends with done abandoned when the prompt is cancelled while the model runs", async () => {
        const { oracle, sink, contract } = loadOracle();
        contract.isJobFinalized.onFirstCall().resolves(false).onSecondCall().resolves(true);

        await regenerate(oracle);
        await oracle.flushStreamsForTest();

        const frames = sink.frames("460");
        expect(frames.some((f) => f.type === "answer")).to.equal(false);
        expect(frames.at(-1).data).to.deep.equal({ outcome: "abandoned" });
        expect(contract.submitAnswer.called).to.equal(false);
      });

      it("ends with done abandoned when the job is finalized just before submission", async () => {
        const { oracle, sink, contract } = loadOracle();
        contract.isJobFinalized.onThirdCall().resolves(true);

        await regenerate(oracle);
        await oracle.flushStreamsForTest();

        const frames = sink.frames("460");
        expect(frames.some((f) => f.type === "answer")).to.equal(false);
        expect(frames.at(-1).data).to.deep.equal({ outcome: "abandoned" });
        expect(contract.submitAnswer.called).to.equal(false);
      });

      it("ends with done abandoned for a payload that does not decrypt", async () => {
        const { oracle, sink } = loadOracle();

        await regenerate(oracle, ethers.toUtf8Bytes("not.anything")).catch(() => {});
        await oracle.flushStreamsForTest();

        const frames = sink.frames("460");
        expect(frames.map((f) => f.type)).to.deep.equal(["reset", "done"]);
        expect(frames.at(-1).data).to.deep.equal({ outcome: "abandoned" });
      });

      it("ends answered, with the answer frame, when the receipt wait fails but this run's own submission was mined", async () => {
        const loaded = loadOracle();
        const { oracle, sink, stubs, provider, storedAnswer } = loaded;
        receiptWaitFails(loaded, { hash: "0xOwnTx", status: 1 });

        await regenerate(oracle);
        await oracle.flushStreamsForTest();

        const frames = sink.frames("460");
        const [stored] = storedAnswer();
        expect(provider.getTransactionReceipt.calledWith("0xOwnTx")).to.equal(true);
        expect(frames.map((f) => f.type).slice(-2)).to.deep.equal(["answer", "done"]);
        expect(frames.at(-1).data).to.deep.equal({ outcome: "answered" });
        expect(frames.find((f) => f.type === "answer").data.text).to.equal(stored.file.content);
        expect(activityKinds(stubs)).to.deep.equal(["answer"]);
      });

      for (const [label, receipt] of [
        ["reverted", { hash: "0xOwnTx", status: 0 }],
        ["not found", null],
      ]) {
        it(`ends abandoned, with no answer frame, when the receipt wait fails and this run's submission was ${label}`, async () => {
          const loaded = loadOracle();
          const { oracle, sink, stubs } = loaded;
          receiptWaitFails(loaded, receipt);

          await regenerate(oracle);
          await oracle.flushStreamsForTest();

          const frames = sink.frames("460");
          expect(frames.some((f) => f.type === "answer")).to.equal(false);
          expect(frames.at(-1).data).to.deep.equal({ outcome: "abandoned" });
          expect(activityKinds(stubs)).to.deep.equal([]);
        });
      }

      it("ends with done interrupted on a failed upload, and the retry is a new run that opens with reset retry", async () => {
        const { oracle, sink, stubs } = loadOracle();
        stubs["./storage/storage"].uploadData.onFirstCall().rejects(new Error("gateway down"));

        let thrown;
        await regenerate(oracle).catch((error) => {
          thrown = error;
        });
        await oracle.flushStreamsForTest();
        expect(thrown, "the failure still reaches the retry queue").to.exist;

        await regenerate(oracle);
        await oracle.flushStreamsForTest();

        const frames = sink.frames("460");
        const [first, second] = runsOf(frames);
        expect(second, "a second run").to.exist;
        const firstFrames = frames.filter((f) => f.run === first);
        const secondFrames = frames.filter((f) => f.run === second);
        expect(firstFrames[0].data).to.deep.equal({ reason: "start" });
        expect(firstFrames.at(-1).data).to.deep.equal({ outcome: "interrupted" });
        expect(secondFrames[0].data).to.deep.equal({ reason: "retry" });
        expect(secondFrames.at(-1).data).to.deep.equal({ outcome: "answered" });
        expect(frames.filter((f) => f.type === "answer")).to.have.length(1);
      });
    });

    it("answers and stores the same record, without waiting, when the sink throws on every call", async () => {
      const script = () => ({ thoughts: ["Reconsidering the previous answer now."], answer: "The same answer either way." });
      const good = loadOracle({ scriptFor: script });
      await regenerate(good.oracle);

      const bad = loadOracle({ scriptFor: script });
      const fail = () => {
        throw new Error("sink");
      };
      bad.oracle.setStreamSink({ open: fail, frame: fail, close: fail });
      const started = Date.now();
      await regenerate(bad.oracle);

      expect(Date.now() - started).to.be.lessThan(3000);
      expect(bad.contract.submitAnswer.calledOnce).to.equal(true);
      const strip = (f) => ({ content: f.content, reasoning: f.reasoning, sources: f.sources });
      expect(strip(bad.storedAnswer()[0].file)).to.deep.equal(strip(good.storedAnswer()[0].file));
    });
  });

  describe("the heartbeat's stream block", () => {
    const quietSink = (extra = {}) => ({ open() {}, frame() {}, close() {}, ...extra });

    it("carries the answer path's counts and the server's stats, and null for a sink without them", () => {
      const { oracle } = loadOracle();
      const serverStats = { connections: 3, failures: 1, refusedAppends: 2 };
      oracle.setStreamSink(quietSink({ stats: () => serverStats }));
      const withServer = oracle.streamHeartbeatSnapshot();
      expect(withServer).to.have.all.keys(
        "framesBuilt",
        "buildFailures",
        "sinkFailures",
        "sealFailures",
        "thoughtsDropped",
        "server",
      );
      expect(withServer.server).to.deep.equal(serverStats);

      oracle.setStreamSink(quietSink());
      expect(oracle.streamHeartbeatSnapshot().server).to.equal(null);

      oracle.setStreamSink(
        quietSink({
          stats() {
            throw new Error("stats broke");
          },
        }),
      );
      const broken = oracle.streamHeartbeatSnapshot();
      expect(broken.server).to.equal(null);
      expect(broken.framesBuilt).to.be.a("number");
    });

    it("is what the oracle hands the heartbeat", () => {
      const source = require("node:fs").readFileSync(
        require.resolve("../src/aiAgentOracle"),
        "utf8",
      );
      expect(source).to.match(/streamSnapshot:\s*(?:\(\)\s*=>\s*)?streamHeartbeatSnapshot\b/);
    });
  });
});
