"use strict";

const { expect } = require("chai");

function load() {
  // Loaded inside each test so a missing module fails that test, not the whole run.
  return require("../src/elizaos/mutedFrameworkLogs").isMutedFrameworkLog;
}

// The framework prints, at info level, the arguments the model chose for a tool call and the
// tool's documentation. The arguments are written from the user's prompt.
describe("the framework log lines the oracle does not print", function () {
  it("hides the model's choice of tool and its arguments", function () {
    const line = '[SELECTED] Tool Selection result:\n{"toolArguments":{"ids":"a-users-question"}}';

    expect(load()([line])).to.equal(true);
  });

  it("hides a line that names the market-data tool server", function () {
    expect(load()(["Calling tool on coingecko_mcp_local"])).to.equal(true);
    expect(load()([{ server: "coingecko_mcp_local" }])).to.equal(true);
  });

  it("hides the tool documentation the framework prints", function () {
    expect(load()(["# Response Schema"])).to.equal(true);
    expect(load()(["a filter", "jq_filter"])).to.equal(true);
  });

  it("lets every other line through", function () {
    expect(load()(["Agent started"])).to.equal(false);
    expect(load()([])).to.equal(false);
  });
});
