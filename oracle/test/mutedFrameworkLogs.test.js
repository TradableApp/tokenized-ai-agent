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
