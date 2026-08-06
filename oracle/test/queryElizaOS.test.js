const { ethers } = require("ethers");

const { expect } = require("chai");
const proxyquire = require("proxyquire").noCallThru();
const sinon = require("sinon");

// queryElizaOS — context via PROVIDERS, provenance from the run. CU-86d3ud1va, part 2.
//
// WHAT CHANGES. Today the oracle hand-builds the prompt:
//
//     text: `${currentMessage.content}\n\n[MARKET CONTEXT — …]\n${marketContext.contextText}`
//
// bypassing the composition ElizaOS exists to do, and takes `sources` from the list it fetched
// alongside — everything injected, whether the answer drew on it or not, while the dApp renders
// "Used N sources" over it.
//
// After this change the message carries ONLY the user's prompt; MACRO_SENTIMENT and
// MARKET_INTELLIGENCE put the market context into composition, and provenance is read back from
// what the run actually composed (StateData.providers) plus the run's own action/thought events.
//
// These assertions guard the live, paid answer path, so they are deliberately behavioural: what
// text reaches the model, and what provenance reaches the MessageFile.

const FAKE_AGENT_ID = "fake-agent-id";

/** conversationHistory is an array whose LAST entry is the new prompt (see queryElizaOS). */
const history = content => [{ role: "user", content }];
const ROOM_ID = "room-1";

/** Builds an ElizaOS stub that records what it was asked to do. */
function makeElizaStub({ providerData, thoughts }) {
  const captured = { text: null, composeArgs: null, eventHandlers: {} };

  // Mirrors the real runtime surface queryElizaOS touches — agentId, ensureConnection,
  // createMemory, getMemoryById — plus the two used by the new behaviour. A stub thinner than
  // the real dependency would make these tests pass against code that cannot run.
  const runtime = {
    agentId: "agent-uuid",
    ensureConnection: sinon.stub().resolves(),
    createMemory: sinon.stub().resolves(),
    getMemoryById: sinon.stub().resolves(null),
    composeState: sinon.stub().callsFake(async (_message, includeList, onlyInclude) => {
      captured.composeArgs = { includeList, onlyInclude };
      return { values: {}, text: "", data: { providers: providerData } };
    }),
    registerEvent: (event, handler) => {
      captured.eventHandlers[event] = handler;
    },
  };

  class ElizaOS {
    async addAgents() {
      return [FAKE_AGENT_ID];
    }
    async startAgents() {}
    getAgent() {
      return runtime;
    }
    async handleMessage(_target, message, options) {
      captured.text = message.content.text;
      // Drive the runtime's own signals in the order ElizaOS emits them.
      for (const t of thoughts) {
        if (t.action && captured.eventHandlers.ACTION_STARTED) {
          await captured.eventHandlers.ACTION_STARTED({ roomId: ROOM_ID, content: {} , actionName: t.action });
        }
        await options.onResponse({ text: t.text ?? "partial", thought: t.thought });
      }
      await options.onComplete();
      return { messageId: "m1", userMessage: {} };
    }
  }

  return { ElizaOS, captured, runtime };
}

function loadOracle(elizaStub) {
  // The module builds a signer at load time; the committed .env.oracle.example carries a
  // placeholder key that ethers rejects. Same approach as aiAgentOracle.test.js — give it a
  // real throwaway key so the failure under test is the behaviour, not the setup.
  process.env.PRIVATE_KEY = ethers.Wallet.createRandom().privateKey;
  return proxyquire("../src/aiAgentOracle", {
    "@elizaos/core": {
      ElizaOS: elizaStub.ElizaOS,
      elizaLogger: { info() {}, log() {}, error() {}, warn() {}, debug() {} },
      stringToUuid: s => s,
      createUniqueUuid: (_ns, s) => s,
      ChannelType: { DM: "DM", WORLD: "WORLD" },
      EventType: { ACTION_STARTED: "ACTION_STARTED", ACTION_COMPLETED: "ACTION_COMPLETED" },
    },
    "./elizaos/plugins/plugin-senseai/dist/index.js": { default: {} },
    "./elizaos/character.js": {},
  });
}

describe("queryElizaOS — provider-composed context", () => {
  const providerData = {
    MARKET_INTELLIGENCE: {
      latestNews: [
        { title: "BTC ETF inflows accelerate", url: "https://example.test/a" },
        { title: "ETH staking yield dips", url: "https://example.test/b" },
      ],
    },
  };

  it("sends ONLY the user's prompt — no hand-built market context", async () => {
    // The whole point: ElizaOS composes context through providers. A concatenated block means
    // the framework is being bypassed and the two bodies diverge structurally.
    const stub = makeElizaStub({ providerData, thoughts: [{ thought: "thinking" }] });
    const oracle = loadOracle(stub);

    await oracle.queryElizaOS(history("What is the sentiment on SOL?"), ROOM_ID, "entity-1");

    expect(stub.captured.text).to.equal("What is the sentiment on SOL?");
    expect(stub.captured.text).to.not.match(/MARKET CONTEXT/);
  });

  it("composes only the Brain providers, not the whole set", async () => {
    // onlyInclude keeps the pre-inference read to the two providers whose data becomes
    // provenance, rather than running every provider twice per prompt.
    // Needs at least one response: with none, the oracle correctly rejects with
    // "completed but generated no text", which is real behaviour, not a fixture detail.
    const stub = makeElizaStub({ providerData, thoughts: [{ thought: "t" }] });
    const oracle = loadOracle(stub);

    await oracle.queryElizaOS(history("hi"), ROOM_ID, "entity-1");

    expect(stub.captured.composeArgs.includeList).to.have.members([
      "MACRO_SENTIMENT",
      "MARKET_INTELLIGENCE",
    ]);
    expect(stub.captured.composeArgs.onlyInclude).to.equal(true);
  });

  it("derives sources from what the run composed", async () => {
    const stub = makeElizaStub({ providerData, thoughts: [{ thought: "t" }] });
    const oracle = loadOracle(stub);

    const result = await oracle.queryElizaOS(history("hi"), ROOM_ID, "entity-1");

    expect(result.sources).to.deep.equal([
      { title: "BTC ETF inflows accelerate", url: "https://example.test/a" },
      { title: "ETH staking yield dips", url: "https://example.test/b" },
    ]);
  });

  it("titles reasoning by the action in flight, not 'Step N'", async () => {
    const stub = makeElizaStub({
      providerData,
      thoughts: [
        { thought: "Cache miss — fetching fresh metrics", action: "GET_ASSET_SENTIMENT" },
        { thought: "Weighing the macro backdrop" },
      ],
    });
    const oracle = loadOracle(stub);

    const result = await oracle.queryElizaOS(history("hi"), ROOM_ID, "entity-1");

    expect(result.reasoning[0]).to.deep.equal({
      title: "GET_ASSET_SENTIMENT",
      description: "Cache miss — fetching fresh metrics",
    });
    expect(result.reasoning[1].description).to.equal("Weighing the macro backdrop");
  });

  it("still answers when composition yields no context", async () => {
    // Localnet e2e has no Cloud SQL; an unconfigured Brain must cost the context, not the answer.
    const stub = makeElizaStub({ providerData: {}, thoughts: [{ thought: "t" }] });
    const oracle = loadOracle(stub);

    const result = await oracle.queryElizaOS(history("hi"), ROOM_ID, "entity-1");

    expect(result.sources).to.deep.equal([]);
    expect(result.text).to.be.a("string");
  });
});
