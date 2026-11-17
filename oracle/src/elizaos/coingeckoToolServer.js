"use strict";

/**
 * How the oracle starts the CoinGecko tool server.
 *
 * The server is a dependency at one exact version, so it is in the lockfile and in the image, and
 * the oracle's own node runs its entry file from there. Nothing is fetched from a registry when
 * the oracle runs: what answers a tool call is the code that was reviewed and built.
 *
 * The version and the options matter beyond that:
 *
 * - This release offers fixed tools (a price, a market chart), each a read from CoinGecko. Later
 *   major releases replace them with one tool that runs code written by the model.
 * - This release has such a tool too, off unless asked for. It sends the model's code, and the
 *   CoinGecko key with it, to a third party to be run. Never pass an option that turns it on.
 * - The documentation search is on unless turned off. It sends text chosen by the model, which
 *   can carry a user's prompt, to a third party. It is turned off here.
 */

// The package's main entry. Resolved once, at load: a missing dependency stops the oracle at
// start-up, not at the first market question.
const SERVER_ENTRY = require.resolve("@coingecko/coingecko-mcp");

// The `=` is needed: with a space the server fails to start.
const SERVER_OPTIONS = ["--no-tools=docs"];

/**
 * The launch settings for the framework's MCP plugin.
 *
 * The plugin starts the child with `env` below plus PATH, and the MCP library adds a few defaults
 * of its own (HOME, USER, SHELL and the like). Nothing else of the oracle's environment is passed.
 *
 * @param {Record<string, string | undefined>} env The oracle's environment. Only the CoinGecko
 *   key is read from it.
 * @returns {{ type: "stdio", command: string, args: string[], env: Record<string, string> }}
 */
function coingeckoToolServer(env) {
  const apiKey = env.COINGECKO_API_KEY || "";

  return {
    type: "stdio",
    command: process.execPath,
    args: [SERVER_ENTRY, ...SERVER_OPTIONS],
    env: {
      COINGECKO_PRO_API_KEY: apiKey,
      // The server picks its base address and header from this, so it follows the key.
      COINGECKO_ENVIRONMENT: apiKey ? "pro" : "demo",
    },
  };
}

module.exports = { coingeckoToolServer };
