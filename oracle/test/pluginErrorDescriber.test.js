const path = require("node:path");

const { expect } = require("chai");
const proxyquire = require("proxyquire").noCallThru();

/**
 * The plugin describes its errors with the oracle's describer, which the oracle hands over when
 * its main module loads the plugin. The agent, and so every action, is built later, in `start`.
 * Without the hand-over the plugin gives an error's kind alone ("Error"), and an operator and the
 * model would lose the cause of a failed action. So the oracle refuses to load a plugin build
 * that cannot take it, and loading the oracle is shown to set it before any action runs.
 */
const DIST = path.resolve(__dirname, "../src/elizaos/plugins/plugin-senseai/dist/index.js");
const KEY = "Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Jh1Gf0Ed";

const runtimeFailingWith = (error) => ({
  agentId: "agent-1",
  getService: (name) =>
    name === "brain"
      ? {
          getAssetSentiment: async () => {
            throw error;
          },
        }
      : null,
  getMemories: async () => [],
  useModel: async (_type, params) => (params?.schema ? { tickers: ["BTC"] } : ""),
  composeState: async () => ({ data: {}, values: {} }),
});

describe("the plugin's error describer", () => {
  it("is handed to the built plugin when the oracle loads, before any action runs", async () => {
    const plugin = require(DIST);
    plugin.setErrorDescriber(null);

    proxyquire("../src/aiAgentOracle", { "./elizaos/character.js": {} });

    const action = plugin.default.actions.find((a) => a.name === "ANALYZE_ASSET_SENTIMENT");
    const result = await action.handler(
      runtimeFailingWith(new Error(`connection refused by https://rpc.example/v2/${KEY}`)),
      { roomId: "room-1", content: { text: "how is BTC looking?" } },
      undefined,
      { actionPlan: { currentStep: 1, totalSteps: 2 } },
      async () => {},
      [],
    );

    expect(result.success).to.equal(false);
    expect(result.error).to.contain("connection refused");
    expect(result.error).to.not.contain(KEY);
  });

  it("is required: the oracle refuses to load a plugin build that cannot take it", () => {
    expect(() =>
      proxyquire("../src/aiAgentOracle", {
        "./elizaos/plugins/plugin-senseai/dist/index.js": { default: {} },
        "./elizaos/character.js": {},
      }),
    ).to.throw(/setErrorDescriber/);
  });
});
