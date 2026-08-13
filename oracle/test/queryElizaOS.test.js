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
  const captured = { text: null, composeArgs: null, eventHandlers: {}, runtimes: [] };
  // Held in a box so a test can change what the run emits WITHOUT reloading the module —
  // reloading would hand back a fresh runProvenance singleton and quietly void the assertion.
  const script = { thoughts };

  // Mirrors the real runtime surface queryElizaOS touches — agentId, ensureConnection,
  // createMemory, getMemoryById — plus the two used by the new behaviour. A stub thinner than
  // the real dependency would make these tests pass against code that cannot run.
  //
  // Built per call rather than once, because handler registration is keyed on the runtime
  // INSTANCE: a test that can only ever see one runtime cannot tell instance-keying apart from
  // a one-way boolean, which is exactly how the restart-safety gap survived a round of review.
  const makeRuntime = () => {
    const own = { eventHandlers: {} };
    const runtime = {
      agentId: "agent-uuid",
      ownHandlers: own.eventHandlers,
      ensureConnection: sinon.stub().resolves(),
      createMemory: sinon.stub().resolves(),
      getMemoryById: sinon.stub().resolves(null),
      composeState: sinon.stub().callsFake(async (_message, includeList, onlyInclude) => {
        captured.composeArgs = { includeList, onlyInclude };
        return { values: {}, text: "", data: { providers: providerData } };
      }),
      registerEvent: (event, handler) => {
        own.eventHandlers[event] = handler;
        // `captured.eventHandlers` stays "whatever was registered most recently", which is what
        // handleMessage drives; per-runtime handlers are asserted via `ownHandlers`.
        captured.eventHandlers[event] = handler;
      },
    };
    captured.runtimes.push(runtime);
    return runtime;
  };

  let runtime = makeRuntime();

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
      // Drive the runtime's own signals in the order ElizaOS emits them — including
      // ACTION_COMPLETED, which is what CLEARS the action label. Emitting only ACTION_STARTED
      // made this stub a half-model of the runtime: `currentAction` was never cleared, so an
      // un-actioned thought inherited the previous action's title and the test still passed
      // because it asserted only the description. A stub that cannot produce the clearing signal
      // cannot detect a regression in the clearing logic.
      for (const t of script.thoughts) {
        if (t.action && captured.eventHandlers.ACTION_STARTED) {
          await captured.eventHandlers.ACTION_STARTED({ roomId: ROOM_ID, content: {} , actionName: t.action });
        }
        await options.onResponse({ text: t.text ?? "partial", thought: t.thought });
        if (t.action && captured.eventHandlers.ACTION_COMPLETED) {
          await captured.eventHandlers.ACTION_COMPLETED({ roomId: ROOM_ID, content: {}, actionName: t.action });
        }
      }
      // NOT awaited, deliberately — this mirrors @elizaos/core exactly. In async mode (the mode
      // we are in, because we pass `onResponse`), the runtime does:
      //
      //     .then(() => { if (options.onComplete) options.onComplete(); })
      //     .catch((error) => { if (options.onError) options.onError(error); })
      //
      // The `.then` callback CALLS onComplete without returning it, so its promise is never
      // chained and a rejection inside it does not reach that `.catch` — it becomes an unhandled
      // rejection while queryElizaOS's own promise stays pending forever, holding a p-queue slot.
      //
      // This stub used to `await` it, which made it a more forgiving model than the real runtime
      // and hid that hazard entirely. Verified against
      // node_modules/@elizaos/core/dist/node/index.node.js:51783-51788.
      options.onComplete();
      return { messageId: "m1", userMessage: {} };
    }
  }

  /** Simulates the runtime being replaced — a re-init, or a supervisor restarting the agents. */
  function replaceRuntime() {
    runtime = makeRuntime();
    return runtime;
  }

  /** Rewrites what the next run emits, on the SAME module instance. */
  function setThoughts(next) {
    script.thoughts = next;
  }

  return { ElizaOS, captured, runtime, replaceRuntime, setThoughts };
}

function loadOracle(elizaStub, extraStubs = {}) {
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
    ...extraStubs,
  });
}


/**
 * Loads the oracle with a plugin build that has NO `setBrainAccessor` export, while controlling
 * whether the host believes a Brain is configured. That pairing is the whole point: the same
 * missing export means "expected" on localnet and "broken build" on mainnet.
 */
function loadOracleWithBrainConfigured(elizaStub, configured) {
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
    // No setBrainAccessor on the module — the stale-build scenario.
    "./elizaos/plugins/plugin-senseai/dist/index.js": { default: {} },
    "./elizaos/character.js": {},
    "./brainContext": {
      getHandles: async () => null,
      isConfigured: () => configured,
    },
  });
}

describe("queryElizaOS — provider-composed context", () => {
  // The shape ElizaOS ACTUALLY composes: each provider's whole result — `{ ...result,
  // providerName }` — under state.data.providers[name], so the payload sits under `.data`.
  // The first version of this stub matched the parser's assumption instead, which made the test
  // circular and concealed a parser that would have returned [] on every live answer.
  const providerData = {
    MARKET_INTELLIGENCE: {
      text: "### SOVEREIGN MARKET INTELLIGENCE …",
      values: { MARKET_INTELLIGENCE_INJECTED: true },
      data: {
        latestNews: [
          { title: "BTC ETF inflows accelerate", url: "https://example.test/a" },
          { title: "ETH staking yield dips", url: "https://example.test/b" },
        ],
      },
      providerName: "MARKET_INTELLIGENCE",
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
    // Asserts the TITLE too, not just the description. Only checking the description let this
    // test pass while the title was silently wrong: the stub fired ACTION_STARTED but never
    // ACTION_COMPLETED, so `currentAction` was never cleared and the un-actioned second thought
    // inherited the first thought's action.
    expect(result.reasoning[1]).to.deep.equal({
      title: "Step 2",
      description: "Weighing the macro backdrop",
    });
  });

  it("releases the run when handleMessage throws synchronously", async () => {
    // The leak review caught: this path rejects before onError ever runs, so the run was
    // stranded until cap eviction. Every other fixture here resolves, which is precisely why the
    // suite missed it.
    const stub = makeElizaStub({ providerData, thoughts: [{ thought: "t" }] });
    const realHandleMessage = stub.ElizaOS.prototype.handleMessage;
    stub.ElizaOS.prototype.handleMessage = async () => {
      throw new Error("boom");
    };
    const oracle = loadOracle(stub);

    let threw = false;
    try {
      await oracle.queryElizaOS(history("hi"), ROOM_ID, "entity-1");
    } catch {
      threw = true;
    }
    expect(threw, "the rejection must still propagate").to.equal(true);

    // Restore normal behaviour and run AGAIN ON THE SAME ORACLE, in the SAME room. This is the
    // whole assertion: proxyquire hands out a fresh module — and therefore a fresh runProvenance
    // singleton — per load, so a second `loadOracle` would start with an empty map and pass no
    // matter what finish() did. Reusing the instance is what makes the stranded run detectable:
    // two live runs in one room make soleRunIn() ambiguous, attribution is dropped, and the
    // title degrades to "Step 1".
    stub.ElizaOS.prototype.handleMessage = realHandleMessage;
    stub.setThoughts([{ thought: "after", action: "GET_ASSET_SENTIMENT" }]);

    const result = await oracle.queryElizaOS(history("hi2"), ROOM_ID, "entity-1");
    expect(result.reasoning[0].title).to.equal("GET_ASSET_SENTIMENT");
  });

  it("re-registers provenance handlers when the runtime is replaced", async () => {
    // A one-way boolean guard survives the runtime it describes. If the agents are re-initialised
    // — a supervisor restart, a retried start() — the NEW runtime gets no ACTION_STARTED handler,
    // every reasoning step silently degrades to "Step N", and nothing throws. In a long-lived TEE
    // process that is permanent and invisible.
    //
    // So the guard is keyed on the runtime INSTANCE, not on "have we ever registered".
    const stub = makeElizaStub({
      providerData,
      thoughts: [{ thought: "t", action: "GET_ASSET_SENTIMENT" }],
    });
    const oracle = loadOracle(stub);

    await oracle.queryElizaOS(history("first"), ROOM_ID, "entity-1");
    const first = stub.captured.runtimes[0];
    expect(first.ownHandlers.ACTION_STARTED, "first runtime must be wired").to.be.a("function");

    stub.replaceRuntime();
    const second = await oracle.queryElizaOS(history("second"), ROOM_ID, "entity-1");

    const replaced = stub.captured.runtimes[1];
    expect(replaced, "the stub must have handed out a new runtime").to.not.equal(first);
    expect(
      replaced.ownHandlers.ACTION_STARTED,
      "a replaced runtime must be wired too, or attribution dies silently",
    ).to.be.a("function");
    expect(second.reasoning[0].title).to.equal("GET_ASSET_SENTIMENT");
  });

  it("attributes nothing rather than wrongly when only half the handlers register", async () => {
    // Partial registration is the one case where the two obvious designs trade off against each
    // other. Stamp the guard BEFORE registering and a half-wired runtime never retries — but if
    // ACTION_STARTED landed and ACTION_COMPLETED did not, `currentAction` is set and never
    // cleared, so every later thought inherits a finished action, permanently, in paid storage.
    // Stamp AFTER and the retry re-registers ACTION_STARTED on every prompt, growing handlers
    // without bound on a long-lived TEE runtime.
    //
    // Neither trade is necessary: registering the CLEARING handler first makes every partial
    // state safe. If ACTION_COMPLETED throws, ACTION_STARTED is never reached, so nothing can
    // set an action label in the first place — attribution degrades to "Step N", which is the
    // honest degradation, with no retry and no leak.
    const stub = makeElizaStub({
      providerData,
      thoughts: [
        { thought: "Checking the cache", action: "GET_ASSET_SENTIMENT" },
        { thought: "Now weighing the macro backdrop" },
      ],
    });

    // Only ACTION_COMPLETED fails to register.
    const runtime = stub.captured.runtimes[0];
    const realRegister = runtime.registerEvent;
    runtime.registerEvent = (event, handler) => {
      if (event === "ACTION_COMPLETED") throw new Error("registration rejected");
      realRegister(event, handler);
    };

    const oracle = loadOracle(stub);
    const result = await oracle.queryElizaOS(history("hi"), ROOM_ID, "entity-1");

    for (const [i, step] of result.reasoning.entries()) {
      expect(
        step.title,
        `step ${i + 1} must not carry an action label that can never be cleared`,
      ).to.match(/^Step \d+$/);
    }
  });

  it("refuses to start when the plugin seam is missing but the Brain IS configured", async () => {
    // A missing setBrainAccessor export is a broken/stale plugin build, not a runtime blip. The
    // providers degrade so gracefully that the result is indistinguishable from a Cloud SQL
    // outage — mainnet answering without market context indefinitely, with a log line as the
    // only signal. An operator who configured Cloud SQL has stated the intent; failing to honour
    // it must stop the process at startup, before a single prompt is served.
    const stub = makeElizaStub({ providerData, thoughts: [{ thought: "t" }] });
    const oracle = loadOracleWithBrainConfigured(stub, true);

    let message = "";
    try {
      await oracle.queryElizaOS(history("hi"), ROOM_ID, "entity-1");
    } catch (err) {
      message = String(err?.message ?? err);
    }

    expect(message, "a broken build must not serve traffic").to.match(/setBrainAccessor missing/);
    expect(message, "the message must name the fix, not just the symptom").to.match(/[Rr]ebuild/);
  });

  it("starts and answers without context when no Brain is configured", async () => {
    // The other side of the same predicate: localnet e2e has no Cloud SQL at all, so absence is
    // expected. Refusing to boot here would break precisely the environments the graceful
    // degradation exists for — which is why the check is gated rather than absolute.
    const stub = makeElizaStub({ providerData, thoughts: [{ thought: "t" }] });
    const oracle = loadOracleWithBrainConfigured(stub, false);

    const result = await oracle.queryElizaOS(history("hi"), ROOM_ID, "entity-1");

    expect(result.text).to.be.a("string");
  });

  it("does not re-register on the same runtime across prompts", async () => {
    // The other half of the invariant: handlers live on the SHARED runtime, so registering per
    // prompt would leak one per prompt and multiply exactly the cross-talk the run-correlation
    // exists to prevent.
    const stub = makeElizaStub({ providerData, thoughts: [{ thought: "t" }] });
    const oracle = loadOracle(stub);

    let registrations = 0;
    const runtime = stub.captured.runtimes[0];
    const realRegister = runtime.registerEvent;
    runtime.registerEvent = (event, handler) => {
      registrations += 1;
      realRegister(event, handler);
    };

    await oracle.queryElizaOS(history("a"), ROOM_ID, "entity-1");
    await oracle.queryElizaOS(history("b"), ROOM_ID, "entity-1");
    await oracle.queryElizaOS(history("c"), ROOM_ID, "entity-1");

    expect(registrations, "one runtime, one registration pass").to.equal(2);
  });

  it("never stores a tool payload as the answer, whatever order it arrives in", async () => {
    // The live base-testnet failure, end to end. The agent emits an acknowledgement and
    // then a CALL_MCP_TOOL payload; last-writer-wins stored the payload, so a paying user
    // received 164 characters of TypeScript instead of an answer. Asserting at this level
    // (not just on selectAnswer) is the point: the defect was in how queryElizaOS consumed
    // the callbacks, so a unit test of the chooser alone would not have caught it.
    const stub = makeElizaStub({
      providerData,
      thoughts: [
        { thought: "Acknowledging, then querying CoinGecko", text: "Analysing current market intelligence for Bitcoin. Stand by." },
        { thought: "Invoking the tool", text: "```typescript\nawait client.news.get({ coin_id: 'bitcoin' });\n```" },
      ],
    });
    const oracle = loadOracle(stub);

    const result = await oracle.queryElizaOS(history("What is the latest news on Bitcoin?"), ROOM_ID, "entity-1");

    expect(result.text, "a code payload must never be the stored answer").to.not.match(/```/);
    expect(result.text).to.equal("Analysing current market intelligence for Bitcoin. Stand by.");
  });

  it("stores the synthesis, not the acknowledgement, when the tool call succeeds", async () => {
    // The companion to the test above, and the one that pins the ORDERING rule. That test
    // proves a payload never wins; this proves the acknowledgement does not win either when a
    // real answer follows it. Without this, flipping selectAnswer from "last prose" to "first
    // prose" would keep the incident test green while silently dropping every synthesised
    // answer — the failure would look identical to the bug being fixed.
    const stub = makeElizaStub({
      providerData,
      thoughts: [
        { thought: "Acknowledging, then querying CoinGecko", text: "Analysing current market intelligence for Bitcoin. Stand by." },
        { thought: "Invoking the tool", text: "```typescript\nawait client.news.get({ coin_id: 'bitcoin' });\n```" },
        { thought: "Synthesising", text: "Bitcoin is consolidating near $61k with declining volume; momentum is neutral." },
      ],
    });
    const oracle = loadOracle(stub);

    const result = await oracle.queryElizaOS(history("What is the latest news on Bitcoin?"), ROOM_ID, "entity-1");

    expect(result.text).to.equal("Bitcoin is consolidating near $61k with declining volume; momentum is neutral.");
  });

  it("routes the selected answer through the outbound sanitiser before resolving", async () => {
    // selectAnswer decides WHICH emission is the answer; it deliberately does not judge the text
    // beyond "is this a payload". When it picks an emission that never went through
    // `generateSanitized` — a third-party action's prose, or the acknowledgement — a template
    // leak would otherwise be encrypted into an immutable MessageFile the user has paid for.
    //
    // Asserted through a stub rather than the real sanitiser so this pins the WIRING. Whether
    // any particular leak shape is caught belongs to outboundSanitizer.test.js and the Brain's
    // own suite; duplicating it here would pass just as well against an answer path that never
    // called the sanitiser at all.
    const seen = [];
    const stub = makeElizaStub({
      providerData,
      thoughts: [{ thought: "Synthesising", text: "<response>Bitcoin is near $61k.</response>" }],
    });
    const oracle = loadOracle(stub, {
      "./outboundSanitizer": {
        sanitizeAnswer: async (text) => {
          seen.push(text);
          return "Bitcoin is near $61k.";
        },
      },
    });

    const result = await oracle.queryElizaOS(history("How is Bitcoin doing?"), ROOM_ID, "entity-1");

    expect(seen, "the selected answer must reach the sanitiser").to.deep.equal([
      "<response>Bitcoin is near $61k.</response>",
    ]);
    expect(result.text, "and the sanitised text is what gets stored").to.equal(
      "Bitcoin is near $61k.",
    );
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
