// Networks the deploy wallet runs on its own. Any other network counts as live, so a network
// added later is checked rather than skipped.
const LOCAL_NETWORKS = new Set(["hardhat", "localhost", "localnet"]);

module.exports = { LOCAL_NETWORKS };
