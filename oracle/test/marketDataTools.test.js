"use strict";

const { expect } = require("chai");
const proxyquire = require("proxyquire").noCallThru();

// The watch is told which servers and tools the oracle relies on. A server renamed in the
// character and not here would be reported missing for ever, and the real one never checked.
describe("the market-data tools the oracle relies on", function () {
  it("names only tool servers the agent's character starts", function () {
    const { MARKET_DATA_TOOLS } = require("../src/elizaos/marketDataTools");
    // The character reads env files as it loads; a test must not depend on what is in them.
    const character = proxyquire("../src/elizaos/character.js", { dotenv: { config: () => ({}) } });

    expect(Object.keys(MARKET_DATA_TOOLS)).to.not.be.empty;
    expect(Object.keys(character.settings.mcp.servers)).to.include.members(
      Object.keys(MARKET_DATA_TOOLS),
    );
  });

  it("names at least one tool for each server", function () {
    const { MARKET_DATA_TOOLS } = require("../src/elizaos/marketDataTools");

    for (const [server, tools] of Object.entries(MARKET_DATA_TOOLS)) {
      expect(tools, server).to.be.an("array").that.is.not.empty;
    }
  });
});
