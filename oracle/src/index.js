const { initSentry } = require("./sentryInit");
initSentry();

const Sentry = require("@sentry/node");
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
