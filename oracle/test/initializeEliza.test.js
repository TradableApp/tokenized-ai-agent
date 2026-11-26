const crypto = require("node:crypto");
const util = require("node:util");
const { ethers } = require("ethers");
const chai = require("chai");
const chaiAsPromised = require("chai-as-promised");
const proxyquire = require("proxyquire").noCallThru();
const sinon = require("sinon");

const { withTestKeys } = require("./helpers/oracleTestKeys");

chai.use(chaiAsPromised.default ?? chaiAsPromised);
const { expect } = chai;

// The oracle's own start of the agent: the add and start callbacks it hands to
// startAgentWithCleanSettings, run through the framework stand-in below. The order around them
// is tested in agentSettings.test.js; these tests are about what the callbacks themselves do.

const AGENT_ID = "agent-id";
// A character with tool servers, which the framework must not be given to store.
const CHARACTER = Object.freeze({
  name: "SenseAI",
  settings: { model: "m", mcp: { servers: { market: { command: "market-tools" } } } },
});
const DATABASE_ADDRESS = "postgres://oracle:not-a-real-password@db.internal/oracle_agent";

/**
 * A framework stand-in whose add, start, context composition, event subscription and run can be
 * told to fail, recording what reached it.
 */
function makeFramework({
  addFails,
  startFails,
  startTakesMs = 0,
  composeFails,
  subscribeFails,
  runFails,
  runCrashes,
} = {}) {
  const seen = { added: null, startCalls: 0, started: false, handled: 0, startedWhenHandled: null };

  const runtime = {
    agentId: "agent-uuid",
    // The runtime's own logger, which the oracle replaces with a cleaned one.
    logger: { warn() {}, error() {}, info() {}, debug() {}, child() { return this; } },
    ensureConnection: sinon.stub().resolves(),
    createMemory: sinon.stub().resolves(),
    getMemoryById: sinon.stub().resolves(null),
    composeState: composeFails
      ? sinon.stub().rejects(composeFails)
      : sinon.stub().resolves({ values: {}, text: "", data: { providers: {} } }),
    registerEvent: () => {
      if (subscribeFails) throw subscribeFails;
    },
  };

  class ElizaOS {
    async addAgents(agents) {
      seen.added = agents;
      if (addFails) throw addFails;
      return [AGENT_ID];
    }

    async startAgents() {
      seen.startCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, startTakesMs));
      if (startFails) throw startFails;
      seen.started = true;
    }

    getAgent() {
      return runtime;
    }

    async handleMessage(_target, _message, options) {
      if (runFails) throw runFails;
      if (runCrashes) {
        // As the framework reports a crash inside its pipeline: through onError, not a throw.
        options.onError(runCrashes);
        return { messageId: "m1", userMessage: {} };
      }
      seen.handled += 1;
      seen.startedWhenHandled = seen.started;
      await options.onResponse({ text: "an answer", thought: "t" });
      options.onComplete();
      return { messageId: "m1", userMessage: {} };
    }
  }

  return { ElizaOS, seen };
}

function loadOracle(framework, extraStubs = {}) {
  process.env.PRIVATE_KEY = ethers.Wallet.createRandom().privateKey;
  return withTestKeys(
    proxyquire("../src/aiAgentOracle", {
      "@elizaos/core": {
        setAllowedEnvVars() {},
        ElizaOS: framework.ElizaOS,
        elizaLogger: { info() {}, log() {}, error() {}, warn() {}, debug() {} },
        stringToUuid: (s) => s,
        createUniqueUuid: (_ns, s) => s,
        ChannelType: { DM: "DM", WORLD: "WORLD" },
        EventType: { ACTION_STARTED: "ACTION_STARTED", ACTION_COMPLETED: "ACTION_COMPLETED" },
      },
      "./elizaos/plugins/plugin-senseai/dist/index.js": { default: {}, setErrorDescriber: () => {} },
      "./elizaos/character.js": CHARACTER,
      // The watch of the tool service is not what these tests are about, and left real it would
      // keep looking for a service the stand-in does not have.
      "./elizaos/toolServerWatch": {
        createToolServerWatch: () => ({
          follow: async () => {},
          observe: () => ({}),
          countRejectedRun: () => {},
        }),
      },
      ...extraStubs,
    }),
  );
}

function refusedConnection() {
  return Object.assign(new Error(`connect ECONNREFUSED ${DATABASE_ADDRESS}`), {
    code: "ECONNREFUSED",
  });
}

const history = [{ role: "user", content: "What is the sentiment on SOL?" }];

describe("the oracle's start of the agent", function () {
  let consoles;
  let privateKeyBefore;

  // loadOracle sets the signing key the module reads at load; each test gets back whatever was
  // there before it.
  beforeEach(function () {
    privateKeyBefore = process.env.PRIVATE_KEY;
  });

  afterEach(function () {
    if (privateKeyBefore === undefined) delete process.env.PRIVATE_KEY;
    else process.env.PRIVATE_KEY = privateKeyBefore;
  });

  beforeEach(function () {
    consoles = ["error", "log", "warn"].map((level) => sinon.stub(console, level));
  });

  afterEach(function () {
    sinon.restore();
  });

  const lineOf = (call) => call.args.map(String).join(" ");
  const loggedErrors = () => consoles[0].getCalls().map(lineOf);
  const everyLine = () => consoles.flatMap((stub) => stub.getCalls().map(lineOf)).join("\n");

  for (const [where, failure] of [
    ["started", { startFails: refusedConnection() }],
    ["added", { addFails: refusedConnection() }],
  ]) {
    it(`logs only the kind of error when the agent cannot be ${where}`, async function () {
      const oracle = loadOracle(makeFramework(failure));

      await expect(oracle.queryElizaOS(history, "room-1", "0xuser")).to.be.rejectedWith(
        /ECONNREFUSED/,
      );

      const lines = loggedErrors();
      expect(lines).to.include("[ElizaOS] FAILED to start SenseAI Agent (ECONNREFUSED).");
      expect(everyLine()).to.not.include("not-a-real-password");
      expect(everyLine()).to.not.include("db.internal");
    });
  }

  it("hands the framework the agent cleaned for storing, not the character as it is", async function () {
    const framework = makeFramework();
    const oracle = loadOracle(framework);

    await oracle.queryElizaOS(history, "room-1", "0xuser");

    const [added] = framework.seen.added;
    expect(added.character.settings.mcp, "no tool servers in what is stored").to.deep.equal({});
    expect(added.settings.mcp, "the tool servers as runtime settings").to.deep.equal(
      CHARACTER.settings.mcp,
    );
    expect(added.plugins).to.be.an("array").that.is.not.empty;
  });

  it("waits for the agent to have started before it answers", async function () {
    const framework = makeFramework({ startTakesMs: 30 });
    const oracle = loadOracle(framework);

    await oracle.queryElizaOS(history, "room-1", "0xuser");

    expect(framework.seen.handled).to.equal(1);
    expect(framework.seen.startedWhenHandled).to.equal(true);
  });

  it("does not answer when the agent did not start", async function () {
    const framework = makeFramework({ startFails: refusedConnection() });
    const oracle = loadOracle(framework);

    await expect(oracle.queryElizaOS(history, "room-1", "0xuser")).to.be.rejected;

    expect(framework.seen.startCalls).to.equal(1);
    expect(framework.seen.handled).to.equal(0);
  });

  // The rejection reaches the start-up's own handler, which prints and reports it whole.
  it("rejects with an error that keeps the code and carries no address when the agent cannot start", async function () {
    const oracle = loadOracle(makeFramework({ startFails: refusedConnection() }));

    const error = await oracle.queryElizaOS(history, "room-1", "0xuser").then(
      () => null,
      (rejection) => rejection,
    );

    expect(error).to.be.an.instanceOf(Error);
    expect(error.code).to.equal("ECONNREFUSED");
    expect(util.inspect(error, { depth: 10 })).to.not.include("not-a-real-password");
    expect(util.inspect(error, { depth: 10 })).to.not.include("db.internal");
  });
});

describe("errors on the answer path are printed described", function () {
  // Where a provider puts the access key: in the address of the request that failed.
  const ADDRESS = "https://rpc.example/v2/not-a-real-key";
  const failedRequest = () => new Error(`request to ${ADDRESS} failed`);
  let consoles;
  let privateKeyBefore;

  beforeEach(function () {
    privateKeyBefore = process.env.PRIVATE_KEY;
    consoles = ["error", "log", "warn"].map((level) => sinon.stub(console, level));
  });

  afterEach(function () {
    sinon.restore();
    if (privateKeyBefore === undefined) delete process.env.PRIVATE_KEY;
    else process.env.PRIVATE_KEY = privateKeyBefore;
  });

  // Every argument as the console would print it: an Error with its stack and properties.
  const printed = () =>
    consoles
      .flatMap((stub) => stub.getCalls())
      .map((call) =>
        call.args.map((arg) => (typeof arg === "string" ? arg : util.inspect(arg))).join(" "),
      )
      .join("\n");

  it("when the context cannot be composed, and the run still answers", async function () {
    const oracle = loadOracle(makeFramework({ composeFails: failedRequest() }));

    const answer = await oracle.queryElizaOS(history, "room-1", "0xuser");

    expect(answer.text).to.equal("an answer");
    expect(printed()).to.match(/Context composition failed/);
    expect(printed()).to.not.include("not-a-real-key");
  });

  it("when the provenance handlers cannot be subscribed, and the run still answers", async function () {
    const oracle = loadOracle(makeFramework({ subscribeFails: failedRequest() }));

    const answer = await oracle.queryElizaOS(history, "room-1", "0xuser");

    expect(answer.text).to.equal("an answer");
    expect(printed()).to.match(/Could not subscribe provenance handlers/);
    expect(printed()).to.not.include("not-a-real-key");
  });

  /** The dispatcher with the routing and the last tier stood in for, and no network. */
  function loadDispatcher(framework) {
    sinon.stub(global, "fetch").rejects(new Error("unreachable in a test"));
    const queryGeminiDirect = sinon.stub().resolves("A direct answer.");
    const oracle = loadOracle(framework, {
      "./geminiDirect": { classifyIntent: async () => "MARKET", queryGeminiDirect },
    });
    return oracle;
  }

  for (const [how, failure] of [
    ["throws", { runFails: failedRequest() }],
    ["crashes inside its pipeline", { runCrashes: failedRequest() }],
  ]) {
    it(`when the agent's run ${how} and the answer falls back to another model`, async function () {
      const oracle = loadDispatcher(makeFramework(failure));

      const answer = await oracle.queryAIModel(history, "room-1", "0xuser");

      expect(answer.text).to.equal("A direct answer.");
      expect(printed()).to.match(/Falling back to ChainGPT/);
      expect(printed()).to.not.include("not-a-real-key");
    });
  }
});

// A payload sealed with the right key whose plaintext is not JSON: the parse error's message
// quotes the first characters of that plaintext, which is the user's own text.
describe("a payload that decrypts but does not parse", function () {
  const SECRET = "my private question about my holdings";
  const key = crypto.randomBytes(32);
  let consoles;
  let privateKeyBefore;

  /** Seals `text` as the oracle's payloads are sealed: iv, then ciphertext and tag. */
  function seal(text) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const sealed = Buffer.concat([cipher.update(Buffer.from(text)), cipher.final()]);
    const combined = Buffer.concat([sealed, cipher.getAuthTag()]);
    return `${iv.toString("base64")}.${combined.toString("base64")}`;
  }

  beforeEach(function () {
    privateKeyBefore = process.env.PRIVATE_KEY;
    consoles = ["error", "log", "warn"].map((level) => sinon.stub(console, level));
  });

  afterEach(function () {
    sinon.restore();
    if (privateKeyBefore === undefined) delete process.env.PRIVATE_KEY;
    else process.env.PRIVATE_KEY = privateKeyBefore;
  });

  const printed = () =>
    consoles
      .flatMap((stub) => stub.getCalls())
      .map((call) =>
        call.args.map((arg) => (typeof arg === "string" ? arg : util.inspect(arg))).join(" "),
      )
      .join("\n");

  it("is refused as bad input that names the kind of failure and quotes none of it", function () {
    const oracle = loadOracle(makeFramework());

    let refused;
    try {
      oracle.decryptSymmetrically(seal(SECRET), key);
    } catch (error) {
      refused = error;
    }

    expect(refused?.name).to.equal("BadInputError");
    expect(refused.message).to.include("SyntaxError");
    expect(util.inspect(refused, { depth: 10 })).to.not.include("my private");
  });

  // The example settings run the oracle in Sapphire mode, where the event payload is JSON text.
  it("is refused as bad input quoting none of it when the event payload is not JSON", async function () {
    const oracle = loadOracle(makeFramework());

    const refused = await oracle.getSessionKey(SECRET, "0x", "1").then(
      () => null,
      (error) => error,
    );

    expect(refused?.name).to.equal("BadInputError");
    expect(refused.message).to.include("SyntaxError");
    expect(util.inspect(refused, { depth: 10 })).to.not.include("my private");
  });

  it("stops the history there, and prints nothing of it", async function () {
    const fetchData = sinon.stub().resolves(seal(SECRET));
    const oracle = loadOracle(makeFramework(), {
      "./storage/storage": {
        initializeStorage: async () => {},
        uploadData: async () => {},
        fetchData,
        queryTransactionByTags: async () => [],
      },
    });

    const history = await oracle.reconstructHistory("cid-1", key);

    expect(history).to.deep.equal([]);
    // Where it stopped, by position: the id is the user's choice and is not printed.
    expect(printed()).to.match(/Failed to reconstruct history at message 1 of the chain/);
    expect(printed()).to.not.include("at CID cid-1");
    expect(printed()).to.not.include("my private");
  });
});
