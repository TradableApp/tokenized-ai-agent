"use strict";

const { expect } = require("chai");
const fs = require("fs");

function load() {
  // Loaded inside each test so a missing module fails that test, not the whole run.
  return require("../src/elizaos/mutedFrameworkLogs").isMutedFrameworkLog;
}

// The MCP plugin prints the arguments the model chose for a tool call, the model's reasoning and
// the tool's output. The model writes the first two from the user's prompt.
describe("the framework log lines the oracle does not print", function () {
  it("hides the model's raw choice of tool and arguments", function () {
    const line = '[WITH-MODEL-RETRY] Raw selection input:\n{"toolArguments":{"ids":"a-question"}}';

    expect(load()([line], "info")).to.equal(true);
  });

  it("hides the model's parsed choice of tool and arguments", function () {
    const line = '[SELECTED] Tool Selection result:\n{"toolArguments":{"ids":"a-question"}}';

    expect(load()([line], "info")).to.equal(true);
  });

  it("hides the model's reasoning for a call, and the prompt built from the tool's output", function () {
    expect(
      load()(['[CALLING] Calling tool "s/t" on server with reasoning: "..."'], "info"),
    ).to.equal(true);
    expect(load()([{ reasoningPrompt: "..." }, "reasoning prompt"], "info")).to.equal(true);
  });

  it("hides an info line that names the market-data tool server", function () {
    expect(load()(["Calling tool on coingecko_mcp_local"], "info")).to.equal(true);
    expect(load()([{ serverName: "coingecko_mcp_local", reasoning: "..." }], "info")).to.equal(
      true,
    );
  });

  it("hides the tool documentation the framework prints", function () {
    expect(load()(["# Response Schema"], "info")).to.equal(true);
    expect(load()(["a filter", "jq_filter"], "info")).to.equal(true);
  });

  // This one is printed as an error, and quotes the start of what the model wrote.
  it("hides the model's unreadable choice at every level", function () {
    const line =
      "[WITH-MODEL-RETRY] Failed to parse response: Unexpected token 'a', \"a-question\"";

    expect(load()([{ errorMessage: "..." }, line], "error")).to.equal(true);
    expect(load()([line], "warn")).to.equal(true);
  });

  // A warning or an error about the server itself is how its faults are seen.
  it("lets a warning or an error that names the server through", function () {
    expect(load()(["Transport closed: coingecko_mcp_local"], "warn")).to.equal(false);
    expect(load()([{ serverName: "coingecko_mcp_local" }, "[MCP] Failed"], "error")).to.equal(
      false,
    );
  });

  it("lets every other line through", function () {
    expect(load()(["Agent started"], "info")).to.equal(false);
    expect(load()([], "info")).to.equal(false);
  });

  it("does not throw on a value that cannot be written out", function () {
    const circular = {};
    circular.self = circular;

    expect(load()([circular, 10n], "info")).to.equal(false);
  });

  // The terms are the plugin's own wording. The plugin is at an exact version; this fails when
  // a new version words a line differently, before the line can be printed again.
  it("still matches the lines as the plugin words them", function () {
    const plugin = fs.readFileSync(require.resolve("@elizaos/plugin-mcp"), "utf8");

    for (const wording of [
      "`[WITH-MODEL-RETRY] Raw selection input:",
      "`[WITH-MODEL-RETRY] Failed to parse response:",
      "`[SELECTED] Tool Selection result:",
      '`[CALLING] Calling tool "',
      '"reasoning prompt"',
    ]) {
      expect(plugin, wording).to.include(wording);
    }
  });
});

// The framework and its database plugin print errors themselves: a failed query with its text
// and its bound values, the address of a peer it could not reach. What it prints is cleaned.
describe("the framework log lines the oracle cleans before they are printed", function () {
  function cleaned(args) {
    return require("../src/elizaos/mutedFrameworkLogs").cleanedFrameworkArgs(args);
  }

  it("keeps the fact of a failed query and drops its text and its values", function () {
    const [fields, text] = cleaned([
      {
        src: "plugin:sql",
        extension: "vector",
        error: "Failed query: CREATE EXTENSION IF NOT EXISTS vector\nparams: a-users-question",
      },
      "Could not install extension",
    ]);

    expect(text).to.equal("Could not install extension");
    expect(fields).to.deep.equal({
      src: "plugin:sql",
      extension: "vector",
      error: "Failed query",
    });
  });

  it("drops bound values printed in a line of text", function () {
    expect(cleaned(["insert failed params: 0x1111, a-users-question"])).to.deep.equal([
      "insert failed",
    ]);
  });

  it("removes a network peer and an address from text and fields", function () {
    const [text, fields] = cleaned([
      "connect ECONNREFUSED 192.0.2.10:5432",
      { error: "request to https://rpc.example/v2/aB3dE6gH9jK2mN5pQ8sT failed", attempt: 2 },
    ]);

    expect(text).to.equal("connect ECONNREFUSED [peer removed]");
    expect(fields).to.deep.equal({ error: "request to [address removed] failed", attempt: 2 });
  });

  it("prints an error object as its description", function () {
    const failure = Object.assign(new Error("connect ECONNREFUSED 198.51.100.4:5432"), {
      code: "ECONNREFUSED",
      address: "198.51.100.4",
    });

    expect(cleaned(["[plugin:sql] failed", failure])).to.deep.equal([
      "[plugin:sql] failed",
      "connect ECONNREFUSED [peer removed]",
    ]);
  });

  it("does not change what it is given, and passes other values through", function () {
    const fields = { error: "connect ECONNREFUSED 192.0.2.10:5432" };

    const result = cleaned([fields, 7, null, undefined]);

    expect(fields.error).to.include("192.0.2.10");
    expect(result.slice(1)).to.deep.equal([7, null, undefined]);
  });

  it("covers every level the framework logger has", function () {
    const { FRAMEWORK_LOG_LEVELS } = require("../src/elizaos/mutedFrameworkLogs");

    expect(FRAMEWORK_LOG_LEVELS).to.include.members([
      "info",
      "log",
      "warn",
      "error",
      "fatal",
      "debug",
      "trace",
      "success",
      "progress",
      "verbose",
    ]);
  });
});
