const { initSentry } = require("./sentryInit");
initSentry();

const Sentry = require("@sentry/node");

// BEFORE requiring aiAgentOracle, and that ordering is the whole point.
//
// aiAgentOracle calls initializeOracle() at MODULE SCOPE, which constructs an ethers Wallet and
// Contract as a side effect of `require`. So a malformed PRIVATE_KEY throws during the require
// below — before start(), and therefore before any guard living inside start() could name it.
// Validating there would have promised named variables and quietly not delivered for exactly the
// failures that crash earliest.
const { validateConfig } = require("./startupConfig");
validateConfig();

const { start } = require("./aiAgentOracle");

process.on("unhandledRejection", (reason) => {
  console.error("[Fatal] Unhandled promise rejection:", reason);
  Sentry.captureException(reason);
});

process.on("uncaughtException", (error) => {
  console.error("[Fatal] Uncaught exception:", error);
  Sentry.captureException(error);
  Sentry.flush(2000).finally(() => process.exit(1));
});

console.log("Starting Node.js ROFL Oracle Service...");
start();
