import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { elizaLogger } from "@elizaos/core";

// The oracle's own describer, as the host hands it to the plugin at start-up. Loaded here only
// by the test: the plugin's bundle never contains it.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { describeError: oracleDescribeError } = require("../../../../../errorDescription.js");

import { analyzeAssetSentimentAction } from "../actions/analyzeAssetSentiment";
import { getNewsDetailsAction } from "../actions/getNewsDetails";
import { macroSentimentProvider } from "../providers/macroSentiment";
import { marketIntelligenceProvider } from "../providers/marketIntelligence";
import { BrainService, setBrainAccessor } from "../services/brain";
import { handleChainSynthesis } from "../utils/actionChainHelper";
import { describeError, setErrorDescriber } from "../utils/errorDescription";

// The plugin runs in the oracle's TEE and logs to the same place. An error from a provider's
// request carries the request's address, access key included; nothing the plugin logs may.
const KEY = "Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Jh1Gf0Ed";
const LEAKY_URL = `https://rpc.example/v2/${KEY}`;
const leakyError = () => new Error(`request to ${LEAKY_URL} failed, reason: socket hang up`);

const MESSAGE = {
  id: "m1",
  content: { text: "What is the latest news on Bitcoin?", source: "oracle" },
  roomId: "r1",
} as never;

let logged: string[] = [];
let spies: Array<{ mockRestore: () => void }> = [];

beforeEach(() => {
  logged = [];
  spies = (["error", "warn", "info", "debug", "log"] as const).map((level) =>
    spyOn(elizaLogger, level).mockImplementation(((...args: unknown[]) => {
      logged.push(args.map((arg) => String(arg)).join(" "));
    }) as never),
  );
  setErrorDescriber(oracleDescribeError);
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  setErrorDescriber(null);
  setBrainAccessor(null);
});

const loggedText = () => logged.join("\n");

describe("describeError (plugin)", () => {
  it("uses the describer the host hands it", () => {
    expect(describeError(leakyError())).toBe(oracleDescribeError(leakyError()));
    expect(describeError(leakyError())).toContain("socket hang up");
    expect(describeError(leakyError())).not.toContain(KEY);
  });

  it("gives only the error's kind before the host has handed it one", () => {
    setErrorDescriber(null);

    expect(describeError(Object.assign(leakyError(), { code: "ECONNRESET" }))).toBe("ECONNRESET");
    expect(describeError(new TypeError(LEAKY_URL))).toBe("TypeError");
    expect(describeError(LEAKY_URL)).toBe("Error");
  });

  it("never takes a code or a name that is more than one short word for the kind", () => {
    setErrorDescriber(null);

    expect(describeError({ code: `C ${LEAKY_URL}`, name: "TypeError" })).toBe("TypeError");
    expect(describeError({ code: LEAKY_URL, name: "Evil 192.0.2.1" })).toBe("Error");
    expect(describeError({ code: "x".repeat(65) })).toBe("Error");
    expect(describeError({ code: "connect ECONNREFUSED 192.0.2.1:5432" })).toBe("Error");
  });

  it("gives only the error's kind when the host's describer throws", () => {
    setErrorDescriber(() => {
      throw leakyError();
    });

    expect(describeError(new RangeError(LEAKY_URL))).toBe("RangeError");
  });
});

describe("the plugin's error logs carry no access key", () => {
  it("macro sentiment provider", async () => {
    const runtime = {
      getService: () => ({ getLatestMacro: async () => Promise.reject(leakyError()) }),
    } as never;

    await macroSentimentProvider.get(runtime, MESSAGE, undefined);

    expect(loggedText()).toContain("[MacroSentiment] Error fetching macro state");
    expect(loggedText()).not.toContain(KEY);
  });

  it("market intelligence provider", async () => {
    const runtime = {
      getService: () => ({ getLatestNews: async () => Promise.reject(leakyError()) }),
    } as never;

    await marketIntelligenceProvider.get(runtime, MESSAGE, undefined);

    expect(loggedText()).toContain("[MarketIntelligence] Error building news context");
    expect(loggedText()).not.toContain(KEY);
  });

  it("brain service: handles that do not resolve", async () => {
    setBrainAccessor(async () => Promise.reject(leakyError()));
    const service = await BrainService.start({ getSetting: () => undefined } as never);

    await service.getLatestMacro();

    expect(loggedText()).toContain("[Brain] Handles unavailable");
    expect(loggedText()).not.toContain(KEY);
  });

  it("brain service: failed macro and news reads", async () => {
    setBrainAccessor(async () => ({
      sentimentEngine: { getLatestMacro: async () => Promise.reject(leakyError()) },
      brain: { getLatestEnrichedNews: async () => Promise.reject(leakyError()) },
      ctx: {},
    }));
    const service = await BrainService.start({ getSetting: () => undefined } as never);

    await service.getLatestMacro();
    await service.getLatestNews();

    expect(loggedText()).toContain("[Brain] Macro read failed");
    expect(loggedText()).toContain("[Brain] News read failed");
    expect(loggedText()).not.toContain(KEY);
  });

  it("chain synthesis", async () => {
    const runtime = {
      agentId: "agent-1",
      character: { name: "SenseAI" },
      composeState: async () => ({ values: { agentName: "SenseAI" }, data: {}, text: "" }),
      useModel: async () => Promise.reject(leakyError()),
    } as never;

    await handleChainSynthesis(
      runtime,
      MESSAGE,
      { data: { actionName: "GET_NEWS_DETAILS" }, success: true } as never,
      undefined,
      undefined,
      (async () => []) as never,
    );

    expect(loggedText()).toContain("[ChainHelper] Synthesis failed");
    expect(loggedText()).not.toContain(KEY);
  });

  it("news details action: the log and the result's error", async () => {
    const runtime = {
      agentId: "agent-1",
      getService: () => ({}),
      getMemories: async () => Promise.reject(leakyError()),
    } as never;

    const result = await getNewsDetailsAction.handler(runtime, MESSAGE, undefined, {}, undefined);

    expect(loggedText()).toContain("[GetNewsDetails] Critical Failure");
    expect(loggedText()).not.toContain(KEY);
    expect(String(result?.error)).not.toContain(KEY);
  });

  it("asset sentiment action: the log and the result's error", async () => {
    const runtime = {
      agentId: "agent-1",
      getService: () => ({}),
      getMemories: async () => Promise.reject(leakyError()),
    } as never;

    const result = await analyzeAssetSentimentAction.handler(
      runtime,
      MESSAGE,
      undefined,
      {},
      undefined,
    );

    expect(loggedText()).toContain("[AnalyzeAssetSentimentAction] Error");
    expect(loggedText()).not.toContain(KEY);
    expect(String(result?.error)).not.toContain(KEY);
  });
});
