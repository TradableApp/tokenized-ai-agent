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

/** A framework stand-in whose add and start can be told to fail, recording what reached it. */
function makeFramework({ addFails, startFails, startTakesMs = 0 } = {}) {
  const seen = { added: null, startCalls: 0, started: false, handled: 0, startedWhenHandled: null };

  const runtime = {
    agentId: "agent-uuid",
    ensureConnection: sinon.stub().resolves(),
    createMemory: sinon.stub().resolves(),
    getMemoryById: sinon.stub().resolves(null),
    composeState: sinon.stub().resolves({ values: {}, text: "", data: { providers: {} } }),
    registerEvent: () => {},
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
      seen.handled += 1;
      seen.startedWhenHandled = seen.started;
      await options.onResponse({ text: "an answer", thought: "t" });
      options.onComplete();
      return { messageId: "m1", userMessage: {} };
    }
  }

  return { ElizaOS, seen };
}

function loadOracle(framework) {
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
      "./elizaos/plugins/plugin-senseai/dist/index.js": { default: {} },
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

  // loadOracle sets the signing key the module reads at load; the suites after this one get
  // back whatever they had.
  before(function () {
    privateKeyBefore = process.env.PRIVATE_KEY;
  });

  after(function () {
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
});
