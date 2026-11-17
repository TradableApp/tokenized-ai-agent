"use strict";

/**
 * The tool servers in the agent's character that market answers rely on, and for each the tools
 * it must offer. A server can be connected and still not offer them: another release of it
 * offers different tools.
 *
 * The names are the keys of `settings.mcp.servers` in the character; a test holds the two
 * together.
 */
const MARKET_DATA_TOOLS = Object.freeze({
  coingecko_mcp_local: Object.freeze(["get_simple_price", "get_coins_markets"]),
});

module.exports = { MARKET_DATA_TOOLS };
