"use strict";

/**
 * How the oracle starts the CoinGecko tool server.
 *
 * The server is a dependency at one exact version, so it is in the lockfile and in the image, and
 * it is started from there with node's own executable. Nothing is resolved or downloaded when the
 * oracle runs: what answers a tool call is the code that was reviewed and built.
 *
 * The version matters beyond that. Later major releases replace the fixed tools (a price, a
 * market chart) with one tool that runs code written by the model, which this oracle neither can
 * do (it needs a runtime the image does not have) nor should.
 */

// The package's main entry. Resolved once, at load: a missing dependency stops the oracle at
// start-up, not at the first market question.
const SERVER_ENTRY = require.resolve("@coingecko/coingecko-mcp");

/**
 * The launch settings for the framework's MCP plugin.
 *
 * @param {NodeJS.ProcessEnv} env The oracle's environment. Only the CoinGecko key is read from it,
 *   and only that key is handed on.
 * @returns {{ type: "stdio", command: string, args: string[], env: Record<string, string> }}
 */
function coingeckoToolServer(env) {
  const apiKey = env.COINGECKO_API_KEY || "";

  return {
    type: "stdio",
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: {
      COINGECKO_PRO_API_KEY: apiKey,
      // The server picks its base address and header from this, so it follows the key.
      COINGECKO_ENVIRONMENT: apiKey ? "pro" : "demo",
    },
  };
}

module.exports = { coingeckoToolServer };
