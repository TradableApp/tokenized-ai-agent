const { initSentry } = require("./sentryInit");
initSentry();

const Sentry = require("@sentry/node");

const { describedError, withoutAddresses } = require("./errorDescription");
const { obtainOracleKeys } = require("./oracleKeys");
const { wrapConsole } = require("./secretValues");

// The oracle's own keys are removed from everything printed from here on, whoever prints it.
// A machine's logs are kept, and its admin can read them.
wrapConsole(console);

// Crash handlers FIRST, so every fatal path below gets the same clean shutdown — including the
// config guard's ConfigError and any throw from a module-scope side effect during the requires
// that follow. Registering them after those lines meant the earliest, most operationally
// interesting crashes were the ones that skipped the flush.
// Printed as described errors: whatever reaches here is unknown, and a provider error carries
// the address of its request. Sentry gets the original, which its scrubber clears of addresses.
process.on("unhandledRejection", (reason) => {
  console.error("[Fatal] Unhandled promise rejection:", describedError(reason));
  Sentry.captureException(reason);
});

process.on("uncaughtException", (error) => {
  console.error("[Fatal] Uncaught exception:", describedError(error));
  Sentry.captureException(error);
  Sentry.flush(2000).finally(() => process.exit(1));
});

// Before anything that needs a key. Naming a bad variable here costs one restart; the same
// mistake found later costs a boot that looks alive and answers nothing.
const { validateConfig, ConfigError } = require("./startupConfig");

try {
  validateConfig();
} catch (err) {
  // A ConfigError is actionable operator error, not a crash. Letting it reach uncaughtException
  // would file a Sentry incident on every bad-config boot — and bad-config boots are the EXPECTED
  // case this guard was written for, since each TEE deploy iteration is an image build, an
  // on-chain update and a restart. Filling the incident feed with them is how a real crash gets
  // missed. The message already names every problem, so a stack trace adds nothing.
  // The problems name each setting and never its value (startupConfig.js); addresses are
  // removed as well, in case a value was written into the text all the same.
  if (err instanceof ConfigError) {
    console.error(withoutAddresses(err.message));
    process.exit(1);
  }
  throw err; // genuine bugs still reach uncaughtException → Sentry
}

/**
 * Keys first, then the oracle. The keys of a deployed oracle come from the ROFL key service,
 * which is asked over a socket and may not be ready yet, so the wallet and the contract can
 * only be built once they have arrived. Until then the process waits; it uses no other key.
 */
async function main() {
  const keys = await obtainOracleKeys();
  // Required here, not at the top: nothing of the oracle is built before it has its keys.
  // eslint-disable-next-line global-require
  const oracle = require("./aiAgentOracle");
  oracle.configure(keys);
  // The live reasoning stream server, before anything can answer a prompt, so every run's
  // frames reach it. Switched off (STREAM_ENABLED=false), it opens nothing and the oracle runs
  // exactly as it does without it; a port it cannot have is logged and the oracle answers
  // without it.
  // eslint-disable-next-line global-require
  const { startStreamFromEnv } = require("./stream/streamServer");
  await startStreamFromEnv({ setSink: oracle.setStreamSink });
  console.log("Starting Node.js ROFL Oracle Service...");
  await oracle.start();
}

// A start-up that fails must end the process: by then the database pool is open and the
// heartbeat may be running, and an oracle left half-started looks alive while answering nothing.
main().catch((error) => {
  console.error("[Fatal] The oracle could not start:", describedError(error));
  Sentry.captureException(error);
  Sentry.flush(2000).finally(() => process.exit(1));
});
