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
const DATABASE_ADDRESS = "postgres://oracle:not-a-real-password@db.internal/oracle_agent";

/** A framework stand-in whose add and start can be told to fail, recording what reached it. */
function makeFramework({ addFails, startFails } = {}) {
  const seen = { added: null, startCalls: 0, handled: 0 };

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
      if (startFails) throw startFails;
    }

    getAgent() {
      return runtime;
    }

    async handleMessage(_target, _message, options) {
      seen.handled += 1;
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
      "./elizaos/character.js": { name: "SenseAI", settings: {} },
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
  let errors;

  beforeEach(function () {
    errors = sinon.stub(console, "error");
    sinon.stub(console, "log");
    sinon.stub(console, "warn");
  });

  afterEach(function () {
    sinon.restore();
  });

  const loggedErrors = () => errors.getCalls().map((call) => call.args.map(String).join(" "));

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
      expect(lines.join("\n")).to.not.include("not-a-real-password");
      expect(lines.join("\n")).to.not.include("db.internal");
    });
  }
});
