const Sentry = require("@sentry/node");
const dotenv = require("dotenv");
const { eciesEncrypt } = require("./ecies");
const { ethers } = require("ethers");
const path = require("path");
const { v5: uuidv5 } = require("uuid");
const crypto = require("crypto");
const { default: PQueue } = require("p-queue");
const { Mutex } = require("async-mutex");
const { LRUCache } = require("lru-cache");
const { holdFrameworkLogLevel } = require("./elizaos/frameworkLogLevel");

// --- Configuration & Initialization ---

// Load the specific environment file first for precedence.
if (process.env.ENV_FILE) {
  dotenv.config({ path: process.env.ENV_FILE });
}
// Load the base .env.oracle file to fill in any missing non-secret variables.
dotenv.config({ path: path.resolve(__dirname, "../.env.oracle") });

// Before the framework is loaded, which reads its log level once: its information and debug
// lines are not printed at all (frameworkLogLevel.js). After the env files, so a stricter level
// the operator set there is kept.
holdFrameworkLogLevel();

const {
  ElizaOS,
  stringToUuid,
  createUniqueUuid,
  elizaLogger,
  ChannelType,
  EventType,
  setAllowedEnvVars,
} = require("@elizaos/core");

const senseaiPluginModule = require("./elizaos/plugins/plugin-senseai/dist/index.js");
const { startAgentWithCleanSettings } = require("./elizaos/agentSettings");
const {
  conversationScopeKey,
  clearConversationRoom,
  withRoomLock,
  takeRoomTurn,
  takeMetadataTurn,
} = require("./elizaos/conversationRoom");
const {
  createAgentMemoryGate,
  runStillGoing,
  settledWithin,
} = require("./elizaos/agentMemory");
const senseaiPlugin = senseaiPluginModule.default;
const senseAiCharacter = require("./elizaos/character.js");
const { initializeOracle } = require("./contractUtility");
const { CHAIN_IDS } = require("./oracleKeys");
const {
  initializeStorage,
  uploadData,
  fetchData,
  queryTransactionByTags,
} = require("./storage/storage");
const {
  createConversationFile,
  createConversationMetadataFile,
  createMessageFile,
  createSearchIndexDeltaFile,
} = require("./formatters");
const {
  BadInputError,
  RetryableError,
  isBadInputError,
  isRetryableError,
  isTransientProviderError,
} = require("./errors");
const { submitTx } = require("./roflUtility");
const { sendAlert } = require("./alerting");
const { initInboundPrompt, stripInboundPrompt, stripStoredAnswer } = require("./inboundPrompt");
const { validatePayload } = require("./payloadValidator");
const { ORACLE_WORK_EVENTS, queryOracleWorkEvents } = require("./eventLogQuery");
const { createRangePoller } = require("./eventPoller");
const {
  DEFAULT_POLL_BACKOFF_CAP_MS,
  DEFAULT_POLL_INTERVAL_MS,
  createPollBackoff,
} = require("./pollBackoff");
const { describeError, describedError, errorKind } = require("./errorDescription");

// The plugin logs to the same place as the oracle: it describes its errors with the oracle's own
// describer, which knows the secret parts of every configured address. Handed over here, when the
// plugin is loaded, so it is in place before the agent and its actions are built in `start`.
// Without it the plugin gives an error's kind alone, and a failed action's result would lose its
// cause; a build without the seam is a stale build, so the oracle refuses to load it.
if (typeof senseaiPluginModule.setErrorDescriber !== "function") {
  throw new Error(
    "setErrorDescriber missing from the plugin build — rebuild plugin-senseai (bun run build) " +
      "from this source before starting the oracle.",
  );
}
senseaiPluginModule.setErrorDescriber(describeError);
const { createFileStateStore, isLaterPosition } = require("./oracleState/store");
const { createStateStore, resolveResumeCursor } = require("./oracleState/runtime");
const { createOutageTracker } = require("./oracleState/outageTracker");
const { createRoleGate } = require("./oracleRoleGate");

const NAMESPACE_UUID = "f7e8a6a0-8d5d-4f7d-8f8a-8c7d6e5f4a3b";
const STATE_FILE_PATH = path.resolve(__dirname, "../oracle-state.json");
const FAILED_JOBS_FILE_PATH = path.resolve(__dirname, "../failed-jobs.json");
const METADATA_UPDATES_FILE_PATH = path.resolve(__dirname, "../metadata-updates.json");

/**
 * Where the cursor and the failed-job queue are kept (see oracleState/store.js).
 *
 * Starts as the file backend so anything that runs before `start()` — and every test that never
 * calls it — has a working store. `start()` replaces it with the Postgres backend when the oracle
 * has its own agent database; the files do not survive a restart or a storage-wiping deploy
 * (tokenized-ai-agent #114).
 */
let stateStore = createFileStateStore({
  statePath: STATE_FILE_PATH,
  jobsPath: FAILED_JOBS_FILE_PATH,
  metadataPath: METADATA_UPDATES_FILE_PATH,
});

/**
 * The chain cursor, held in memory and mirrored to the state store.
 *
 * WHY IN MEMORY AT ALL. The heartbeat (CU-86d438hwt) reports `lastProcessedBlock` and the lag
 * behind head — a stalled listener means paid prompts go unanswered, so it is the most
 * actionable figure it carries. Reading it back from storage on every beat raced the writer
 * (observed on 2026-08-22: beat 1 null, beat 2 fine, no code change between them). Reading
 * memory removes the race.
 *
 * ONE writer for both copies, deliberately: `persistCursor` moves it forward, `rewindCursor`
 * moves it back, and nothing else touches the store's cursor. `test/cursorPersistence.test.js`
 * fails if a raw write reappears.
 */
let lastProcessedBlockInMemory = null;

/** Current cursor, or null before the first persist. Read by the heartbeat's vitals collector. */
function getLastProcessedBlock() {
  return lastProcessedBlockInMemory;
}

function toCursorBlock(blockNumber, caller) {
  const n = Number(blockNumber);

  // Reject garbage loudly rather than writing it. A NaN or undefined here would corrupt the
  // checkpoint the oracle resumes from, and every caller passes a block number straight from
  // ethers, so a non-finite value is a programming error worth surfacing — not a runtime
  // condition to absorb. Each call site sits inside the poll loop's try/catch, which logs.
  if (!Number.isFinite(n)) {
    throw new TypeError(`${caller}: expected a finite block number, got ${blockNumber}`);
  }
  return n;
}

const minutes = (ms) => Math.max(1, Math.round(ms / 60000));

/**
 * One alert per sustained failure of something the oracle otherwise absorbs, and one line when it
 * ends. Without this an absorbed failure leaves the oracle looking healthy (see outageTracker.js).
 */
function absorbedFailureTracker({ what, consequence, alertAfterMs, site }) {
  return createOutageTracker({
    alertAfterMs,
    onAlert: (error, { failingForMs, failures }) => {
      Sentry.captureException(error, { tags: { site } });
      return sendAlert(
        `Oracle: ${what} has been failing for ${minutes(failingForMs)} min`,
        `${what} has failed ${failures} time(s) over ${minutes(failingForMs)} minutes. ${consequence} Last error: ${describeError(error)}`,
      );
    },
    onRecover: ({ failedForMs, failures, alerted }) => {
      console.log(
        `[OracleState] ${what} recovered after ${minutes(failedForMs)} min (${failures} failure(s)).`,
      );
      if (alerted) {
        return sendAlert(
          `Oracle: ${what} recovered`,
          `${what} is working again after ${minutes(failedForMs)} minutes.`,
        );
      }
      return undefined;
    },
  });
}

const cursorWriteOutage = absorbedFailureTracker({
  what: "Saving the chain cursor",
  consequence:
    "The oracle keeps answering prompts from memory, but if it restarts now it resumes from an old or missing cursor and prompts in between can be missed. Check the oracle_agent database.",
  alertAfterMs: 5 * 60 * 1000,
  site: "cursor_write_outage",
});

const retryQueueOutage = absorbedFailureTracker({
  what: "Reading the failed-job queue",
  consequence:
    "Prompts waiting for a retry are not being retried and will only be settled by the one-hour refund. Check the oracle_agent database.",
  alertAfterMs: 10 * 60 * 1000,
  site: "retry_queue_outage",
});

/**
 * Holds event processing and retries while this oracle does not hold the oracle role: every
 * submission would revert, so answering would spend model and storage credits for nothing. One
 * page when the role is found missing, a reminder each hour it stays missing, one notice when it
 * is back (see oracleRoleGate.js).
 *
 * ORACLE_ROLE_RECHECK_MS shortens the 30 s recheck for tests; it is not a deployment setting.
 */
const oracleRole = createRoleGate({
  checkRole: () => contract.isOracle(signer.address),
  recheckMs: () => Number(process.env.ORACLE_ROLE_RECHECK_MS),
  onLost: (error) => {
    // On EVM the owner grants the role. On Sapphire the ROFL app registers itself, at start-up.
    const remedy = isSapphire
      ? "Restart the oracle so it registers itself again."
      : `The contract owner must call addOracle(${signer.address}).`;
    const message = `Oracle ${signer.address} does not hold the oracle role on ${contract.target}. It has stopped answering and is waiting; prompts stay queued and are answered once it holds the role, or refunded after the refund timeout. ${remedy}${error ? ` Last error: ${describeError(error)}` : ""}`;
    console.error(`[OracleRole] ${message}`);
    return sendAlert("CRITICAL: Oracle Not Authorized", message);
  },
  onStillLost: ({ waitingForMs }) => {
    const message = `Oracle ${signer.address} has been waiting ${minutes(waitingForMs)} minutes for the oracle role on ${contract.target} and is answering nothing.`;
    console.error(`[OracleRole] ${message}`);
    return sendAlert("CRITICAL: Oracle Still Not Authorized", message);
  },
  onRestored: () => {
    console.log(`[OracleRole] Oracle address is authorized again: ${signer.address}`);
    return sendAlert(
      "Oracle is authorized again",
      `Oracle ${signer.address} holds the oracle role again and has resumed answering.`,
    );
  },
});

const pollLoopOutage = absorbedFailureTracker({
  what: "The event polling loop",
  consequence:
    "The oracle is stuck on the same block range, so new prompts are not being answered. Check the RPC endpoint and the oracle_agent database.",
  alertAfterMs: 2 * 60 * 1000,
  site: "poll_loop_outage",
});

// A database outage would otherwise log the same line on every poll tick.
const CURSOR_WRITE_ERROR_LOG_INTERVAL_MS = 60 * 1000;
let lastCursorWriteErrorLoggedAt = 0;

/**
 * A cursor write that failed must NOT stop the oracle: the events of that block have already been
 * handled or queued, and throwing here would send the poll loop back over them. The cost of a
 * stale stored cursor is only paid on the next restart, as a longer catch-up scan — every
 * handler already tolerates meeting an event twice. Memory keeps the true value, so the
 * heartbeat stays right and the next successful write catches the store up. A failure that
 * lasts is alerted once (cursorWriteOutage): the heartbeat cannot show it.
 */
function reportCursorWriteFailure(error, block) {
  cursorWriteOutage.failure(error);

  const now = Date.now();
  if (now - lastCursorWriteErrorLoggedAt < CURSOR_WRITE_ERROR_LOG_INTERVAL_MS) return;
  lastCursorWriteErrorLoggedAt = now;
  console.error(
    `[OracleState] Could not store cursor ${block}; continuing with it in memory. Error: ${describeError(error)}`,
  );
  Sentry.captureException(error, { tags: { site: "cursor_write_failed", blockNumber: block } });
}

/** Move the cursor FORWARD. A lower block than the current one is ignored (never an error). */
async function persistCursor(blockNumber) {
  const n = toCursorBlock(blockNumber, "persistCursor");

  // Handlers finish out of order, so one can report an older block after the loop has moved on.
  if (lastProcessedBlockInMemory !== null && n < lastProcessedBlockInMemory) return;
  lastProcessedBlockInMemory = n;

  try {
    await stateStore.advanceCursor(n);
    cursorWriteOutage.success();
  } catch (error) {
    reportCursorWriteFailure(error, n);
  }
}

/** Move the cursor BACK. Only the reorg path may: the blocks it had passed no longer exist. */
async function rewindCursor(blockNumber) {
  const n = toCursorBlock(blockNumber, "rewindCursor");
  lastProcessedBlockInMemory = n;

  try {
    await stateStore.rewindCursor(n);
    cursorWriteOutage.success();
  } catch (error) {
    reportCursorWriteFailure(error, n);
  }
}

/**
 * How many failed jobs the oracle is carrying, for the heartbeat: waiting for a retry plus given
 * up on. Throws when the store cannot be read, and the vitals collector turns that into "unknown"
 * — "no failures" must never look the same as "cannot tell".
 *
 * @returns {Promise<number>}
 */
async function countFailedJobs(store = stateStore) {
  const { pending, exhausted } = await store.countFailedJobs();
  return pending + exhausted;
}
const AI_CONTEXT_MESSAGES_LIMIT = parseInt(process.env.AI_CONTEXT_MESSAGES_LIMIT) || 20;
const RETRY_INTERVAL_MS = 60 * 1000; // Check for failed jobs every 60 seconds
const RETRY_BATCH_LIMIT = 20; // Failed jobs taken per check
// How long a claimed job is held before another check (or another oracle) may take it. Longer
// than the slowest answer, so a retry still running is not started a second time.
const RETRY_LEASE_MS = 15 * 60 * 1000;
const MAX_RETRIES = 10;
const BASE_RETRY_DELAY_MS = 30 * 1000; // Start with a 30-second delay
const NETWORK_NAME = process.env.NETWORK_NAME;
const AI_AGENT_CONTRACT_ADDRESS = process.env.AI_AGENT_CONTRACT_ADDRESS;

// --- Mock Flags (for local E2E testing without external dependencies) ---
const { getHandles: getBrainHandles, isConfigured: isBrainConfigured } = require("./brainContext");
const { startOracleHeartbeat } = require("./oracleHeartbeat");
const { providerTally } = require("./providerTally");
const { classifyIntent, queryGeminiDirect } = require("./geminiDirect");
const { recordAnswerActivity } = require("./answerActivity");
const { sourcesFromState, stepFromThought } = require("./answerProvenance");
const { encryptSymmetrically } = require("./stream/frameCrypto");
const { noopSink, resolveReplicaId } = require("./stream/streamContract");
const {
  createAnswerStream,
  createOfflineStream,
  streamCounters,
  noteThoughtDropped,
  setThoughtDropListener,
} = require("./stream/answerStream");
const { sanitizeThought, warmThoughtSanitizer } = require("./stream/thoughtSanitizer");
const { createThoughtDropAlerter } = require("./stream/thoughtDropAlert");
const { createRunProvenance } = require("./runProvenance");
const {
  selectAnswer,
  toolFailureKind,
  unansweredToolFailure,
  UnansweredToolFailureError,
} = require("./answerSelection");
const { createToolServerWatch } = require("./elizaos/toolServerWatch");
const { MARKET_DATA_TOOLS } = require("./elizaos/marketDataTools");
const {
  cleanedLogCall,
  cleanRuntimeLogger,
  FRAMEWORK_LOG_LEVELS,
} = require("./elizaos/mutedFrameworkLogs");

const toolServerWatch = createToolServerWatch({
  expectedTools: MARKET_DATA_TOOLS,
  alert: sendAlert,
});
const { sanitizeAnswer } = require("./outboundSanitizer");
const { runServerLevelMigrations } = require("./agentSchemaMigrator");

const MOCK_AI = process.env.MOCK_AI === "true";
const USE_MOCK_STORAGE = process.env.USE_MOCK_STORAGE === "true";

// MOCK-mode only: an e2e prompt may embed "__E2E_DELAY_MS__:<n>" to make the mock AI
// hold its answer for <n> ms, so a test can exercise cancel/refund timing while the
// prompt is genuinely pending. Honoured ONLY inside queryAIModel's MOCK_AI branch, so
// it can never affect production (MOCK_AI is false there). Capped so a malformed value
// can't stall the oracle indefinitely.
const MOCK_DELAY_SENTINEL = /__E2E_DELAY_MS__:(\d+)/;
const MAX_MOCK_DELAY_MS = 30000;

// MOCK-mode only: an e2e prompt may embed "__E2E_DROP__" to make the oracle skip
// submitting the answer entirely, leaving the on-chain job GENUINELY pending. Required to
// deterministically exercise the refund path: the delay sentinel always eventually
// delivers (and is capped at 30s), which races processRefund. Honoured ONLY inside
// handlePrompt's MOCK_AI branch, so it can never affect production (MOCK_AI is false there).
const MOCK_DROP_SENTINEL = /__E2E_DROP__/;

// MOCK-mode only: an e2e prompt may embed "__E2E_REASONING__" to make the oracle attach
// deterministic reasoning + sources to the answer MessageFile. The dApp's reasoning/sources
// render path is built but production doesn't yet emit them (tracked in ClickUp 86d3cfa41), so
// this lets the e2e exercise that render path end-to-end now; when the real feature lands the
// test upgrades to assert real data. Honoured ONLY inside handlePrompt's MOCK_AI branch, so it
// can never affect production (MOCK_AI is false there). Shapes match createMessageFile +
// the dApp components: reasoning = {title, description}, sources = {title, url}.
const MOCK_REASONING_SENTINEL = /__E2E_REASONING__/;
const MOCK_E2E_REASONING = [
  {
    title: "Interpreting the request",
    description: "Identified the user's intent and the key entities to address.",
  },
  {
    title: "Synthesising the answer",
    description: "Combined the relevant on-chain and market context into a concise response.",
  },
];
const MOCK_E2E_SOURCES = [
  { title: "Tradable Documentation", url: "https://tradable.app/docs" },
  { title: "SenseAI Reference", url: "https://senseai.tradable.app" },
];
const MOCK_E2E_REASONING_DURATION = 3; // seconds — the dApp renders "Thought for {n} seconds"

// MOCK-mode only: "__E2E_STEP_MS__:<n>" spaces the reasoning sentinel's steps <n> ms apart on the
// live stream, so an e2e test can see steps arrive before the answer. Capped like the delay.
const MOCK_STEP_MS_SENTINEL = /__E2E_STEP_MS__:(\d+)/;
const MAX_MOCK_STEP_MS = 5000;

// MOCK-mode only: "__E2E_RERUN__" makes the first run of a prompt send its sources and one step,
// then end interrupted, and the handler run the prompt again in this process, once per answer:
// a real second run, opening with reset "retry", in seconds rather than the retry queue's minute.
const MOCK_RERUN_SENTINEL = /__E2E_RERUN__/;
const mockRerunsDone = new LRUCache({ max: 1000 });

/** Thrown by the first run of an "__E2E_RERUN__" prompt; caught in handlePrompt (mock only). */
class MockRerunError extends Error {}

// Nothing is built while this module loads. The keys arrive later (see oracleKeys.js), and
// `configure` builds the provider, the signer and the contract from them.
let provider;
let signer;
let contract;
let isSapphire;
// The key that opens each prompt's session key. Used through this, never read.
let decryptor;
let expectedChainId;
// The chain the oracle answers on, once known: set by `start` after it has checked it, or read
// from the provider the first time a conversation's scope is needed (tests, and a caller that has
// not started the oracle). Never changes while the process runs.
let deploymentChainId;
// The read of the chain under way, while there is one.
let chainIdRead;

/**
 * Gives the oracle its keys and builds what it talks to the chain with. Called once by
 * index.js, after the keys have been obtained and before `start`.
 *
 * @param {Awaited<ReturnType<typeof import("./oracleKeys").obtainOracleKeys>>} keys
 */
function configure(keys) {
  ({ provider, signer, contract, isSapphire } = initializeOracle(
    NETWORK_NAME,
    keys.signingKeyHex(),
    AI_AGENT_CONTRACT_ADDRESS,
  ));
  decryptor = keys.decryptor;
  // A malformed ORACLE_REPLICA_ID stops start-up here, not in the middle of an answer.
  replicaId = resolveReplicaId();
  // Keys made by the key service were made for one chain; `start` checks the RPC is on it.
  expectedChainId = keys.mode === "rofl" ? CHAIN_IDS[NETWORK_NAME] : undefined;

  console.log(`--- AI AGENT ORACLE STARTING ON: ${NETWORK_NAME.toUpperCase()} ---`);
  console.log(`Oracle signer address: ${signer.address}`);
  console.log(`Contract address: ${contract.target}`);
  console.log(
    `Operating in ${isSapphire ? "Sapphire (confidential)" : "Public EVM (encrypted)"} mode.`,
  );
}

/**
 * The oracle's keys were made for the chain its network name stands for. An RPC address that
 * points at another chain would have those keys answer, and sign, where they were never meant
 * to exist.
 */
function assertChainOfKeys(chainId) {
  if (expectedChainId !== undefined && BigInt(chainId) !== BigInt(expectedChainId)) {
    throw new Error(
      `The RPC for network "${NETWORK_NAME}" is on chain ${chainId}, not ${expectedChainId}; ` +
        `refusing to start`,
    );
  }
}

/** The decryptor, or a plain statement of why there is none. */
function requireDecryptor() {
  if (!decryptor) throw new Error("The oracle has not been given its keys");

  return decryptor;
}

// This function allows tests to inject mocked components.
function initForTest(testComponents) {
  provider = testComponents.provider;
  signer = testComponents.signer;
  contract = testComponents.contract;
  isSapphire = testComponents.isSapphire;
  if (testComponents.decryptor) decryptor = testComponents.decryptor;
  expectedChainId = testComponents.expectedChainId;
  deploymentChainId = testComponents.chainId;
  if (testComponents.stateStore) {
    stateStore = testComponents.stateStore;
    lastProcessedBlockInMemory = null;
    lastCursorWriteErrorLoggedAt = 0;
    cursorWriteOutage.reset();
    retryQueueOutage.reset();
    pollLoopOutage.reset();
    oracleRole.reset();
  }
}

// --- CONCURRENCY & MEMORY CONTROL ---

// Transaction Mutex: Ensures we NEVER send 2 transactions simultaneously (prevents Nonce errors)
// This implements the "Mutual Exclusion" pattern from the async-mutex docs.
const txMutex = new Mutex();

// Job Queue: Limits concurrency to 5.
// This implements the "Promise queue with concurrency control" pattern from p-queue docs.
const queue = new PQueue({ concurrency: 5 });

// The events whose handlers ask the model, and so use a conversation's room: the owner and the
// conversation are their first two arguments.
const ROOM_EVENTS = new Set(["PromptSubmitted", "RegenerationRequested"]);

// How long a conversation's room is kept taken after a run the framework has timed out, waiting
// for the framework's own processing of it to end before the room is emptied and the next prompt
// of the conversation is let in. A bound, so processing that never ends cannot hold the
// conversation for ever; past it the room is emptied anyway.
const LATE_RUN_WAIT_MS = 5 * 60 * 1000;

// The agent is used only once nothing an earlier process left is in its database (see
// elizaos/agentMemory.js). Tried at start, and again before a run until it has succeeded.
const agentMemoryReady = createAgentMemoryGate({
  report: (error) => Sentry.captureException(error, { tags: { site: "agent_memory_sweep" } }),
});

// We store the raw ENCRYPTED string (IV + Ciphertext).
// Average size ~1KB - 4KB.
// 100,000 items * 4KB = ~400MB of RAM.
// This fits comfortably within the 4GB TEE limit while keeping hot conversations in memory.
const rawMessageCache = new LRUCache({
  max: 100000,
  ttl: 1000 * 60 * 60 * 24, // 24 Hours (Renamed from maxAge)
});

let elizaOS = null;

// Provenance is correlated by RUN (roomId), not by closure: ElizaOS event handlers register
// on the SHARED runtime while prompts drain through a p-queue with concurrency 5, so an
// appending handler would interleave one user's thoughts into another's answer — and that
// answer is written to immutable, already-paid-for storage. Registered ONCE (see
// registerProvenanceHandlers): per-prompt registration would leak a handler per prompt and
// multiply the cross-talk.
const runProvenance = createRunProvenance();
// Keyed on the runtime INSTANCE rather than a "have we ever registered" boolean. A boolean
// outlives the object it describes: re-initialise the agents (a retried start(), a supervisor
// restart) and the new runtime carries no handlers, so every reasoning step silently degrades to
// "Step N" — permanent and invisible in a long-lived TEE process. Identity makes the guard mean
// what it says: this runtime is wired, any other one is not.
let provenanceHandlersRuntime = null;
let senseAiAgentId = null;

// --- LIVE REASONING STREAM ---
// Where frames go. The no-op sink until the stream server sets its own (setStreamSink); the
// frames, and the record built from them, are the same either way.
let streamSink = noopSink;
// This process's replica id (ORACLE_REPLICA_ID or random), settled in configure().
let replicaId = null;
// Answer ids this process has opened a run for: a second run of one is a "retry" reset.
const answersRun = new LRUCache({ max: 10000 });
// The most recent streams, so a test can wait for their queued frames. Weakly held and bounded, so
// it never keeps a finished run's frames alive; read by nothing else.
const RECENT_STREAMS_KEPT = 64;
const recentStreams = [];
// A dropped thought leaves an answer with less reasoning and nothing else to show for it: alert by
// kind, once and then at most hourly (stream/thoughtDropAlert.js). The heartbeat has the counts.
setThoughtDropListener(createThoughtDropAlerter({ alert: sendAlert }));

// The Postgres url the agent schema — and with it the oracle-state tables — was migrated on;
// null where the oracle runs without Postgres. Set by initializeEliza, read by start().
let agentStateDbUrl = null;

/**
 * Point ElizaOS `plugin-sql` at the oracle's OWN isolated Postgres database
 * (POSTGRES_AGENT_DATABASE, e.g. `oracle_agent`) — NOT PGLite (flaky) and NOT the
 * shared `senseai` Brain-cache DB. Both bodies derive the same agentId, so a
 * shared agent DB would collide with sense-ai-core's agent tables; a dedicated DB
 * on the same instance (same client cert) keeps the oracle's agent state isolated
 * + concurrency-safe. MUST run before `addAgents()` — plugin-sql reads POSTGRES_URL
 * at init.
 *
 * Postgres is REQUIRED; the PGLite fallback below is a dead end kept only so the failure
 * is legible. It never worked: the programmatic boot skips plugin-sql's server-level
 * migration and PgliteDatabaseAdapter.init() creates no schema, so the runtime died on
 * `relation "agents" does not exist` ~30s later with every service registration timing
 * out. ADR-0001 had already chosen managed Postgres and rejected PGLite as brittle.
 *
 * The enforcing guard is `validateConfig` in startupConfig.js, NOT this function. It has
 * to be: this runs inside `initializeEliza`, and the prompt path re-enters it behind the
 * ElizaOS→ChainGPT failover — so a throw here would be caught and silently downgrade
 * every answer to the fallback provider instead of stopping the process. A config error
 * has to be refused before anything can catch it.
 */
function wireAgentDbForPluginSql() {
  const agentDb = process.env.POSTGRES_AGENT_DATABASE;
  if (!agentDb || !agentDb.trim()) {
    // Except on the legacy path, which validateConfig deliberately allows: a POSTGRES_URL
    // naming the database directly. initializeEliza handles it a few lines below this call —
    // it migrates against that url and derives its expectDatabase guard from the url's own
    // path — and plugin-sql reads POSTGRES_URL from the env itself, so there is nothing to
    // wire here. Crying wolf on it was worse than saying nothing: the error claimed the
    // process "should have been stopped by validateConfig" about a configuration
    // validateConfig had just approved, and the legacy warning printed straight afterwards
    // contradicted it.
    if ((process.env.POSTGRES_URL || "").trim()) return null;
    // NOT a supported degradation, and the log must not read like one. validateConfig
    // refuses to start the process without this, so reaching here means the guard was
    // bypassed (a direct start() call, a test, a wrapper importing start()). PGLite
    // cannot serve the agent runtime — see the note above — so what follows will die
    // on `relation "agents" does not exist` about thirty seconds from now.
    console.error(
      "[ElizaOS] POSTGRES_AGENT_DATABASE unset — falling through to plugin-sql's PGLite " +
        "store, which CANNOT work (no server-level migration on this boot path). " +
        'Expect `relation "agents" does not exist`. This process should have been ' +
        "stopped by validateConfig; it was started without that guard.",
    );
    return null;
  }
  const { bootstrapPostgresFromEnv, isPostgresConfigured } = require("./postgresBootstrap");

  // A bare DB *name* isn't enough to mean "use Postgres" — the committed
  // .env.oracle.example carries the name with no credentials, so this is the shape
  // someone gets by copying the example and running it unedited.
  if (!isPostgresConfigured()) {
    console.error(
      `[ElizaOS] POSTGRES_AGENT_DATABASE is "${agentDb}" but the Postgres connection ` +
        "config is absent, so plugin-sql falls through to PGLite, which CANNOT work. " +
        "This process should have been stopped by validateConfig.",
    );
    return null;
  }

  // Deliberately NOT wrapped in a try/catch: Postgres is configured, so a bad
  // cert/host/password must fail the boot LOUDLY rather than silently degrade to
  // PGLite — which we retired for being corruption-prone, and which would quietly
  // discard all agent state on every restart while the oracle looked healthy. This
  // matches the fatal contract runServerLevelMigrations already has.
  // Still stamps POSTGRES_URL (plugin-sql reads that var) AND returns the url, so the
  // caller can pass it on explicitly rather than reading the global back out.
  const agentDbUrl = bootstrapPostgresFromEnv({ database: agentDb });
  console.log(`[ElizaOS] plugin-sql wired to isolated Postgres agent DB "${agentDb}".`);
  return agentDbUrl;
}

async function initializeEliza() {
  console.log("[ElizaOS] Initializing Orchestrator...");

  // Isolate plugin-sql's agent DB BEFORE the runtime initializes it (see fn doc).
  const agentDbUrl = wireAgentDbForPluginSql();

  // Create the ElizaOS core schema (agents, memories, …) on the (possibly fresh)
  // Postgres DB BEFORE the runtime's first query. The programmatic boot path skips
  // AgentServer's server-level migration, so without this `ensureAgentExists()`
  // fails with `relation "agents" does not exist` on a brand-new oracle_agent DB.
  // No-op on localnet/e2e (no Postgres → plugin-sql's PGLite fallback).
  // Take the url straight from the wiring rather than reading process.env back out —
  // the env round-trip only worked because the two calls are adjacent and synchronous.
  // Falls back to a directly-provided POSTGRES_URL so an operator who sets that var
  // WITHOUT POSTGRES_AGENT_DATABASE still gets their schema migrated (plugin-sql would
  // otherwise connect to an unmigrated DB and fail on `relation "agents"`).
  // Guard the invariant on BOTH paths. Leaving the fallback unguarded was backwards:
  // it is precisely the path where we did NOT choose the database, so if POSTGRES_URL
  // pointed at the shared `senseai` cache the ElizaOS schema would be created there —
  // the agent-table collision this whole change exists to prevent.
  let expectDatabase;
  if (agentDbUrl) {
    expectDatabase = process.env.POSTGRES_AGENT_DATABASE;
  } else if (process.env.POSTGRES_URL) {
    console.warn(
      "[ElizaOS] POSTGRES_AGENT_DATABASE is not set — migrating against POSTGRES_URL " +
        "directly (legacy path). Set POSTGRES_AGENT_DATABASE to get an isolated agent DB.",
    );
    // Recover the guard by deriving the expectation from the url we're about to use.
    // Narrower than the primary path — it proves the POOL honoured the url (catching a
    // plugin-sql singleton that ignored config.postgresUrl), not that the url names the
    // right database — but it closes the asymmetry at zero config cost.
    try {
      expectDatabase =
        decodeURIComponent(new URL(process.env.POSTGRES_URL).pathname.replace(/^\//, "")) ||
        undefined;
    } catch {
      // Unparseable url: leave the expectation unset rather than throwing here —
      // bootstrapPostgresFromEnv / plugin-sql will surface the real problem.
    }
  }

  await runServerLevelMigrations({
    postgresUrl: agentDbUrl ?? process.env.POSTGRES_URL,
    expectDatabase,
  });
  agentStateDbUrl = (agentDbUrl ?? process.env.POSTGRES_URL) || null;

  // Create the orchestrator
  elizaOS = new ElizaOS();

  // Some of the framework's lines are not printed, and every other one is cleaned first. See
  // mutedFrameworkLogs for which and why. The agent runtime's own logger is replaced the same
  // way once the runtime is built (below).
  for (const level of FRAMEWORK_LOG_LEVELS) {
    const original = elizaLogger[level];
    if (typeof original !== "function") continue;
    elizaLogger[level] = cleanedLogCall(original.bind(elizaLogger), level);
  }

  // Add and start the SenseAI Agent. The order around it (clean what is stored, name the
  // environment variables the framework may copy, add, start, clean again) is
  // startAgentWithCleanSettings', which also keeps the database address and the tool servers
  // out of the character the framework stores.
  try {
    console.log("[ElizaOS] Cleaning stored agent settings, then adding the SenseAI Agent...");
    await startAgentWithCleanSettings({
      postgresUrl: agentStateDbUrl,
      character: senseAiCharacter,
      env: {
        POSTGRES_URL: agentStateDbUrl ?? undefined,
        PGLITE_DATA_DIR: process.env.PGLITE_DATA_DIR,
      },
      alert: sendAlert,
      setAllowedEnvVars,
      addAgent: (agent) =>
        elizaOS.addAgents([
          {
            ...agent,
            plugins: [
              "@elizaos/plugin-sql", // Connect to multiple MCP servers and use their resources, prompts, and tools.
              "@elizaos/plugin-mcp",

              // Text-only plugins (no embedding support)
              ...(process.env.ANTHROPIC_API_KEY?.trim() ? ["@elizaos/plugin-anthropic"] : []),
              ...(process.env.OPENROUTER_API_KEY?.trim() ? ["@elizaos/plugin-openrouter"] : []),

              // Embedding-capable plugins (optional, based on available credentials)
              ...(process.env.OPENAI_API_KEY?.trim() ? ["@elizaos/plugin-openai"] : []),
              ...(process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim()
                ? ["@elizaos/plugin-google-genai"]
                : []),

              // We use the @elizaos/plugin-mcp to connect to Coingecko MCP server instead
              // ...(process.env.COINGECKO_API_KEY?.trim() &&
              // process.env.COINGECKO_PRO_API_KEY?.trim()
              //   ? ["@elizaos/plugin-coingecko"]
              //   : []),

              // Bootstrap plugin
              ...(!process.env.IGNORE_BOOTSTRAP ? ["@elizaos/plugin-bootstrap"] : []),

              senseaiPlugin,
            ],
          },
        ]),
      startAgents: async (agentIds) => {
        senseAiAgentId = agentIds[0];
        console.log("senseAiAgentId", senseAiAgentId);

        // The runtime's own logger, which warns with the start of the model's reply when it
        // cannot read it, is cleaned before the agent starts and prints anything. Throws when it
        // cannot be, and the agent is then not started.
        for (const agentId of agentIds) cleanRuntimeLogger(elizaOS.getAgent(agentId));

        // Start the agent lifecycle
        // The Brain's connection stays HERE, in the host: brainContext builds it with the mTLS
        // cert params Cloud SQL requires, wraps it in drizzle (the Brain's ctx.db is a
        // NodePgDatabase, not a raw Pool) and sets query timeouts. The plugin's BrainService is a
        // thin adapter over these handles — it cannot reuse bootstrapPostgresFromEnv without
        // dragging oracle/src into its bundle, and duplicating it silently dropped all three.
        if (typeof senseaiPluginModule.setBrainAccessor === "function") {
          senseaiPluginModule.setBrainAccessor(getBrainHandles);
        } else if (isBrainConfigured()) {
          // FATAL WHEN THE BRAIN IS CONFIGURED. A missing export is a broken/stale plugin build, not
          // a runtime blip — and because providers degrade so gracefully, the result is
          // indistinguishable from a Cloud SQL outage: mainnet answering without market context,
          // indefinitely, with one log line as the only signal. An operator who configured Cloud SQL
          // has stated the intent; failing to honour it must stop the process, not whisper.
          //
          // Thrown at STARTUP rather than per prompt on purpose. This runs inside initializeEliza,
          // so a broken build never serves traffic and the supervisor restarts with a clear cause,
          // instead of each prompt paying for a degraded answer. Per-prompt failure would be worse
          // than useless: queryElizaOS would fail over to another model, hiding the build error
          // behind a plausible answer.
          throw new Error(
            "setBrainAccessor missing from the plugin build, but the Brain IS configured — the " +
              "market-context path is inoperative. Rebuild plugin-senseai (bun run build) before starting.",
          );
        } else {
          // No Brain configured (localnet e2e has no Cloud SQL): absence is expected, so this is
          // information, not a fault. Gating on isBrainConfigured is what keeps the check precise —
          // refusing to boot here would break the environments the graceful degradation exists for.
          console.warn(
            "[ElizaOS] setBrainAccessor absent and no Brain configured — answering without market context.",
          );
        }

        await elizaOS.startAgents();
        console.log(`[ElizaOS] SenseAI Agent started with ID: ${senseAiAgentId}`);
      },
    });

    // Before any event is handled. A failure is printed and reported by the gate, and leaves the
    // agent unused: queryElizaOS asks again before each run, and fails over until it succeeds.
    await agentMemoryReady(elizaOS.getAgent(senseAiAgentId)).catch(() => {});

    // Watch the framework's tool service: say what it connected to, and alert if the market-data
    // tools are not there. Not waited for, and not a reason to stop. The service can take
    // minutes to start, and only some answers need its tools. `follow` never rejects.
    if (Object.keys(senseAiCharacter?.settings?.mcp?.servers ?? {}).length > 0) {
      void toolServerWatch.follow(elizaOS.getAgent(senseAiAgentId));
    }
  } catch (error) {
    // Only its kind: a database error carries the address it was connecting to.
    console.error(`[ElizaOS] FAILED to start SenseAI Agent (${errorKind(error)}).`);
    // Described, not as it is: this reaches the start-up's handler, which prints it whole.
    throw describedError(error);
  }
}

// --- Cryptography Helpers ---

/**
 * [EVM ONLY] Removes the '0x' prefix from a hex string.
 * @param {string} hexString - The hex string, which may or may not have a '0x' prefix.
 * @returns {string} The raw hex string without the '0x' prefix.
 */
function strip0xPrefix(hexString) {
  return hexString.startsWith("0x") ? hexString.slice(2) : hexString;
}

const GCM_IV_BYTES = 12;
const GCM_AUTH_TAG_BYTES = 16;

// `encryptSymmetrically` lives in stream/frameCrypto.js: the stored files and the live frames
// are sealed by the one function. It is still exported from this module.

/**
 * Symmetrically decrypts data encrypted with AES-256-GCM.
 * @param {string} encryptedString The "iv.authTag.encryptedData" string.
 * @param {Buffer} key The 32-byte symmetric key.
 * @returns {object} The decrypted and parsed JSON object.
 */
function decryptSymmetrically(encryptedString, key) {
  // Check for the correct two-part format.
  const parts = encryptedString.split(".");
  if (parts.length !== 2) {
    throw new BadInputError('Invalid encrypted data format. Expected "iv.encryptedData".');
  }

  const iv = Buffer.from(parts[0], "base64");
  const combinedBuffer = Buffer.from(parts[1], "base64");

  // The auth tag is the final 16 bytes of the combined buffer.
  // Length-checked before the decipher is built, because both fields are attacker-supplied and a
  // bad length throws out of createDecipheriv/setAuthTag rather than out of the guarded block
  // below. Checking here also keeps createDecipheriv's one remaining failure mode — a
  // wrong-length KEY, which is ours, not theirs — correctly fatal rather than silently dropped.
  if (iv.length !== GCM_IV_BYTES || combinedBuffer.length <= GCM_AUTH_TAG_BYTES) {
    throw new BadInputError("Invalid encrypted data: malformed IV or ciphertext length.");
  }

  const authTag = combinedBuffer.slice(-GCM_AUTH_TAG_BYTES);
  const encryptedData = combinedBuffer.slice(0, -GCM_AUTH_TAG_BYTES);

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  // Both remaining failures are things a user can produce at will: a forged auth tag throws in
  // final(), and bytes that authenticate correctly but are not JSON throw in the parse — they
  // hold their own session key, so they can seal anything. Left untyped, neither is bad input
  // nor retryable, so both land in the FATAL branch: Sentry, a Slack "CRITICAL: Oracle Fatal
  // Error", an answer_failed metric and a cursor that does not advance, one per malformed
  // prompt. That is the attacker-driven inflation the !isBadInputError gates exist to prevent.
  try {
    const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);

    return JSON.parse(decrypted.toString("utf-8"));
  } catch (error) {
    // Not everything in that block is the user's doing: Buffer.concat can fail to allocate, and
    // the crypto binding can raise its own errors. Typed as bad input, those would be dropped
    // permanently with no alert and no retry — our own outage, silently charged to the prompt.
    //
    // A forged tag cannot be identified positively: Node throws a bare Error with no `code`, and
    // matching its message is the classification this module abandoned. So discriminate the
    // other way — a RangeError is an allocation failure and a `code` marks a runtime error, both
    // ours to surface. What is left, the bare auth failure and SyntaxError, is the user's.
    if (error instanceof RangeError || error?.code) throw error;

    // Only the kind, and not the error itself as its cause: a parse error's message quotes the
    // start of the decrypted text, which is the user's.
    throw new BadInputError(`Could not decrypt payload (${errorKind(error)}).`);
  }
}

/**
 * Retrieves the session key for an operation. It first checks the event payload.
 * If the key is not present (e.g., for a scheduled job), it falls back to querying the
 * storage provider for a deterministically tagged "Key File" associated with the conversation/job.
 * @param {string} payload - The raw payload from the event.
 * @param {string} roflEncryptedKey - The encrypted key from the event payload.
 * @param {string} conversationId - The conversation ID, used for the fallback query.
 * @returns {Promise<Buffer>} The 32-byte symmetric session key.
 */
async function getSessionKey(payload, roflEncryptedKey, conversationId) {
  console.log(`[Crypto] Resolving session key for conversation: ${conversationId}...`);
  if (isSapphire) {
    // One of two parses whose failure genuinely means "the caller sent us rubbish" — the other
    // is in decryptSymmetrically. Typed here so the drop decision is made about THIS parse,
    // rather than by pattern-matching every SyntaxError in the process — which is how a
    // gateway's HTML error page used to get a prompt discarded.
    let parsedPayload;
    try {
      parsedPayload = JSON.parse(payload);
    } catch (error) {
      // Only the kind: the parse error's message quotes the start of the payload.
      throw new BadInputError(`Event payload is not valid JSON (${errorKind(error)}).`);
    }
    if (parsedPayload.sessionKey) {
      return Buffer.from(strip0xPrefix(parsedPayload.sessionKey), "hex");
    }
  } else if (roflEncryptedKey && roflEncryptedKey !== "0x") {
    const cipherBlob = Buffer.from(strip0xPrefix(roflEncryptedKey), "hex");
    return await requireDecryptor().decrypt(cipherBlob);
  }

  if (conversationId) {
    console.log(
      `[Crypto] Key not in payload for convId ${conversationId}, querying storage for fallback...`,
    );
    const { chainId } = await provider.getNetwork();
    const keyFileCID = await queryTransactionByTags([
      { name: "Content-Type", value: "application/rofl-key" },
      { name: "SenseAI-Key-For-Conversation", value: `${chainId}-${conversationId}` },
    ]);
    if (!keyFileCID) {
      throw new Error(`Could not find Key File for conversation ${conversationId}.`);
    }
    const fetchedHex = await fetchData(keyFileCID);
    return await requireDecryptor().decrypt(Buffer.from(fetchedHex, "hex"));
  }

  throw new Error(
    "Could not determine session key: Not in payload and no conversationId provided for fallback.",
  );
}

// --- Storage & History Helpers ---

// Takes an encrypted string (from cache or new upload), decrypts it, and returns object
function decryptMessageFile(encryptedString, sessionKey) {
  return decryptSymmetrically(encryptedString, sessionKey);
}

/**
 * Walks backwards up the message chain on decentralised storage to reconstruct conversation history.
 * @param {string} startMessageCID The CID of the latest message in the thread.
 * @param {string | null} sessionKey The key for decryption (EVM only).
 * @returns {Promise<Array<object>>} An array of message objects for the AI context.
 */
async function reconstructHistory(startMessageCID, sessionKey) {
  if (!startMessageCID) {
    console.log("[History] No start message CID provided. History is empty.");
    return [];
  }

  // Limit history fetching to avoid infinite loops and excessive costs.
  const history = [];
  let currentCid = startMessageCID;
  let cacheHits = 0;
  let networkFetches = 0;
  console.log(`[History] Starting reconstruction from CID: ${startMessageCID}`);

  // Limit history fetching to avoid infinite loops and excessive costs.
  for (let i = 0; i < AI_CONTEXT_MESSAGES_LIMIT; i += 1) {
    if (!currentCid) {
      break;
    }

    let encryptedString;

    // 1. Check Cache (Hit = 0ms latency)
    if (rawMessageCache.has(currentCid)) {
      encryptedString = rawMessageCache.get(currentCid);
      cacheHits += 1;
      // console.log(`[Cache] Hit for CID: ${currentCid.slice(0, 8)}...`);
    } else {
      // 2. Fetch from Network (Miss = ~500ms+ latency)
      // console.log(`[Cache] Miss for CID: ${currentCid.slice(0, 8)}...`);
      try {
        encryptedString = await fetchData(currentCid);
        // 3. Populate Cache for next time
        rawMessageCache.set(currentCid, encryptedString);
        networkFetches += 1;
      } catch (error) {
        console.error(
          `[History] Failed to fetch CID ${currentCid} from storage.`,
          describedError(error),
        );
        break;
      }
    }

    // 4. Decrypt (Fast CPU op)
    try {
      const messageFile = decryptMessageFile(encryptedString, sessionKey);

      history.unshift({
        role: messageFile.role,
        content: messageFile.content,
      });

      // The parentCID of a MessageFile is the CID of the parent message (whether promptMessageCID or answerMessageCID).
      currentCid = messageFile.parentCID;
    } catch (error) {
      // Only the kind: a failed parse quotes the start of the decrypted message.
      console.error(
        `[History] Failed to reconstruct history at CID ${currentCid} (${errorKind(error)}). Stopping history build.`,
      );

      break;
    }
  }

  console.log(
    `[History] Reconstructed ${history.length} messages. Cache Hits: ${cacheHits}, Network Fetches: ${networkFetches}`,
  );

  return history;
}

// --- AI Model Query Functions ---

/**
 * The name of a conversation outside the oracle: its room in the agent framework, and its history
 * at ChainGPT. Made from the chain, the agent contract, the conversation id and the wallet that
 * owns the conversation (the contract only takes a conversation's prompts from its owner), so no
 * two deployments and no two owners share one. The chain is read from the provider at most once.
 *
 * @param {string} conversationId
 * @param {string} owner
 * @returns {Promise<string>}
 */
async function conversationScopeOf(conversationId, owner) {
  if (deploymentChainId === undefined) {
    // One read for every prompt that arrives before it answers; a read that failed is made again.
    chainIdRead ??= provider.getNetwork().finally(() => {
      chainIdRead = undefined;
    });
    ({ chainId: deploymentChainId } = await chainIdRead);
  }

  return conversationScopeKey({
    chainId: deploymentChainId,
    agentAddress: contract?.target,
    conversationId,
    owner,
  });
}

/**
 * Query the ChainGPT API for a response.
 * @param {Array<object>} conversationHistory - The full, ordered history of the conversation.
 * @param {string} conversationId - The unique on-chain ID for this conversation.
 * @param {string} userWallet - The wallet that owns the conversation.
 * @returns {Promise<string>} The content of the AI's response.
 */
async function queryChainGPT(conversationHistory, conversationId, userWallet) {
  console.log(`[ChainGPT] Querying ChainGPT for convId: ${conversationId}`);
  if (!process.env.CHAIN_GPT_API_KEY) {
    throw new Error("CHAIN_GPT_API_KEY is not set in the environment file.");
  }

  const userPrompts = conversationHistory.filter((item) => item.role === "user");
  if (userPrompts.length === 0) {
    throw new Error("Cannot query with an empty prompt list.");
  }

  const question = userPrompts[userPrompts.length - 1].content;

  // ChainGPT keeps the earlier turns under this id (`chatHistory: "on"`), so it is named for the
  // deployment, the conversation and its owner, as the agent framework's room is.
  const conversationUUID = uuidv5(
    await conversationScopeOf(conversationId.toString(), userWallet),
    NAMESPACE_UUID,
  );

  const res = await fetch("https://api.chaingpt.org/chat/stream", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.CHAIN_GPT_API_KEY}`,
    },
    body: JSON.stringify({
      model: "general_assistant",
      question,
      chatHistory: "on",
      sdkUniqueId: conversationUUID,
      aiTone: "PRE_SET_TONE",
      selectedTone: "FRIENDLY",
    }),
  });

  if (!res.ok) throw new Error(`ChainGPT API responded with status: ${res.status}`);
  const answerText = (await res.text()).trim();
  console.log(`[ChainGPT] Response received (${answerText.length} chars)`);

  return answerText || "Error: Malformed response from ChainGPT.";
}

/**
 * Query the first-party Tradable Assistant backend for a response. * Uses the Genkit onCall protocol with a custom header for service-to-service auth.
 * @param {Array<object>} conversationHistory - The full, ordered history of the conversation. * @param {string} userWallet - The user's wallet address.
 * @returns {Promise<string>} The content of the AI's response.
 */
async function queryTradableAssistant(conversationHistory, userWallet) {
  const TRADABLE_API_URL = process.env.TRADABLE_ASSISTANT_URL;
  const TRADABLE_API_ACCESS_TOKEN = process.env.TRADABLE_API_ACCESS_TOKEN;

  if (!TRADABLE_API_URL) {
    throw new Error("TRADABLE_ASSISTANT_URL not set.");
  }

  if (!TRADABLE_API_ACCESS_TOKEN) {
    throw new Error("TRADABLE_API_ACCESS_TOKEN not set for Oracle.");
  }
  console.log("[Routing] Path (ii): Querying Tradable 1st Party Backend...");

  // 1. Map History to Genkit Schema
  // Eliza: { role: 'assistant' } -> Genkit: { role: 'model' }
  const pastMessages = conversationHistory.slice(0, -1).map((msg) => ({
    role: msg.role === "assistant" ? "model" : "user",
    content: { text: msg.content },
  }));

  const currentPrompt = conversationHistory[conversationHistory.length - 1].content;

  // 2. Construct Payload (Firebase Callable Format)
  // Callable functions expect a root "data" key.
  const payload = {
    data: {
      text: currentPrompt,
      clientId: userWallet,
      messages: pastMessages,
      // Pass secret in body to satisfy input.apiAccess check
      apiAccess: TRADABLE_API_ACCESS_TOKEN,
    },
  };

  try {
    const response = await fetch(TRADABLE_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      // Try to read the error message from the body
      let errorMsg = response.statusText;
      try {
        const errBody = await response.json();

        if (errBody?.error?.message) {
          errorMsg = errBody.error.message;
        }
      } catch (e) {} // Ignore json parse errors on error response

      throw new Error(`Tradable Assistant error (${response.status}): ${errorMsg}`);
    }

    const json = await response.json();

    // Firebase Callable returns result in { result: ... }
    const answer = json.result;

    if (!answer) {
      throw new Error("Tradable Assistant returned empty response (no 'result' field).");
    }

    console.log(`[Routing] Tradable Response received (${answer.length} chars)`);
    return answer;
  } catch (error) {
    console.error("[Routing] Error querying Tradable Assistant:", describedError(error));
    throw error; // Propagate error so queryWithFailover can handle fallback
  }
}

/**
 * Subscribes the provenance collector to the runtime's action lifecycle — ONCE.
 *
 * ACTION_STARTED says which action is running; onResponse delivers the thought without that
 * attribution. Pairing them is what turns "Step 1" into the action that actually ran.
 *
 * Registered once rather than per prompt on purpose: handlers live on the shared runtime, so
 * one registered per call would leak a handler per prompt and multiply the cross-talk the
 * run-correlation exists to prevent. Guarded rather than assumed, because queryElizaOS is
 * entered once per prompt.
 */
function registerProvenanceHandlers(runtime) {
  if (provenanceHandlersRuntime === runtime) return;
  if (typeof runtime.registerEvent !== "function") return;

  // Marked BEFORE registering, not after: if the first registerEvent succeeds and the second
  // throws, a retry on the next prompt would add a SECOND ACTION_STARTED handler to a
  // long-lived runtime, and keep doing so every prompt. One attempt per runtime, then leave it
  // alone — a replaced runtime is a different identity and gets its own single attempt.
  provenanceHandlersRuntime = runtime;

  const nameOf = (payload) =>
    payload?.actionName ?? payload?.action ?? payload?.content?.action ?? "";

  try {
    // ORDER IS LOAD-BEARING: the CLEARING handler is registered first.
    //
    // Partial registration is the one case where the obvious designs trade off. Stamping the
    // guard before registering means a half-wired runtime never retries — but if ACTION_STARTED
    // landed and ACTION_COMPLETED did not, `currentAction` is set with nothing able to clear it,
    // so every later thought inherits a finished action, permanently, in paid-for storage.
    // Stamping after instead re-registers ACTION_STARTED on every prompt, growing handlers
    // without bound on a long-lived TEE runtime.
    //
    // Registering ACTION_COMPLETED first makes every partial state safe and removes the trade:
    // if it throws, ACTION_STARTED is never reached, so nothing can set a label in the first
    // place. Attribution degrades to "Step N" — the honest degradation — with no retry and no
    // leak. Covered by "attributes nothing rather than wrongly when only half the handlers
    // register".
    runtime.registerEvent(EventType.ACTION_COMPLETED, async (payload) => {
      runProvenance.actionCompleted(payload?.roomId, nameOf(payload));
    });
    runtime.registerEvent(EventType.ACTION_STARTED, async (payload) => {
      runProvenance.actionStarted(payload?.roomId, nameOf(payload));
    });
  } catch (err) {
    // Attribution is a nicety; never let it cost an answer.
    console.error(`[ElizaOS] Could not subscribe provenance handlers: ${describeError(err)}`);
  }
}

/**
 * Query the ElizaOS third-party service with structured I/O.
 * Uses the internal ElizaOS runtime initialized in the TEE.
 *
 * The run happens in the conversation's own room (see elizaos/conversationRoom.js): named for
 * the deployment, the conversation and its owner, emptied before the history is written into it
 * and again when the run ends, whichever way it ends, and used by one run at a time.
 *
 * @param {Array<object>} conversationHistory - The full, ordered history of the conversation.
 * @param {string} conversationId - The on-chain conversation ID.
 * @param {string} userWallet - The wallet that owns the conversation.
 * @returns {Promise<string>} The content of the AI's response.
 */
async function queryElizaOS(conversationHistory, conversationId, userWallet, liveStream) {
  // The answer's live stream (see stream/answerStream.js); an offline one for a caller with none.
  const stream = liveStream ?? createOfflineStream();
  console.log("[Routing] Path (i): Initializing ElizaOS structured I/O loop...");

  if (!elizaOS) await initializeEliza();

  const runtime = elizaOS.getAgent(senseAiAgentId);
  if (!runtime) throw new Error("Eliza Agent Runtime not found");

  // Throws until the agent database holds nothing an earlier process left; the next tier answers.
  await agentMemoryReady(runtime);

  const room = await conversationRoomOf(conversationId, userWallet);

  return withRoomLock(room.roomId, async (hold) => {
    // A clear that fails is printed by clearConversationRoom and costs the answer nothing.
    await clearConversationRoom(runtime, room, "before the run");
    try {
      return await runInRoom(runtime, room, conversationHistory, conversationId, userWallet, stream);
    } finally {
      // A run the framework has timed out goes on writing into the room. The answer (here, the
      // timeout) goes back now so the next tier can answer, while the room stays taken until that
      // processing ends, or for LATE_RUN_WAIT_MS at most, and is emptied then.
      const lingering = runStillGoing(runtime, room.roomId);
      if (lingering) {
        hold(
          settledWithin(lingering, LATE_RUN_WAIT_MS).then(() =>
            clearConversationRoom(runtime, room, "after the run"),
          ),
        );
      } else {
        await clearConversationRoom(runtime, room, "after the run");
      }
    }
  });
}

/**
 * A conversation's room in the agent framework, and the owner's entity in it: both named from the
 * conversation's scope (conversationScopeOf), so neither is shared with another conversation or
 * another owner.
 *
 * @returns {Promise<{ roomId: string, entityId: string }>}
 */
async function conversationRoomOf(conversationId, owner) {
  const scope = await conversationScopeOf(conversationId, owner);
  return { roomId: stringToUuid(scope), entityId: stringToUuid(`${scope}:owner`) };
}

/** One ElizaOS run in a room that queryElizaOS has emptied and holds. */
async function runInRoom(
  runtime,
  { roomId, entityId },
  conversationHistory,
  conversationId,
  userWallet,
  stream,
) {
  const agentEntityId = runtime.agentId;
  const worldId = stringToUuid("onchain-world");
  console.log(
    `[ElizaOS] Context isolation: WorldID: ${worldId}, RoomID: ${roomId}, EntityID: ${entityId}`,
  );

  // We ensure the user and room exist in Eliza's DB (Hydrate basic entities)
  await runtime.ensureConnection({
    entityId,
    roomId,
    userName: userWallet, // Wallet as username
    name: "User",
    source: "onchain",
    channelId: conversationId,
    type: ChannelType.DM,
    worldId,
  });

  // --- STATE HYDRATION ---
  // The last item in conversationHistory is the *new* prompt we want to process.
  // The items before that are context we need to hydrate.
  const pastContext = conversationHistory.slice(0, -1);
  const currentMessage = conversationHistory[conversationHistory.length - 1];
  console.log(`[ElizaOS] Hydrating ${pastContext.length} historical messages into PGLite...`);

  // We loop through the historical context reconstructed from Autonomys and insert it into PGLite.
  // This gives the stateless/ephemeral TEE the necessary context for RAG/Conversation.
  for (const msg of pastContext) {
    // A deterministic ID for the historical message from its room, content and timestamp, so a
    // message repeated in the history is written once. The room is part of it because memory ids
    // are unique across the whole database: without it, the same message in another room would
    // be found there and left out of this one.
    const msgHash = crypto
      .createHash("sha256")
      .update(`${roomId}\n${msg.content}${msg.createdAt}`)
      .digest("hex");
    const memoryId = stringToUuid(msgHash);

    // Check if memory exists to avoid overwriting (optional optimization)
    const existing = await runtime.getMemoryById(memoryId);
    if (!existing) {
      await runtime.createMemory(
        {
          id: memoryId,
          entityId: msg.role === "user" ? entityId : runtime.agentId,
          agentId: runtime.agentId,
          roomId,
          worldId,
          content: {
            text: msg.content,
            source: "onchain",
            channelType: ChannelType.DM,
          },
          metadata: {
            type: "message",
          },
          createdAt: msg.createdAt || Date.now(),
        },
        "messages",
      );
    }
  }

  // --- PROCESS NEW MESSAGE ---
  console.log("[ElizaOS] Processing new message via runtime handleMessage logic...");

  // CU-86d3ud1va: market context now reaches the model through the MACRO_SENTIMENT and
  // MARKET_INTELLIGENCE providers — ElizaOS's own composition seam — rather than being
  // concatenated onto the user's prompt by hand. Composing them here as well, scoped with
  // onlyInclude, is what yields the provenance: StateData.providers is ElizaOS's provider-results
  // cache, so `sources` describes what the run actually composed instead of a list fetched
  // alongside it. handleMessage returns no state, which is why this is read explicitly.
  //
  // Never fails the answer: an unconfigured Brain (localnet e2e has no Cloud SQL) or a DB blip
  // costs the context, not the response.
  //
  // THIS PRE-CALL IS A DELIBERATE SECOND READ — do not "optimise" it away. Verified against
  // @elizaos/core 1.7.2 (dist/node/index.node.js):
  //
  //   • bootstrap's messageReceivedHandler composes with onlyInclude=TRUE over
  //     ["ANXIETY","ENTITIES","CHARACTER","RECENT_MESSAGES","ACTIONS"] — our two providers do NOT
  //     run there;
  //   • runSingleShotCore then calls `composeState(message, ["ACTIONS"])` with onlyInclude
  //     OMITTED (→ false), which runs every non-private, non-dynamic provider. THAT is where the
  //     market context actually reaches the answer prompt;
  //   • so each provider runs once inside handleMessage, plus once here = two warm-cache reads.
  //     (Three if the model requests providers back: messageReceivedHandler re-composes again.)
  //
  // The message built below carries no `id`, and composeState only writes its cache
  // `if (message.id)` — so this pre-call neither pollutes nor is reused by handleMessage's state.
  // That independence is the cost: MARKET_INTELLIGENCE_INJECTED dedups within a composition, not
  // across two, and MACRO_SENTIMENT has no dedup at all.
  //
  // Paid for knowingly. Provenance must describe what was composed even when handleMessage throws
  // before returning, and sources-before-inference is the ordering the future dApp stream wants.
  // Collapsing the reads belongs in a short-TTL memo inside BrainService, not in deleting this.
  registerProvenanceHandlers(runtime);

  let composedSources = [];
  try {
    const composed = await runtime.composeState(
      { entityId, roomId, content: { text: currentMessage.content, source: "onchain" } },
      ["MACRO_SENTIMENT", "MARKET_INTELLIGENCE"],
      true,
    );
    composedSources = sourcesFromState(composed);
  } catch (err) {
    console.error(
      `[ElizaOS] Context composition failed, answering without it: ${describeError(err)}`,
    );
  }

  // Handle, not roomId: two prompts for the SAME conversation can be in flight together
  // under the p-queue, and a room-keyed run would let the second clobber the first.
  const runId = runProvenance.begin(roomId);
  // Sources before inference, so before this attempt's first step (see answerStream).
  stream.sources(composedSources);
  const reasoningStart = Date.now();

  // We use handleMessage which runs the full processing pipeline:
  // Context -> Action Selection -> Evaluation -> Response
  return new Promise(async (resolve, reject) => {
    // EVERY emission is kept WITH ITS ATTRIBUTION, and the answer is chosen at the end — see
    // answerSelection.
    // Assigning on each onResponse meant the last emission won, so a CALL_MCP_TOOL
    // payload became the user's answer (base-testnet stored a TypeScript snippet; an
    // earlier run stored an apology). Callback ordering must not decide what a user is
    // charged for.
    const emittedTexts = [];
    // False once the run has ended by any exit; a thought after that is not a step of it.
    let runOpen = true;

    try {
      await elizaOS.handleMessage(
        senseAiAgentId,
        {
          entityId,
          roomId,
          // The room's own world. Given none, the framework makes a world for every room it sees,
          // named after the room, and that world would stay in the database.
          worldId,
          content: {
            // ONLY the user's prompt. Market context arrives via providers during
            // composition — hand-building it here bypassed the framework and made the two
            // bodies structurally different.
            text: currentMessage.content,
            source: "onchain",
          },
        },
        {
          // This triggers every time the agent generates a message (even intermediate ones)
          onResponse: async (content) => {
            // Optional-chained deliberately. An emission with no text is normal (an action can
            // report a thought and nothing else), and an unguarded .substring() would throw
            // TypeError inside this async callback — before the push below, and before
            // onComplete. On a prompt already paid for on-chain that either drops the emission
            // or strands the promise entirely, depending on how ElizaOS handles a throwing
            // onResponse. The guard on the push made this inconsistency visible.
            //
            // Its length and not its opening: this log is read outside the TEE, and the first
            // words of an emission are the first words of an answer.
            console.log(
              `[ElizaOS] Intermediate response received: ${content.text?.length ?? 0} characters`,
            );

            // If the agent provides 'thought' metadata, add it to reasoning
            // Correlated by this run's HANDLE, not by roomId: roomId is stable per
            // conversation, so two prompts in one conversation would collide under it. The
            // action in flight (from ACTION_STARTED) titles the step; see runProvenance.
            // The MCP plugin's reply to a failed tool step is an apology tagged REPLY; its
            // thought is what marks it. That thought is the plugin's account of its own fault,
            // with the error's text in it, and is not a step of the answer: it stays out of the
            // reasoning, which is stored with the answer for good.
            const failureKind = toolFailureKind(content.thought);
            if (content.thought && !failureKind) {
              // Sanitised ONCE, before it is either streamed or stored. The stream starts the
              // work now and applies it in the order thoughts arrived. The action in flight NOW
              // titles it: by the time it is applied, ACTION_COMPLETED may have cleared it. The
              // step is made from the thought itself, not from the run's record, so it is kept
              // however late its sanitising finishes, as long as the stream is still taking
              // steps; an untitled one is numbered when it is applied. A dropped thought is
              // neither streamed nor stored, and is counted. See stream/thoughtSanitizer.js.
              const thought = content.thought;
              if (!runOpen) {
                // The run has ended: its steps were the steps of an attempt now over, and
                // another provider may be answering under the next attempt.
                noteThoughtDropped("late");
              } else {
                const action = runProvenance.currentActionOf(runId);
                stream.step(async () => {
                  const clean = await sanitizeThought(thought);
                  if (!clean) return null;
                  const entry = action ? { thought: clean, action } : { thought: clean };
                  return (index) => stepFromThought(entry, index);
                });
              }
            }

            // Keep the ATTRIBUTION, not just the text. Every emitter tags its callback with the
            // action that produced it, and discarding that tag left "last substantive" as the
            // only selection rule — which picks a third-party action's prose over our own
            // synthesis whenever the model happens to order it last. See answerSelection.
            if (typeof content.text === "string") {
              emittedTexts.push({
                text: content.text,
                actions: Array.isArray(content.actions) ? content.actions : [],
                // See unansweredToolFailure.
                toolFailed: failureKind ?? false,
              });
            }
          },
          // Triggered if the internal pipeline crashes
          onError: async (error) => {
            runOpen = false;
            console.error("[ElizaOS] Runtime Error during handleMessage:", describedError(error));
            // The steps already given are kept, under this attempt: the stream applies them
            // before the next tier's attempt frame. Nothing waits for them here; the handler's
            // flush before it reads the record does.
            runProvenance.finish(runId); // release the run; a rejected answer still frees it
            reject(error);
          },
          // CRITICAL: This is our signal that the tool-use/thought chain is finished
          onComplete: async () => {
            runOpen = false;
            console.log("[ElizaOS] Processing complete signal received.");
            // WHY THIS WHOLE BODY IS WRAPPED. `onComplete` is an async callback whose promise
            // nothing awaits — the `new Promise(async (resolve, reject) => …)` executor does not
            // chain onto it, and neither does ElizaOS. So a throw in here does not reject the
            // outer promise; it escapes as an unhandled rejection and leaves the promise pending
            // FOREVER, holding its p-queue slot (concurrency 5) against a prompt that has already
            // been paid for.
            //
            // Nothing on this path throws today — `sanitizeAnswer` catches everything and
            // `selectAnswer` is total. The wrap is here because the body became async in this
            // change, which is what made the hazard reachable at all: `onError` and the outer
            // catch already release the run, and this exit was the only one that could not.
            try {
              // The steps of this run are not waited for here: they are made from the thoughts
              // themselves, so the handler's one bounded flush before it reads the stream's
              // record (handlePrompt, handleRegeneration) is what keeps a late one.
              //
              // A tool step failed and nothing answered without it: what is left is an apology
              // and an acknowledgement, and storing either would charge the user for it.
              // Rejecting hands the prompt to another provider. See queryAIModel for which.
              const unanswered = unansweredToolFailure(emittedTexts);
              if (unanswered) {
                runProvenance.finish(runId);
                toolServerWatch.countRejectedRun(unanswered);
                reject(new UnansweredToolFailureError(unanswered));
                return;
              }

              // Two passes, deliberately separate. selectAnswer decides WHICH emission is the
              // answer; sanitizeAnswer decides what that text may contain. Only our own synthesis
              // reaches `generateSanitized` inside handleChainSynthesis — a third-party emission or
              // the acknowledgement never does, and this is the last point before the text is
              // encrypted into an immutable MessageFile. See outboundSanitizer.js.
              const finalResponseText = await sanitizeAnswer(selectAnswer(emittedTexts));
              if (finalResponseText) {
                // What is stored comes from the stream's record, never from here: the sources and
                // steps went to the stream as they were known, so `reasoning` and `sources` are
                // empty, as on every other tier (asAnswer).
                runProvenance.finish(runId);
                resolve({
                  text: finalResponseText.trim(),
                  reasoning: [],
                  sources: [],
                  reasoningDuration: Math.max(1, Math.round((Date.now() - reasoningStart) / 1000)),
                });
              } else {
                runProvenance.finish(runId);
                reject(new Error("ElizaOS completed but generated no text."));
              }
            } catch (error) {
              // `finish` is IDEMPOTENT, so a double-call is safe when the success branch already
              // called it and then threw: `runProvenance.finish` returns
              // `{ reasoning: [], sources: [] }` for an unknown runId and `forget` no-ops on a
              // missing entry. Pinned by "finish is idempotent" in runProvenance.test.js rather
              // than left as a claim here — the guarantee is what makes this catch correct, so
              // it has to fail loudly if it ever stops holding.
              runProvenance.finish(runId);
              reject(error);
            }
          },
        },
      );
    } catch (err) {
      // handleMessage can throw SYNCHRONOUSLY, before onError ever runs — the two other exits
      // release the run, and this one silently did not, stranding it until cap eviction weeks
      // later inside a long-lived TEE process. Caught in review; a stub that throws now covers it.
      runOpen = false;
      runProvenance.finish(runId);
      reject(err);
    }
  });
}

/**
 * Parses the optional "__E2E_DELAY_MS__:<n>" marker from a prompt (mock-mode only).
 * @dev The marker is read from the LATEST user message of the reconstructed history. For
 *      handlePrompt that's the original prompt text. For handleRegeneration with non-empty
 *      `instructions`, the latest user message is the injected "Please regenerate your
 *      previous response. Make it ${instructions}." — so an e2e regeneration test must embed
 *      the sentinel in `instructions`, not the original prompt. (Empty instructions fall back
 *      to the original prompt, where the sentinel does fire.)
 * @param {string} text - The latest user message content.
 * @returns {number} The requested delay in ms (capped at MAX_MOCK_DELAY_MS), or 0.
 */
function parseMockDelayMs(text) {
  if (typeof text !== "string") return 0;
  const match = text.match(MOCK_DELAY_SENTINEL);
  if (!match) return 0;
  return Math.min(Number(match[1]), MAX_MOCK_DELAY_MS);
}

/**
 * Detects the optional "__E2E_DROP__" marker (mock-mode only). When present, handlePrompt
 * returns early WITHOUT submitting an answer, so the on-chain job stays unfinalized and the
 * prompt is genuinely pending — required to deterministically exercise the refund flow.
 * @param {string} text - The prompt text.
 * @returns {boolean} True if the drop sentinel is present.
 */
function hasMockDropSentinel(text) {
  if (typeof text !== "string") return false;
  return MOCK_DROP_SENTINEL.test(text);
}

/**
 * Detects the optional "__E2E_REASONING__" marker (mock-mode only). When present, handlePrompt
 * attaches deterministic reasoning + sources to the answer MessageFile so the dApp's
 * reasoning/sources render path can be asserted end-to-end (see MOCK_REASONING_SENTINEL).
 * @param {string} text - The prompt text.
 * @returns {boolean} True if the reasoning sentinel is present.
 */
function hasMockReasoningSentinel(text) {
  if (typeof text !== "string") return false;
  return MOCK_REASONING_SENTINEL.test(text);
}

/**
 * Parses the optional "__E2E_STEP_MS__:<n>" marker (mock-mode only): the wait before each of the
 * reasoning sentinel's steps, capped at MAX_MOCK_STEP_MS.
 * @param {string} text
 * @returns {number}
 */
function parseMockStepMs(text) {
  if (typeof text !== "string") return 0;
  const match = text.match(MOCK_STEP_MS_SENTINEL);
  if (!match) return 0;
  return Math.min(Number(match[1]), MAX_MOCK_STEP_MS);
}

/** Detects the optional "__E2E_RERUN__" marker (mock-mode only). */
function hasMockRerunSentinel(text) {
  if (typeof text !== "string") return false;
  return MOCK_RERUN_SENTINEL.test(text);
}

/**
 * Mock mode's fixed sources and reasoning, sent through the same tap as a model's: the stream's
 * sources and steps, each step sanitised and converted as a real thought is. The stored record is
 * then built from these frames like any other. `partial` sends the sources and the first step only.
 */
async function emitMockReasoning(stream, promptText, { partial = false } = {}) {
  const stepMs = parseMockStepMs(promptText);
  stream.sources(MOCK_E2E_SOURCES);
  const steps = partial ? MOCK_E2E_REASONING.slice(0, 1) : MOCK_E2E_REASONING;
  for (const [index, { title, description }] of steps.entries()) {
    if (stepMs > 0) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, stepMs);
        timer.unref();
      });
    }
    stream.step(async () => {
      const clean = await sanitizeThought(description);
      return clean ? stepFromThought({ thought: clean, action: title }, index) : null;
    });
  }
  await stream.flush();
}

/**
 * Sets where live frames go (the stream server, once it exists). Anything that is not a sink
 * means none: the answer path then builds offline streams and sends nothing.
 */
function setStreamSink(sink) {
  streamSink = sink;
}

/**
 * The heartbeat's `stream` block: the answer path's counts, and the stream server's own stats
 * (`server`, null when the sink has none or they cannot be read). Never an id.
 */
function streamHeartbeatSnapshot() {
  let server = null;
  try {
    if (typeof streamSink?.stats === "function") server = streamSink.stats() ?? null;
  } catch {
    server = null;
  }
  return { ...streamCounters.snapshot(), server };
}

/**
 * Opens the live stream for one run of an answer. Never throws (see createAnswerStream). The
 * reset says "retry" when this process has opened a run for this answer before.
 */
function openAnswerStream(answerMessageId, sessionKey) {
  const key = answerMessageId.toString();
  const reason = answersRun.has(key) ? "retry" : "start";
  answersRun.set(key, true);
  if (!replicaId) {
    // Settled in configure(); a module loaded without it (tests) still gets a valid one.
    try {
      replicaId = resolveReplicaId();
    } catch {
      replicaId = resolveReplicaId({});
    }
  }
  const stream = createAnswerStream({
    answerMessageId: key,
    sessionKey,
    replica: replicaId,
    sink: streamSink,
    reason,
  });
  recentStreams.push(new WeakRef(stream));
  if (recentStreams.length > RECENT_STREAMS_KEPT) recentStreams.shift();
  return stream;
}

/** Test seam: waits for the frames the most recent streams have queued. */
async function flushStreamsForTest() {
  await Promise.all(recentStreams.map((ref) => ref.deref()?.flush()));
}

/**
 * The reasoning, sources, answering attempt and duration an assistant MessageFile stores.
 * Reasoning, sources and the attempt come from the stream's record, which is the projection of the
 * frames it built: what was shown live is what is stored. Empty lists are left out, as before, and
 * so is `answerAttempt` when it is 1 (no fallback tier was entered), so such a file is unchanged.
 */
function storedExtrasFrom({ reasoning, sources, answerAttempt }, reasoningDuration) {
  return {
    ...(reasoning.length ? { reasoning } : {}),
    ...(sources.length ? { sources } : {}),
    ...(answerAttempt > 1 ? { answerAttempt } : {}),
    ...(reasoningDuration !== undefined ? { reasoningDuration } : {}),
  };
}

/**
 * Whether this run's own submitAnswer transaction was mined and succeeded although waiting for its
 * receipt threw (an RPC drop or a timeout after it landed). Read by the transaction's hash, so only
 * this run's submission can count: a revert, a cancellation or another replica's answer leaves no
 * successful receipt under it. Never asked for a `JobAlreadyFinalized` revert, which the handler's
 * own branch keeps. Never throws: a receipt that cannot be read counts as not mined.
 */
async function minedDespiteFailedWait(error, txHash) {
  if (typeof txHash !== "string" || txHash === "") return false;
  if (isContractError(error, "JobAlreadyFinalized")) return false;
  try {
    const receipt = await provider.getTransactionReceipt(txHash);
    return receipt?.status === 1;
  } catch {
    return false;
  }
}

/**
 * Decides whether the oracle must initialise the conversation on storage (create the
 * ConversationFile + emit a non-empty conversationCID, which makes EVMAIAgent emit
 * ConversationAdded so the subgraph indexes the conversation).
 *
 * Normally driven by the client's `isNewConversation` flag. But a conversation whose first
 * prompt was CANCELLED never had its first answer delivered, so ConversationAdded never
 * fired — yet the client resends with `isNewConversation: false` (it reuses the existing
 * conversationId). Without a guard the answer would be appended with an empty
 * conversationCID, the Conversation entity would never be created, and the dApp's
 * owner-filtered sync would never surface it (stuck "Thinking…" forever).
 *
 * The dApp is the primary fix (it flags such a resend new). This is the defensive backstop:
 * when a non-new prompt arrives with NO parent CID — the structural signature of "first
 * persisted message in this conversation" — we disambiguate via `conversationKeyExists`
 * (whether a ROFL key file already exists for the conversation, looked up by tag, the same
 * mechanism getSessionKey uses). No key file ⇒ the conversation was never persisted ⇒
 * initialise. Key file present ⇒ it IS an established conversation (e.g. editing its first
 * message) ⇒ append, so we don't re-emit ConversationAdded and clobber its metadata.
 *
 * @param {object} args
 * @param {boolean} args.isNewConversation - The client's new-conversation flag.
 * @param {string|null} [args.previousMessageCID] - Parent message CID, if any.
 * @param {boolean} [args.conversationKeyExists] - Whether a key file already exists for the
 *   conversation. Only reached on the orphan-risk path (non-new AND no parent CID), where the
 *   caller MUST supply it (it has run the tag lookup). It is REQUIRED there: an omitted/undefined
 *   value falls through to `false` ("don't initialise"), which is the safe default for any other
 *   shape but would WRONGLY decline to initialise a genuine orphan — so never omit it on that path.
 * @returns {boolean} True if the conversation must be initialised on storage.
 */
function shouldInitializeConversation({
  isNewConversation,
  previousMessageCID,
  conversationKeyExists,
}) {
  if (isNewConversation) return true;
  // A normal follow-up threads off a parent message — the conversation is already
  // established, so never re-initialise.
  if (previousMessageCID) return false;
  // Orphan-risk: non-new but parentless. Initialise only if no key file exists yet. The caller
  // must have resolved conversationKeyExists here (undefined would decline to initialise).
  return conversationKeyExists === false;
}

/**
 * A dispatcher for querying the AI model chosen by `classifyIntent`, with the failover chain.
 * @param {Array<object>} conversationHistory - The full conversation history with roles.
 * @param {string} conversationId - The on-chain conversation ID.
 * @param {string} userWallet - The user's wallet address.
 * @param {object} [liveStream] - The answer's live stream (stream/answerStream.js). Each fallback
 *          tier actually entered is a new attempt on it; the ElizaOS path sends its sources and
 *          steps to it. The handlers store reasoning and sources from its record, never from the
 *          answer returned here.
 * @returns {Promise<{text: string, reasoning: Array<{title: string, description: string}>, sources: Array<{title: string, url: string}>, reasoningDuration?: number}>}
 *          The normalized answer object (CU-86d3cfa41) — string-only provider
 *          paths carry empty reasoning/sources, and so does the ElizaOS path (its sources and
 *          steps go to the live stream as they are known).
 */
function asAnswer(text) {
  return { text, reasoning: [], sources: [] };
}

async function queryAIModel(conversationHistory, conversationId, userWallet, liveStream) {
  // The answer's live stream (see stream/answerStream.js); an offline one for a caller with none.
  const stream = liveStream ?? createOfflineStream();
  // --- MOCK MODE: Return deterministic response ---
  if (MOCK_AI) {
    const latestUserMessage =
      conversationHistory.filter((msg) => msg.role === "user").pop()?.content || "unknown query";

    // E2E only: honour a "__E2E_DELAY_MS__:<n>" marker in the prompt so a test can
    // keep the answer pending long enough to cancel/refund it. Mock-only => prod-safe.
    const delayMs = parseMockDelayMs(latestUserMessage);
    if (delayMs > 0) {
      console.log(`[Mock AI] Honouring E2E delay sentinel — holding answer ${delayMs}ms`);
      // unref() so a pending sentinel delay never holds the process open on SIGTERM
      // (CI/test teardown) — the oracle can still exit instead of lingering for delayMs.
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, delayMs);
        timer.unref();
      });
    }

    const mockResponse = `[MOCK] I acknowledge your query about "${latestUserMessage.substring(0, 40)}...". This is a deterministic mock response for local testing.`;
    console.log("[Mock AI] Returning deterministic mock response");
    // MOCK_AI (localnet / e2e). Counted so a mock-mode deploy is unmistakable.
    providerTally.recordServed("mock");

    return asAnswer(mockResponse);
  }

  const aiProvider = process.env.AI_PROVIDER;

  // Direct provider bypass (used in tests and explicit operator config)
  if (aiProvider === "ChainGPT") {
    try {
      const answer = asAnswer(await queryChainGPT(conversationHistory, conversationId, userWallet));
      providerTally.recordServed("chaingpt");

      return answer;
    } catch (err) {
      console.error("[queryAIModel] ChainGPT provider failed.", describeError(err));
      // Bypass configured but the provider failed — no answer produced.
      providerTally.recordServed("none");

      return asAnswer("Error: Could not generate a response from the ChainGPT service.");
    }
  }
  if (aiProvider === "Gemini") {
    try {
      const answer = asAnswer(await queryGeminiDirect(conversationHistory));
      // AFTER the await, never before: recording first means a throw is counted as both a
      // gemini success and a `none` failure from the catch below.
      providerTally.recordServed("gemini");

      return answer;
    } catch (err) {
      console.error("[queryAIModel] Direct Gemini provider failed.", describeError(err));
      // Bypass configured but the provider failed — no answer produced.
      providerTally.recordServed("none");

      return asAnswer("Error: Could not generate a response from the Gemini service.");
    }
  }

  // 1. Determine Intent
  const intent = await classifyIntent(conversationHistory);

  // 2. Path A: 1st Party Tradable Backend
  if (intent === "TRADABLE") {
    try {
      const answer = asAnswer(await queryTradableAssistant(conversationHistory, userWallet));
      providerTally.recordServed("tradable");

      return answer;
    } catch (err) {
      console.warn("[Failover] First-party path failed. Falling back to ElizaOS.");
      stream.attempt();
    }
  }

  // 3. Path B: 3rd Party ElizaOS (Google Vertex/Gemini via Plugin)
  try {
    // We pass conversationId here to ensure proper room isolation in Eliza
    const answer = await queryElizaOS(conversationHistory, conversationId, userWallet, stream);
    providerTally.recordServed("elizaos");

    return answer;
  } catch (err) {
    // A run thrown away for a failed tool step is most often a fault of the market-data tools,
    // not of the agent. ChainGPT is not asked then. It keeps its own record of the
    // conversation, outside the TEE, and a tool outage would send it every market question.
    // The heartbeat counts these runs by what went wrong (`rejectedRuns`).
    if (err instanceof UnansweredToolFailureError) {
      console.warn(
        "[Failover] A tool step failed in the ElizaOS run and nothing answered without it. " +
          "Answering with the direct Gemini call.",
      );
    } else {
      /* A retired or misspelled GOOGLE_* model id surfaces here, not at startup: Gemini
         404s the generateContent call, queryElizaOS throws, and we fall through to ChainGPT
         with no reasoning or sources. The answer degrades silently rather than erroring, so
         check this warning first when quality drops after a config change. Model ids are
         guarded by test/modelLifecycle.test.js and retirement dates are published at
         https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions */
      console.warn(
        "[Failover] ElizaOS path failed. Falling back to ChainGPT.",
        describedError(err),
      );

      // 4. Failover 1: ChainGPT. A new attempt on the stream: the steps shown so far stay.
      stream.attempt();
      try {
        const answer = asAnswer(
          await queryChainGPT(conversationHistory, conversationId, userWallet),
        );
        // AFTER the await. Recording first means a ChainGPT throw is counted as a chaingpt
        // success AND as whatever the next catch then records (gemini or none).
        providerTally.recordServed("chaingpt");

        return answer;
      } catch (err2) {
        console.error(
          "[Failover] ElizaOS and ChainGPT failed. Executing final direct-Gemini fallback.",
        );
      }
    }

    // 5. Failover 2: direct Gemini call, no agent runtime (see geminiDirect.js for why
    //    this is a different failure domain from the ElizaOS path above)
    stream.attempt();
    try {
      const answer = asAnswer(await queryGeminiDirect(conversationHistory));
      providerTally.recordServed("gemini");

      return answer;
    } catch (err3) {
      Sentry.captureException(err3, { tags: { site: "ai_all_tiers_failed" } });
      // Counted, not skipped: zeros across every tier would be indistinguishable from
      // "nobody asked anything". A total outage must not look like a quiet hour.
      providerTally.recordServed("none");

      return asAnswer(
        "Error: Could not generate a response. All AI providers are currently unavailable.",
      );
    }
  }
}

// --- Event Handlers ---

// Helper to check for specific contract errors using Ethers v6 Interface
function isContractError(error, errorName) {
  try {
    // 1. Get the specific error fragment from the ABI
    const errorFragment = contract.interface.getError(errorName);
    if (!errorFragment) return false;

    // 2. Check if the error data matches the selector
    const selector = errorFragment.selector;

    // Ethers v6 puts the raw revert data in different places depending on the transport
    const errorData = error.data || error.info?.error?.data || error.transaction?.data;

    if (errorData && errorData.includes(selector)) {
      return true;
    }

    // Fallback: sometimes the message contains the hex string directly
    if (error.message && error.message.includes(selector)) {
      return true;
    }

    return false;
  } catch (e) {
    return false;
  }
}

async function handlePrompt(
  user,
  conversationId,
  promptMessageId,
  answerMessageId,
  payload, // This is `bytes` on EVM, `string` on Sapphire
  roflEncryptedKey, // This is the top-level argument for EVM
  event,
) {
  console.log(
    `[EVENT] Processing PromptSubmitted for convId: ${conversationId} in block ${event.blockNumber}`,
  );

  // Did the answer actually reach the chain? The isJobFinalized guard inside the tx mutex returns
  // from that arrow function, not this handler, so nothing downstream can otherwise tell a
  // submitted answer from a cancelled one. Declared out here to survive the try/catch.
  let submitted = false;
  // This run's live stream, opened once the session key is known. Ended on every exit below.
  let stream = null;

  // --- Idempotency Check ---
  // Check if this specific answer ID has already been finalized on-chain.
  // This prevents wasting AI/Arweave credits on restarts or re-orgs.
  try {
    const isAlreadyDone = await contract.isJobFinalized(answerMessageId);
    if (isAlreadyDone) {
      console.log(
        `  ℹ️ Skipped: Prompt ${promptMessageId} is already answered on-chain or cancelled.`,
      );
      return;
    }
  } catch (err) {
    // The provider gave no answer: whether the job is done is unknown, so nothing is spent on
    // it now. The event goes to the retry queue and is looked at again.
    if (isTransientProviderError(err)) throw err;
    console.warn(
      `  ⚠️ Could not check isJobFinalized status, proceeding anyway. ${describeError(err)}`,
    );
  }

  try {
    const sessionKey = await getSessionKey(payload, roflEncryptedKey, conversationId.toString());
    stream = openAnswerStream(answerMessageId, sessionKey);

    const decryptedData = isSapphire
      ? payload
      : decryptSymmetrically(ethers.toUtf8String(payload), sessionKey);

    const clientPayload = validatePayload(decryptedData, "PromptSubmitted");

    // FENCE STRIP, at the only point a new prompt enters. `promptText` fans out from here to the
    // reconstructed history, the model, the stored MessageFile, the conversation title and the CID —
    // stripping once here leaves every one of them clean without enumerating them, and an enumeration
    // is what left doors open on both social surfaces.
    //
    // Removes fence tags and NOTHING else. A forged `### SYSTEM DIRECTIVE:` reaches the model exactly
    // as the user sent it, on purpose: the fence is what strips it of authority, and the user paid for
    // this prompt on-chain. What a prompt must not carry is a tag that CLOSES the region around it,
    // because that puts the rest of the prompt in the instruction region. See src/inboundPrompt.js.
    const { isNewConversation, previousMessageId, previousMessageCID } = clientPayload;
    const promptText = stripInboundPrompt(clientPayload.promptText);

    // E2E only: a "__E2E_DROP__" marker makes the oracle never answer this prompt, leaving
    // the on-chain job pending so a test can deterministically exercise the refund flow
    // (forward EVM time past REFUND_TIMEOUT → processRefund). Mock-only => prod-safe.
    if (MOCK_AI && hasMockDropSentinel(promptText)) {
      console.log(
        `  ℹ️ Dropping prompt ${promptMessageId} (E2E __E2E_DROP__ sentinel) — leaving it pending for the refund flow.`,
      );
      stream.done("abandoned");
      return;
    }

    // E2E only: "__E2E_REASONING__" sends fixed sources and reasoning through the stream, the
    // same tap a model's go through, so they are stored as its projection like any other; and
    // "__E2E_RERUN__" ends the first run after its first step and runs the prompt again (see
    // MOCK_RERUN_SENTINEL). Never in production: MOCK_AI is false there.
    let mockReasoningDuration;
    if (MOCK_AI) {
      const rerun = hasMockRerunSentinel(promptText) && !mockRerunsDone.has(String(answerMessageId));
      if (rerun) {
        mockRerunsDone.set(String(answerMessageId), true);
        await emitMockReasoning(stream, promptText, { partial: true });
        throw new MockRerunError("E2E re-run sentinel");
      }
      if (hasMockReasoningSentinel(promptText)) {
        await emitMockReasoning(stream, promptText);
        mockReasoningDuration = MOCK_E2E_REASONING_DURATION;
      }
    }

    console.log("  Reconstructing history for regeneration...");
    const history = await reconstructHistory(previousMessageCID, sessionKey);

    history.push({ role: "user", content: promptText, createdAt: Date.now() });

    const answer = await queryAIModel(history, conversationId.toString(), user, stream);
    // FENCE STRIP on the way OUT, and not redundant with the inbound one. The inbound strip covers
    // `promptText` and everything derived from it; this answer is derived from the MODEL, and it lands
    // in the same fenced region — stored verbatim, then replayed by `reconstructHistory` inside
    // `untrusted_conversation` on every later turn. A prompt that asks the model to echo
    // `</untrusted_conversation>` escapes the fence one turn later, where the inbound strip cannot
    // see it. Storage is immutable, so this has to happen before the upload, not at the read.
    const answerText = stripStoredAnswer(answer.text);
    // Reasoning and sources from the stream's record ONLY: the projection of the frames it built,
    // so what was shown live is what is stored. Read once every queued step is in (bounded), and
    // nothing is added to the stream's steps after it.
    await stream.flush();
    const storedExtras = storedExtrasFrom(
      stream.record(),
      mockReasoningDuration ?? answer.reasoningDuration,
    );

    // Check again before paying for storage
    try {
      const isDoneNow = await contract.isJobFinalized(answerMessageId);
      if (isDoneNow) {
        console.log(`  ℹ️ Skipped: Prompt ${promptMessageId} was cancelled during AI processing.`);
        stream.done("abandoned");
        return;
      }
    } catch (err) {
      // The model has already been paid for: the answer is carried on to the submission, which
      // checks again.
      console.warn(
        `  ⚠️ Could not check isJobFinalized status, proceeding anyway. ${describeError(err)}`,
      );
    }

    const now = Date.now();
    let cidBundle = {};
    let answerMessageCID = "";

    // Prepare files
    const promptMessageFile = createMessageFile({
      id: promptMessageId.toString(),
      conversationId: conversationId.toString(),
      parentId: previousMessageId || null,
      parentCID: previousMessageCID || null,
      createdAt: now,
      role: "user",
      content: promptText,
    });
    const searchDeltaFile = createSearchIndexDeltaFile({
      conversationId: conversationId.toString(),
      messageId: promptMessageId.toString(),
      userMessageContent: promptText,
    });

    // Encrypt in memory (we need the strings for cache injection later)
    const encryptedPrompt = encryptSymmetrically(promptMessageFile, sessionKey);
    const encryptedDelta = encryptSymmetrically(searchDeltaFile, sessionKey);

    // Backstop for an orphaned conversation: a non-new prompt with NO parent CID is the
    // structural signature of "first persisted message". If the client failed to flag it
    // new (e.g. its first prompt was cancelled, so ConversationAdded never fired), confirm
    // via the conversation's key file — absent ⇒ never persisted ⇒ initialise. We only run
    // this lookup in that rare ambiguous case, never on normal follow-ups. See
    // shouldInitializeConversation.
    let conversationKeyExists;
    // Fetched once and shared between the orphan-backstop key lookup and the init block below,
    // so the two `${chainId}-${conversationId}` tag values can't diverge.
    let chainId;
    if (!isNewConversation && !previousMessageCID) {
      ({ chainId } = await provider.getNetwork());
      const existingKeyCID = await queryTransactionByTags([
        { name: "Content-Type", value: "application/rofl-key" },
        { name: "SenseAI-Key-For-Conversation", value: `${chainId}-${conversationId}` },
      ]);
      conversationKeyExists = !!existingKeyCID;
      if (!conversationKeyExists) {
        console.warn(
          `  ⚠️ Conversation ${conversationId} has no key file but the client did not flag it new — initialising defensively (orphaned after a cancelled first prompt).`,
        );
      }
    }
    const initialiseConversation = shouldInitializeConversation({
      isNewConversation,
      previousMessageCID,
      conversationKeyExists,
    });

    if (initialiseConversation) {
      console.log(`Initializing new conversation ${conversationId} on storage...`);
      // Reuse the chainId from the orphan-backstop lookup if it ran; otherwise fetch it now
      // (the normal new-conversation path skips that block).
      if (chainId === undefined) {
        ({ chainId } = await provider.getNetwork());
      }
      const keyFileTags = [
        { name: "Content-Type", value: "application/rofl-key" },
        { name: "SenseAI-Key-For-Conversation", value: `${chainId}-${conversationId}` },
      ];
      // For Sapphire, the sessionKey is received raw in the payload.
      // We must now encrypt it for persistent storage.
      let keyToStore;
      if (isSapphire) {
        const AI_AGENT_PUBLIC_KEY = requireDecryptor().publicKey;
        keyToStore = await eciesEncrypt(AI_AGENT_PUBLIC_KEY, Buffer.from(sessionKey));
      } else {
        keyToStore = Buffer.from(strip0xPrefix(roflEncryptedKey), "hex");
      }

      const conversationFile = createConversationFile({
        id: conversationId.toString(),
        ownerAddress: user,
        createdAt: now,
      });
      const conversationMetadataFile = createConversationMetadataFile({
        title: promptText.substring(0, 40),
        isDeleted: false,
        lastUpdatedAt: now,
      });

      const encryptedConv = encryptSymmetrically(conversationFile, sessionKey);
      const encryptedMeta = encryptSymmetrically(conversationMetadataFile, sessionKey);

      // Store as hex string so fetchData's response.text() round-trip is lossless.
      // Raw binary Buffers are corrupted by UTF-8 decoding on fetch.
      await uploadData(Buffer.from(keyToStore.toString("hex")), keyFileTags);

      // Parallel Uploads
      const [conversationCID, metadataCID, promptMessageCID, searchDeltaCID] = await Promise.all([
        uploadData(Buffer.from(encryptedConv)),
        uploadData(Buffer.from(encryptedMeta)),
        uploadData(Buffer.from(encryptedPrompt)),
        uploadData(Buffer.from(encryptedDelta)),
      ]);

      // Cache Injection: We just uploaded the Prompt, so store its encrypted form in cache
      rawMessageCache.set(promptMessageCID, encryptedPrompt);

      // Create Answer
      const answerMessageFile = createMessageFile({
        id: answerMessageId.toString(),
        conversationId: conversationId.toString(),
        parentId: promptMessageId.toString(),
        parentCID: promptMessageCID,
        createdAt: now + 1,
        role: "assistant",
        content: answerText,
        ...storedExtras,
      });
      const encryptedAnswer = encryptSymmetrically(answerMessageFile, sessionKey);

      answerMessageCID = await uploadData(Buffer.from(encryptedAnswer));

      // Cache Injection: Store the Answer's encrypted form
      rawMessageCache.set(answerMessageCID, encryptedAnswer);

      cidBundle = {
        conversationCID,
        metadataCID,
        promptMessageCID,
        answerMessageCID,
        searchDeltaCID,
      };
    } else {
      console.log(`Appending messages to conversation ${conversationId} on storage...`);
      const [promptMessageCID, searchDeltaCID] = await Promise.all([
        uploadData(Buffer.from(encryptedPrompt)),
        uploadData(Buffer.from(encryptedDelta)),
      ]);

      // Cache Injection
      rawMessageCache.set(promptMessageCID, encryptedPrompt);

      const answerMessageFile = createMessageFile({
        id: answerMessageId.toString(),
        conversationId: conversationId.toString(),
        parentId: promptMessageId.toString(),
        parentCID: promptMessageCID,
        createdAt: now + 1,
        role: "assistant",
        content: answerText,
        ...storedExtras,
      });
      const encryptedAnswer = encryptSymmetrically(answerMessageFile, sessionKey);

      answerMessageCID = await uploadData(Buffer.from(encryptedAnswer));

      // Cache Injection
      rawMessageCache.set(answerMessageCID, encryptedAnswer);

      cidBundle = {
        conversationCID: "",
        metadataCID: "",
        promptMessageCID,
        answerMessageCID,
        searchDeltaCID,
      };
    }

    // This run's own submitAnswer transaction once sent: if waiting for its receipt throws, its
    // hash tells an answer that was mined anyway from one that was not.
    let sentTxHash = null;
    try {
      // We lock the wallet to ensure Nonces are used sequentially.
      await txMutex.runExclusive(async () => {
        // Double-check finalization on-chain right before sending
        // This catches race conditions where user cancelled while we were uploading
        const isFinalized = await contract.isJobFinalized(answerMessageId);

        if (isFinalized) {
          console.log(
            `  ℹ️ Skipped (in mutex): Prompt ${promptMessageId} finalized or cancelled just now.`,
          );
          return;
        }
        console.log(`  Submitting transaction for prompt ${promptMessageId}...`);

        const tx = await contract.submitAnswer(promptMessageId, answerMessageId, cidBundle);
        sentTxHash = tx.hash;

        const receipt = await tx.wait();
        // After the receipt: an unconfirmed submission is not an answer. Recording before
        // confirmation would be the worse error; a wait that throws is settled below.
        submitted = true;
        console.log(
          `  ✅ Success! Answer for prompt ${promptMessageId} submitted. Tx: ${receipt.hash}`,
        );
      });
    } catch (submitError) {
      // The wait threw, but this run's own transaction may have landed: its receipt, read by
      // hash, confirms it, and it is then this run's answer like any other. Otherwise the error
      // goes on to the handler's catch unchanged (a cancellation, another replica, a failure).
      if (!(await minedDespiteFailedWait(submitError, sentTxHash))) throw submitError;
      submitted = true;
      console.log(
        `  ✅ Answer for prompt ${promptMessageId} was mined, though waiting for its receipt failed. Tx: ${sentTxHash}`,
      );
    }

    // The answer frame goes only after THIS run's submitAnswer receipt: a retry re-runs the model
    // and uploads again, so an earlier upload is never the answer. Queued, never awaited.
    if (submitted) {
      stream.answer({
        text: answerText,
        answerMessageCID,
        reasoningDuration: storedExtras.reasoningDuration,
      });
      stream.done("answered");
    } else {
      stream.done("abandoned");
    }
  } catch (error) {
    // E2E only: the first run of an "__E2E_RERUN__" prompt ends interrupted and the prompt is run
    // again here, once, as a real second run. Its frames are flushed first so the second run's
    // reset follows the first run's done.
    if (MOCK_AI && error instanceof MockRerunError) {
      stream?.done("interrupted");
      await stream?.flush();
      console.log("[Mock AI] E2E re-run sentinel: running the prompt again in this process.");
      return handlePrompt(
        user,
        conversationId,
        promptMessageId,
        answerMessageId,
        payload,
        roflEncryptedKey,
        event,
      );
    }


    if (isContractError(error, "JobAlreadyFinalized")) {
      console.log(
        `  ℹ️ Skipped: Transaction reverted with 'JobAlreadyFinalized'. The user likely cancelled this prompt.`,
      );
      stream?.done("abandoned");

      return; // Exit gracefully
    }

    // --- Fallback State Check ---
    // If the transaction failed, check if the job is already finalized on-chain.
    // This handles cases where Ethers v6 or the RPC doesn't return the revert reason clearly.
    try {
      const isFinalized = await contract.isJobFinalized(answerMessageId);

      if (isFinalized) {
        console.log(
          `  ℹ️ Transaction failed but job ${answerMessageId} is finalized on-chain. Treating as cancelled/completed.`,
        );
        stream?.done("abandoned");

        return; // Exit gracefully
      }
    } catch (checkErr) {
      // Submit and verification both failed, so a cancellation is indistinguishable from a real
      // failure here. `answer_failed` is still recorded below — it means "no answer reached the
      // chain", true either way — but during an RPC outage it will include cancellations.
      console.warn(
        "  ⚠️ Could not verify job finalization status after error — recording answer_failed UNVERIFIED.",
      );
    }

    // `answer_failed` means no answer reached the chain — a real failure, or a cancellation we
    // could not verify. Bad input is excluded: this catch wraps the whole try, including decrypt
    // and validatePayload, and handleAndRecord already drops and logs those as not our failure.
    // Recording them would let attacker-controlled input inflate the failure count. Before the
    // rethrow, since handleAndRecord may retry and the kind is part of the seed.
    if (!isBadInputError(error)) {
      await recordAnswerActivity({
        answerMessageId,
        kind: "answer_failed",
        userWallet: user,
        conversationId,
        promptMessageId,
      });
    }

    Sentry.captureException(error, {
      tags: { site: "handle_prompt" },
      extra: { convId: conversationId?.toString() },
    });
    console.error(`Error in handlePrompt for convId ${conversationId}:`, describedError(error));

    // Bad input is dropped for good; anything else may be retried as a new run.
    stream?.done(isBadInputError(error) ? "abandoned" : "interrupted");

    throw error; // Propagate error to be caught by handleAndRecord
  }

  // Outside the try/catch so a telemetry throw could never be caught below and recorded as a
  // failure for an answer that succeeded; outside the mutex so a Postgres round-trip does not
  // serialise submissions behind the tx lock.
  if (submitted) {
    await recordAnswerActivity({
      answerMessageId,
      kind: "answer",
      userWallet: user,
      conversationId,
      promptMessageId,
    });
  }
}

async function handleRegeneration(
  user,
  conversationId,
  promptMessageId,
  originalAnswerMessageId,
  answerMessageId,
  payload,
  roflEncryptedKey,
  event,
) {
  console.log(
    `[EVENT] Processing RegenerationRequested for promptId: ${promptMessageId} in block ${event.blockNumber}`,
  );

  // Did the answer actually reach the chain? See handlePrompt — the mutex's isJobFinalized guard
  // returns from that arrow function, not this handler.
  let submitted = false;
  // This run's live stream, opened once the session key is known. Ended on every exit below.
  let stream = null;

  // --- Idempotency Check ---
  // Check if this specific answer ID has already been finalized on-chain.
  // This prevents wasting AI/Arweave credits on restarts or re-orgs.
  try {
    const isAlreadyDone = await contract.isJobFinalized(answerMessageId);
    if (isAlreadyDone) {
      console.log(`  ℹ️ Skipped: Regeneration ${answerMessageId} is already finalized on-chain.`);
      return;
    }
  } catch (err) {
    // The provider gave no answer: whether the job is done is unknown, so nothing is spent on
    // it now. The event goes to the retry queue and is looked at again.
    if (isTransientProviderError(err)) throw err;
    console.warn(
      `  ⚠️ Could not check isJobFinalized status, proceeding anyway. ${describeError(err)}`,
    );
  }

  try {
    const sessionKey = await getSessionKey(payload, roflEncryptedKey, conversationId.toString());
    stream = openAnswerStream(answerMessageId, sessionKey);

    const decryptedData = isSapphire
      ? payload
      : decryptSymmetrically(ethers.toUtf8String(payload), sessionKey);

    const clientPayload = validatePayload(decryptedData, "RegenerationRequested");

    const { promptMessageCID, originalAnswerMessageCID } = clientPayload;

    // Fence-stripped for exactly the reason promptText is. This string is interpolated into a history
    // message a few lines down, and RECENT_MESSAGES renders history INSIDE the untrusted_conversation
    // fence — so a closing tag here would end the region early and leave the remainder sitting where
    // the model reads instructions. Produced BY the strip rather than destructured and then
    // reassigned, so there is no raw binding in scope to reach for by mistake.
    // `!= null` rather than truthy: `stripInboundPrompt` coerces with `String(text ?? "")`, so an
    // empty string is safe to pass, and passing it means the uninitialised-throw fires for every
    // value that is actually present. A truthy check would let `""` skip the strip entirely, which
    // is harmless for injection but narrows the one signal that says the strip is wired at all.
    const instructions =
      clientPayload.instructions != null
        ? stripInboundPrompt(clientPayload.instructions)
        : clientPayload.instructions;

    console.log("  Reconstructing history for regeneration...");
    const history = await reconstructHistory(originalAnswerMessageCID, sessionKey);
    if (instructions) {
      history.push({
        role: "user",
        content: `Please regenerate your previous response. Make it ${instructions}.`,
        createdAt: Date.now(),
      });
    }

    const answer = await queryAIModel(history, conversationId.toString(), user, stream);
    // FENCE STRIP on the way OUT, and not redundant with the inbound one. The inbound strip covers
    // `promptText` and everything derived from it; this answer is derived from the MODEL, and it lands
    // in the same fenced region — stored verbatim, then replayed by `reconstructHistory` inside
    // `untrusted_conversation` on every later turn. A prompt that asks the model to echo
    // `</untrusted_conversation>` escapes the fence one turn later, where the inbound strip cannot
    // see it. Storage is immutable, so this has to happen before the upload, not at the read.
    const answerText = stripStoredAnswer(answer.text);
    // Reasoning and sources from the stream's record ONLY (see handlePrompt).
    await stream.flush();
    const storedExtras = storedExtrasFrom(stream.record(), answer.reasoningDuration);

    // Check again before paying for storage
    try {
      const isDoneNow = await contract.isJobFinalized(answerMessageId);
      if (isDoneNow) {
        console.log(`  ℹ️ Skipped: Prompt ${promptMessageId} was cancelled during AI processing.`);
        stream.done("abandoned");
        return;
      }
    } catch (err) {
      // The model has already been paid for: the answer is carried on to the submission, which
      // checks again.
      console.warn(
        `  ⚠️ Could not check isJobFinalized status, proceeding anyway. ${describeError(err)}`,
      );
    }

    const now = Date.now();

    const answerMessageFile = createMessageFile({
      id: answerMessageId.toString(),
      conversationId: conversationId.toString(),
      parentId: promptMessageId.toString(),
      parentCID: promptMessageCID ? promptMessageCID.toString() : "",
      createdAt: now,
      role: "assistant",
      content: answerText,
      ...storedExtras,
    });
    const encryptedAnswer = encryptSymmetrically(answerMessageFile, sessionKey);

    const answerMessageCID = await uploadData(Buffer.from(encryptedAnswer));

    // Cache Injection
    rawMessageCache.set(answerMessageCID, encryptedAnswer);

    const cidBundle = {
      conversationCID: "",
      metadataCID: "",
      promptMessageCID: "",
      answerMessageCID,
      searchDeltaCID: "",
    };

    // This run's own submitAnswer transaction once sent: if waiting for its receipt throws, its
    // hash tells an answer that was mined anyway from one that was not.
    let sentTxHash = null;
    try {
      // We lock the wallet to ensure Nonces are used sequentially.
      await txMutex.runExclusive(async () => {
        // Double-check finalization on-chain right before sending
        // This catches race conditions where user cancelled while we were uploading
        const isFinalized = await contract.isJobFinalized(answerMessageId);

        if (isFinalized) {
          console.log(
            `  ℹ️ Skipped (in mutex): Prompt ${promptMessageId} finalized or cancelled just now.`,
          );
          return;
        }
        console.log(`  Submitting transaction for prompt ${promptMessageId}...`);

        const tx = await contract.submitAnswer(promptMessageId, answerMessageId, cidBundle);
        sentTxHash = tx.hash;

        const receipt = await tx.wait();
        // After the receipt: an unconfirmed submission is not an answer. Recording before
        // confirmation would be the worse error; a wait that throws is settled below.
        submitted = true;
        console.log(
          `  ✅ Success! Regeneration for prompt ${promptMessageId} submitted. Tx: ${receipt.hash}`,
        );
      });
    } catch (submitError) {
      // The wait threw, but this run's own transaction may have landed: its receipt, read by
      // hash, confirms it, and it is then this run's answer like any other. Otherwise the error
      // goes on to the handler's catch unchanged (a cancellation, another replica, a failure).
      if (!(await minedDespiteFailedWait(submitError, sentTxHash))) throw submitError;
      submitted = true;
      console.log(
        `  ✅ Regeneration for prompt ${promptMessageId} was mined, though waiting for its receipt failed. Tx: ${sentTxHash}`,
      );
    }

    // After THIS run's receipt only (see handlePrompt). Queued, never awaited.
    if (submitted) {
      stream.answer({
        text: answerText,
        answerMessageCID,
        reasoningDuration: storedExtras.reasoningDuration,
      });
      stream.done("answered");
    } else {
      stream.done("abandoned");
    }
  } catch (error) {
    if (isContractError(error, "JobAlreadyFinalized")) {
      console.log(
        `  ℹ️ Skipped: Transaction reverted with 'JobAlreadyFinalized'. The user likely cancelled this prompt.`,
      );
      stream?.done("abandoned");

      return; // Exit gracefully
    }

    // --- Fallback State Check ---
    try {
      const isFinalized = await contract.isJobFinalized(answerMessageId);

      if (isFinalized) {
        console.log(
          `  ℹ️ Transaction failed but job ${answerMessageId} is finalized on-chain. Treating as cancelled/completed.`,
        );
        stream?.done("abandoned");

        return; // Exit gracefully
      }
    } catch (checkErr) {
      // Submit and verification both failed, so a cancellation is indistinguishable from a real
      // failure here. `answer_failed` is still recorded below — it means "no answer reached the
      // chain", true either way — but during an RPC outage it will include cancellations.
      console.warn(
        "  ⚠️ Could not verify job finalization status after error — recording answer_failed UNVERIFIED.",
      );
    }

    // `answer_failed` means no answer reached the chain — a real failure, or a cancellation we
    // could not verify. Bad input is excluded: this catch wraps the whole try, including decrypt
    // and validatePayload, and handleAndRecord already drops and logs those as not our failure.
    // Recording them would let attacker-controlled input inflate the failure count. Before the
    // rethrow, since handleAndRecord may retry and the kind is part of the seed.
    if (!isBadInputError(error)) {
      await recordAnswerActivity({
        answerMessageId,
        kind: "answer_failed",
        userWallet: user,
        conversationId,
        promptMessageId,
      });
    }

    console.error(
      `Error in handleRegeneration for promptId ${promptMessageId}:`,
      describedError(error),
    );
    // Bad input is dropped for good; anything else may be retried as a new run.
    stream?.done(isBadInputError(error) ? "abandoned" : "interrupted");
    throw error;
  }

  // Outside the try/catch so a telemetry throw could never be caught below and recorded as a
  // failure for an answer that succeeded; outside the mutex so a Postgres round-trip does not
  // serialise submissions behind the tx lock.
  if (submitted) {
    await recordAnswerActivity({
      answerMessageId,
      kind: "answer",
      userWallet: user,
      conversationId,
      promptMessageId,
    });
  }
}

async function handleBranch(
  user,
  originalConversationId,
  branchPointMessageId,
  newConversationId,
  payload,
  roflEncryptedKey,
  event,
) {
  console.log(
    `[EVENT] Processing BranchRequested for original convId: ${originalConversationId} in block ${event.blockNumber}`,
  );

  try {
    const sessionKey = await getSessionKey(
      payload,
      roflEncryptedKey,
      originalConversationId.toString(),
    );

    const decryptedData = isSapphire
      ? payload
      : decryptSymmetrically(ethers.toUtf8String(payload), sessionKey);

    const clientPayload = validatePayload(decryptedData, "BranchRequested");

    const { originalTitle } = clientPayload;

    const now = Date.now();
    const newTitle = `Branch of ${originalTitle}`;

    const { chainId } = await provider.getNetwork();
    const newKeyFileTags = [
      { name: "Content-Type", value: "application/rofl-key" },
      { name: "SenseAI-Key-For-Conversation", value: `${chainId}-${newConversationId}` },
    ];
    // For Sapphire, the sessionKey is received raw in the payload.
    // We must now encrypt it for persistent storage.
    let keyToStore;
    if (isSapphire) {
      const AI_AGENT_PUBLIC_KEY = requireDecryptor().publicKey;
      keyToStore = await eciesEncrypt(AI_AGENT_PUBLIC_KEY, Buffer.from(sessionKey));
    } else {
      keyToStore = Buffer.from(strip0xPrefix(roflEncryptedKey), "hex");
    }

    await uploadData(keyToStore, newKeyFileTags);

    const conversationFile = createConversationFile({
      id: newConversationId.toString(),
      ownerAddress: user,
      createdAt: now,
      branchedFromConversationId: originalConversationId.toString(),
      branchedAtMessageId: branchPointMessageId.toString(),
    });
    const conversationMetadataFile = createConversationMetadataFile({
      title: newTitle,
      isDeleted: false,
      lastUpdatedAt: now,
    });

    const encryptedConv = encryptSymmetrically(conversationFile, sessionKey);
    const encryptedMeta = encryptSymmetrically(conversationMetadataFile, sessionKey);

    const [conversationCID, metadataCID] = await Promise.all([
      uploadData(Buffer.from(encryptedConv)),
      uploadData(Buffer.from(encryptedMeta)),
    ]);

    await txMutex.runExclusive(async () => {
      console.log(`  Submitting branch ${newConversationId}...`);

      const tx = await contract.submitBranch(
        user,
        originalConversationId,
        branchPointMessageId,
        newConversationId,
        conversationCID,
        metadataCID,
      );

      const receipt = await tx.wait();
      console.log(
        `  ✅ Success! Branch submitted. New convId: ${newConversationId}. Tx: ${receipt.hash}`,
      );
    });
  } catch (error) {
    console.error(
      `Error in handleBranch for convId ${originalConversationId}:`,
      describedError(error),
    );
    throw error;
  }
}

// The newest metadata update this process has applied for each conversation (on-chain id →
// position). The state store is the record that survives a restart; this covers a record that
// could not be written after its transaction landed.
const metadataAppliedInProcess = new Map();

/**
 * Where a request event sits on the chain: its block, then its log index in that block. The order
 * a conversation's metadata updates must be applied in. Throws when either is missing: every event
 * read from the chain, a retried one included, carries both.
 *
 * @returns {{ blockNumber: number, logIndex: number }}
 */
function chainPositionOf(event) {
  const blockNumber = event?.blockNumber;
  const logIndex = event?.index;
  if (
    !Number.isSafeInteger(blockNumber) ||
    blockNumber < 0 ||
    !Number.isSafeInteger(logIndex) ||
    logIndex < 0
  ) {
    throw new Error(
      "A metadata update needs its event's position on the chain (block and log index)",
    );
  }
  return { blockNumber, logIndex };
}

/**
 * The newest metadata update applied for a conversation, from the state store and this process,
 * or null. A store that cannot be read is a RetryableError: applying without the record could
 * undo a newer update, so the event waits for the retry queue instead.
 */
async function lastAppliedMetadataUpdate(conversationKey) {
  let stored;
  try {
    stored = await stateStore.lastMetadataUpdate(conversationKey);
  } catch (error) {
    throw new RetryableError(
      `Could not read the last metadata update applied for conversation ${conversationKey}: ${describeError(error)}`,
      { cause: error },
    );
  }
  const inProcess = metadataAppliedInProcess.get(conversationKey) ?? null;
  if (stored && inProcess) return isLaterPosition(inProcess, stored) ? inProcess : stored;
  return stored ?? inProcess;
}

/**
 * Is this update at or before one already applied for its conversation? Then it is not applied:
 * the later one is what the owner asked for last, and an equal one is this same request, already
 * applied (a range scanned again, or a retry whose completion could not be recorded).
 */
async function isSupersededMetadataUpdate(conversationKey, position) {
  const applied = await lastAppliedMetadataUpdate(conversationKey);
  if (!applied || isLaterPosition(position, applied)) return false;
  console.log(
    `  Metadata update for ${conversationKey} at block ${position.blockNumber}, log ${position.logIndex} is not newer than the one applied (block ${applied.blockNumber}, log ${applied.logIndex}); skipped.`,
  );
  return true;
}

/**
 * Records the update just applied. Never throws: its transaction has landed, and a throw would
 * send the event to the retry queue and submit it again. A record that fails is kept for this
 * process, printed and reported.
 */
async function recordAppliedMetadataUpdate(conversationKey, position) {
  const inProcess = metadataAppliedInProcess.get(conversationKey);
  if (!inProcess || isLaterPosition(position, inProcess)) {
    metadataAppliedInProcess.set(conversationKey, position);
  }
  try {
    await stateStore.recordMetadataUpdate({ conversationId: conversationKey, ...position });
  } catch (error) {
    console.error(
      `  Could not record the metadata update applied for conversation ${conversationKey}; it is kept for this process only: ${describeError(error)}`,
    );
    Sentry.captureException(error, { tags: { site: "metadata_order_record" } });
  }
}

/**
 * A rename or delete of a conversation: writes the new metadata file and submits its CID.
 *
 * Updates of one conversation are applied in the order the chain emitted them (block, then log
 * index). Within the process they take turns (`takeMetadataTurn` in enqueueEventWork); across a
 * retry or a restart, an update at or before the newest one applied for the conversation (the
 * state store's record) is skipped before anything is uploaded, and checked again inside the
 * transaction lock. A skip needs nothing on chain: the fee was paid to the treasury when the
 * update was requested, and nothing is held for it.
 */
async function handleMetadataUpdate(user, conversationId, payload, roflEncryptedKey, event) {
  console.log(
    `[EVENT] Processing MetadataUpdateRequested for convId: ${conversationId} in block ${event.blockNumber}`,
  );
  try {
    const conversationKey = conversationId.toString();
    const position = chainPositionOf(event);
    if (await isSupersededMetadataUpdate(conversationKey, position)) return;

    const sessionKey = await getSessionKey(payload, roflEncryptedKey, conversationKey);

    const decryptedData = isSapphire
      ? payload
      : decryptSymmetrically(ethers.toUtf8String(payload), sessionKey);

    const clientPayload = validatePayload(decryptedData, "MetadataUpdateRequested");

    const { title, isDeleted } = clientPayload; // Explicitly destructured for clarity

    const now = Date.now();

    const conversationMetadataFile = createConversationMetadataFile({
      title,
      isDeleted,
      lastUpdatedAt: now,
    });
    const encryptedMeta = encryptSymmetrically(conversationMetadataFile, sessionKey);

    const metadataCID = await uploadData(Buffer.from(encryptedMeta));

    await txMutex.runExclusive(async () => {
      // Again here, where no other submission of this process runs: the record is what decides.
      if (await isSupersededMetadataUpdate(conversationKey, position)) return;

      console.log(`  Submitting metadata update for ${conversationId}...`);

      const tx = await contract.submitConversationMetadata(conversationId, metadataCID);

      const receipt = await tx.wait();
      console.log(
        `  ✅ Success! Metadata updated for conversation ${conversationId}. Tx: ${receipt.hash}`,
      );

      await recordAppliedMetadataUpdate(conversationKey, position);
    });
  } catch (error) {
    console.error(
      `Error in handleMetadataUpdate for convId ${conversationId}:`,
      describedError(error),
    );

    throw error;
  }
}

// --- Main Service Logic ---

/**
 * Ensures this oracle's address holds the oracle role on the agent contract.
 * Several oracles can hold the role at once, so this never displaces another oracle.
 * For Sapphire, the oracle registers itself with a TEE-signed transaction.
 * For EVM, only the contract owner can add an oracle: this pages them and marks the role
 * missing, which holds all answering until they have.
 */
async function ensureOracleAuthorized() {
  if (await contract.isOracle(signer.address)) {
    console.log(`Oracle address is authorized: ${signer.address}`);
    return;
  }
  console.log(`Oracle address ${signer.address} does not hold the oracle role yet`);

  if (!isSapphire) {
    // On EVM only the contract owner can grant the role. Exiting here would only make the
    // platform restart the oracle into the same state. So: one page now, and start-up carries
    // on — the heartbeat begins, and every step that would answer a prompt waits at the role
    // gate until the owner has called addOracle.
    oracleRole.markLost();
    return;
  }

  try {
    const isLocalnet = NETWORK_NAME === "sapphire-localnet";

    if (isLocalnet) {
      // On localnet, we can send a direct transaction as we control the TEE simulation.
      const tx = await contract.addOracle(signer.address, { gasLimit: 1000000 });

      await tx.wait();
    } else {
      // On testnet/mainnet, the transaction must be signed by the ROFL TEE.
      console.log("Populating addOracle transaction...");
      const txUnsigned = await contract.addOracle.populateTransaction(signer.address);

      const txParams = {
        to: AI_AGENT_CONTRACT_ADDRESS,
        gas: 2000000, // addOracle is a simple transaction, a fixed high limit is safe
        value: 0,
        data: txUnsigned.data,
      };

      const txHash = await submitTx(txParams);
      console.log(`addOracle transaction submitted: ${txHash}`);
    }

    console.log(`Successfully registered oracle address ${signer.address}`);
  } catch (err) {
    const errorMessage = `FATAL: Failed to confirm oracle authorization for ${signer.address}. Error: ${describeError(err)}`;

    await sendAlert("CRITICAL: Oracle Setup Failed", errorMessage);

    throw new Error(errorMessage); // Halt the oracle if it can't verify its identity.
  }
}

/**
 * Was this submission refused because the oracle does not hold its role?
 *
 * Two shapes reach here. A revert caught at gas estimation carries the custom error's selector
 * as its revert data. A revert that only happens once the transaction is mined (the role was
 * removed in between) carries a receipt and no reason at all, so the chain has to be asked.
 * Either way the answer is confirmed with `isOracle` before the role is treated as lost: only
 * decoded revert data counts, never the transaction's own calldata or the error text.
 *
 * @returns {Promise<{ refused: boolean, lost: boolean }>} `refused`: the revert data names
 *   UnauthorizedOracle. `lost`: the chain confirms the role is not held right now.
 */
async function lostOracleRole(error) {
  let selector = null;
  try {
    selector = contract.interface.getError("UnauthorizedOracle")?.selector ?? null;
  } catch {
    selector = null;
  }

  const candidate = error?.data ?? error?.info?.error?.data;
  const revertData = typeof candidate === "string" && candidate.length > 2 ? candidate : null;
  const refused = Boolean(selector && revertData && revertData.startsWith(selector));
  const revertedWithoutReason =
    !revertData && error?.code === "CALL_EXCEPTION" && Boolean(error?.receipt);
  if (!refused && !revertedWithoutReason) return { refused: false, lost: false };

  try {
    return { refused, lost: !(await contract.isOracle(signer.address)) };
  } catch (checkError) {
    console.warn(
      `[OracleRole] Could not confirm the oracle role after a refused submission: ${describeError(checkError)}`,
    );
    return { refused, lost: false };
  }
}

/**
 * A wrapper for event handlers that distinguishes between retryable and fatal errors.
 * Retryable errors are saved to a queue for later processing.
 *
 * It never saves the chain cursor. Up to five of these run at once and finish out of order, so a
 * save from here could move the cursor past an earlier event that is still being answered; a
 * crash would then resume after it. The scan loops save the cursor once the whole batch is done.
 * @param {string} eventName - The name of the event being processed.
 * @param {Function} handler - The async event handler function to execute.
 * @param  {...any} args - The arguments passed by the ethers.js event listener.
 */
async function handleAndRecord(eventName, handler, ...args) {
  const event = args[args.length - 1];

  // An event already in the queue when the role was lost waits here, before any model or
  // storage credit is spent on an answer that could not be submitted.
  await oracleRole.ready();

  try {
    const eventTimestamp = (await event.getBlock()).timestamp;

    const nowTimestamp = Math.floor(Date.now() / 1000);
    const lagInSeconds = nowTimestamp - eventTimestamp;
    // In seconds because block timestamps are whole seconds: no finer figure exists.
    console.log(`[Lag] ${eventName} block=${event.blockNumber} block_to_start_s=${lagInSeconds}`);
    const lagThreshold = 300; // 5 minutes

    if (lagInSeconds > lagThreshold) {
      await sendAlert(
        "High Oracle Processing Lag Detected",
        `The oracle is currently processing events that are over ${Math.floor(lagInSeconds / 60)} minutes old. The system is under heavy load and may not be keeping up. Consider deploying additional oracle instances to handle the demand.`,
      );
    }

    await handler(...args);
  } catch (error) {
    // 1. MALICIOUS / BAD INPUT ERRORS (Drop silently or log warning, DO NOT RETRY)
    // Membership is by TYPE now, not by message text: payloadValidator raises BadInputError on a
    // schema mismatch, and so do the two payload parses. Nothing else qualifies, which is the
    // point — a transient failure whose message merely reads like a parse error is retried.
    if (isBadInputError(error)) {
      console.warn(
        `[Security] Dropping malformed/invalid payload for ${eventName} in block ${event.blockNumber}. Error: ${describeError(error)}`,
      );
      // We do NOT throw, we do NOT alert, we do NOT queue for retry.
      return;
    }

    // 2. RETRYABLE ERRORS (Network, API limits)
    // By TYPE first: the layer that knows a failure is transient (the storage wrapper, after its
    // own retries) throws RetryableError. The substring chain below is the legacy fallback for
    // paths that still throw raw errors — it is not the contract, and it missed the Autonomys
    // SDK's `Failed to upload file chunk: Service Unavailable` on 2026-11-09 (#108).
    // A submission refused for want of the oracle role is not the event's fault and not final:
    // the event waits in the queue, and the role gate holds further work until the role is back.
    // Refused but the role is already back (a grant landed in between): simply retried.
    const role = await lostOracleRole(error);
    if (role.lost) oracleRole.markLost(error);

    // A request to the chain provider that got no answer (refused, timed out, unreachable) is
    // the same: any read made while handling the event can fail that way.
    const isRetryable =
      role.lost ||
      role.refused ||
      isRetryableError(error) ||
      isTransientProviderError(error) ||
      error.message.includes("Irys") ||
      error.message.includes("fetch") ||
      error.message.includes("insufficient funds") ||
      error.message.includes("Autonomys") ||
      error.message.includes("Bad Gateway") ||
      error.message.includes("502") ||
      error.message.includes("503") ||
      error.message.includes("ETIMEDOUT");

    if (isRetryable) {
      console.warn(
        `Encountered a retryable error for ${eventName}. Adding to retry queue. Error: ${describeError(error)}`,
      );

      // A pointer to the event, not a copy of it: the retry re-reads the receipt. Queuing the same
      // event twice (a catch-up scan meeting it again) is a no-op.
      const queued = await stateStore.enqueueFailedJob({
        transactionHash: event.transactionHash,
        logIndex: event.index,
        eventName,
        blockNumber: event.blockNumber,
        delayMs: BASE_RETRY_DELAY_MS,
      });
      if (!queued) {
        console.warn(
          `${eventName} in tx ${event.transactionHash} is already in the retry queue (waiting, or given up on); not queued again.`,
        );
      }

      // If that enqueue throws, the error leaves this function on purpose: the event is neither
      // answered nor queued, so the scan that owns the batch must fail and meet it again.
    } else {
      // Described, and the raw error not printed: its message can carry a request address.
      const alertMessage = `Encountered a FATAL, non-retryable error for event '${eventName}' in block ${event.blockNumber}. Manual intervention required. Error: ${describeError(error)}`;
      console.error(alertMessage, describedError(error));

      Sentry.captureException(error, {
        tags: { site: "handle_and_record_fatal", eventName, blockNumber: event.blockNumber },
      });
      await sendAlert("CRITICAL: Oracle Fatal Error", alertMessage);
    }
  }
}

/**
 * Re-read a failed job's event from its transaction receipt — the chain is the source of truth,
 * the queue only holds a pointer — and shape it like the events the poll loop hands to handlers.
 */
async function loadEventForRetry(job) {
  const receipt = await provider.getTransactionReceipt(job.transactionHash);

  if (!receipt) {
    throw new Error(`Could not find transaction receipt for hash ${job.transactionHash}`);
  }

  // Every log of this contract in the transaction that parses as the event we are after.
  const contractAddress = contract.target.toLowerCase();
  const candidates = [];
  let parseError = null;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== contractAddress) continue;
    try {
      const parsed = contract.interface.parseLog(log);
      if (parsed && parsed.name === job.eventName) candidates.push({ log, parsed });
    } catch (e) {
      parseError = e;
    }
  }

  // The stored log index is the log's position in its BLOCK, so it pins the event exactly — until
  // a reorg re-includes the transaction somewhere else and every position shifts. Then the name
  // decides, as long as it is not ambiguous.
  let match = candidates.find(({ log }) => log.index === job.logIndex);
  if (!match && candidates.length === 1) {
    [match] = candidates;
  }
  if (!match && candidates.length > 1) {
    throw new Error(
      `Transaction ${job.transactionHash} has more than one '${job.eventName}' event and none at the stored log position ${job.logIndex}; refusing to guess which to retry.`,
    );
  }
  if (!match) {
    throw new Error(
      `Could not re-parse event '${job.eventName}' from transaction receipt.${parseError ? ` Parse error: ${describeError(parseError)}` : ""}`,
      parseError ? { cause: parseError } : undefined,
    );
  }

  return {
    args: match.parsed.args,
    transactionHash: job.transactionHash,
    index: match.log.index,
    blockNumber: receipt.blockNumber,
    getBlock: () => provider.getBlock(receipt.blockNumber),
  };
}

const RETRY_HANDLERS = {
  PromptSubmitted: (...args) => handlePrompt(...args),
  RegenerationRequested: (...args) => handleRegeneration(...args),
  BranchRequested: (...args) => handleBranch(...args),
  MetadataUpdateRequested: (...args) => handleMetadataUpdate(...args),
};

/** Retry one claimed job and record what happened to it. Never throws. */
async function retryClaimedJob(job) {
  console.log(`[Retry] Retrying job for event: ${job.eventName} from block ${job.blockNumber}`);
  try {
    const handler = RETRY_HANDLERS[job.eventName];
    if (!handler) {
      throw new Error(`No handler for event '${job.eventName}'.`);
    }

    const event = await loadEventForRetry(job);

    // Nothing can be submitted without the role, so the work is not started without it.
    await oracleRole.ready();

    // Retries share the concurrency queue with fresh events.
    await enqueueEventWork(job.eventName, event.args, () => handler(...event.args, event));
  } catch (error) {
    const role = await lostOracleRole(error);
    if (role.lost || role.refused) {
      // Not an attempt at the job: the oracle was refused for want of its role, which says
      // nothing about the job. It keeps its lease and is offered again afterwards, attempts
      // untouched, so neither a long wait for the role nor a role that comes and goes can walk
      // it to "failed permanently".
      if (role.lost) oracleRole.markLost(error);
      console.warn(
        `[Retry] ${job.eventName} (tx ${job.transactionHash}) was refused for want of the oracle role; not counted as a failed attempt.`,
      );
      return;
    }
    await recordFailedRetry(job, error);
    return;
  }

  // Outside the try above on purpose: the retry WORKED. If only the bookkeeping fails, counting
  // it as a failed attempt would walk an answered job towards a false "failed permanently".
  try {
    await stateStore.completeJob(job.id);
    console.log(`[Retry] Job succeeded and was removed from the queue.`);
  } catch (storeError) {
    // The job keeps its lease and is offered again when that runs out; the handler's own
    // already-answered check then makes that pass a cheap no-op.
    console.error(
      `[Retry] ${job.eventName} (tx ${job.transactionHash}) was retried successfully but could not be removed from the queue: ${describeError(storeError)}`,
    );
    Sentry.captureException(storeError, {
      tags: { site: "retry_complete_failed", eventName: job.eventName },
    });
  }
}

async function recordFailedRetry(job, error) {
  const attempt = job.attempts + 1;
  console.error(
    `[Retry] Attempt #${attempt} failed for event ${job.eventName}. Error: ${describeError(error)}`,
  );

  try {
    if (attempt >= MAX_RETRIES) {
      await stateStore.exhaustJob(job.id, { error });
      Sentry.captureException(error, {
        tags: {
          site: "retry_permanent_failure",
          eventName: job.eventName,
          blockNumber: job.blockNumber,
        },
      });
      await sendAlert(
        "CRITICAL: Job Failed Permanently",
        `A job for event ${job.eventName} from block ${job.blockNumber} (tx ${job.transactionHash}) has failed all ${MAX_RETRIES} retries and will not be retried again. It stays on record as exhausted. Manual intervention required. Final error: ${describeError(error)}`,
      );
    } else {
      const delayMs = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
      await stateStore.rescheduleJob(job.id, { delayMs, error });
    }
  } catch (storeError) {
    // The outcome could not be recorded. The job keeps its lease and comes back when that runs
    // out, with this attempt uncounted — a retry too many, never a job lost.
    console.error(
      `[Retry] Could not record the failed attempt for ${job.eventName} (tx ${job.transactionHash}): ${describeError(storeError)}`,
    );
    Sentry.captureException(storeError, {
      tags: { site: "retry_record_failed", eventName: job.eventName },
    });
  }
}

// The timer fires every RETRY_INTERVAL_MS; a pass can take longer than that.
let retryPassInFlight = false;

/**
 * Periodically retries failed jobs from the state store, with exponential backoff.
 *
 * Jobs are CLAIMED one at a time, each leased for RETRY_LEASE_MS from the moment its own retry
 * starts, and passes never overlap — so a slow retry is not started a second time by the next
 * tick or by another oracle. Then exactly one of three things happens to a job: it worked and is
 * removed; it failed and is rescheduled; it failed for the last time and is kept on record as
 * exhausted, with an alert.
 */
async function retryFailedJobs() {
  if (retryPassInFlight) return;
  retryPassInFlight = true;
  try {
    for (let handled = 0; handled < RETRY_BATCH_LIMIT; handled++) {
      // Nothing can be submitted without the role, so nothing is claimed until it is back.
      await oracleRole.ready();

      let job;
      try {
        [job] = await stateStore.claimDueJobs({ limit: 1, leaseMs: RETRY_LEASE_MS });
        retryQueueOutage.success();
      } catch (error) {
        // The queue cannot be read right now. The jobs are still there; the next tick tries
        // again, and a failure that lasts is alerted once.
        console.error(`[Retry] Could not read the failed-job queue: ${describeError(error)}`);
        retryQueueOutage.failure(error);
        return;
      }

      if (!job) return;
      await retryClaimedJob(job);
    }
  } finally {
    retryPassInFlight = false;
  }
}

/**
 * Wait for EVERY task of a batch, then fail if any of them failed.
 *
 * Not Promise.all: that rejects on the first failure while the other events are still being
 * answered, and the caller would rescan the range and start each of them a second time.
 */
async function settleBatch(tasks) {
  const results = await Promise.allSettled(tasks);
  const failures = results.filter((result) => result.status === "rejected");
  // The caller gets the first failure; the others must not vanish with it.
  for (const { reason } of failures.slice(1)) {
    console.error(`[Batch] Another event of the same batch also failed: ${describeError(reason)}`);
    Sentry.captureException(reason, { tags: { site: "settle_batch_secondary" } });
  }
  if (failures.length > 0) throw failures[0].reason;
}

/**
 * Scans for and processes any events that were missed while the oracle was offline.
 * Uses batching to respect RPC limits on block ranges.
 * @param {number} fromBlock - The block number to start scanning from.
 * @param {number} toBlock - The latest block number to scan up to.
 */
async function processPastEvents(fromBlock, toBlock) {
  if (fromBlock > toBlock) {
    return;
  }
  console.log(`Catching up on missed events from block ${fromBlock} to ${toBlock}...`);

  // BATCHING CONFIGURATION
  // The widest block range one log query may cover. Providers differ widely (some free tiers
  // allow as few as 5 or 10 blocks), so set EVENT_BATCH_SIZE to the endpoint's limit.
  const BATCH_SIZE = positiveIntFromEnv("EVENT_BATCH_SIZE", DEFAULT_EVENT_BATCH_SIZE);

  let currentStart = fromBlock;

  while (currentStart <= toBlock) {
    // Without the role nothing can be submitted: hold the catch-up until it is back.
    await oracleRole.ready();

    const currentEnd = Math.min(currentStart + BATCH_SIZE - 1, toBlock);

    console.log(`  -> Scanning batch: ${currentStart} to ${currentEnd}`);

    try {
      // One query for all four event types, already in chain order.
      const allEvents = await queryOracleWorkEvents(contract, currentStart, currentEnd, {
        onUndecodable: reportUndecodableLog,
      });

      if (allEvents.length > 0) {
        console.log(`     Found ${allEvents.length} events in batch. Queueing...`);

        const tasks = allEvents.map((event) => enqueueEvent(event));

        // Wait for ALL tasks in this batch to complete before updating state.
        // This ensures if the process crashes, we re-process this batch rather than skipping it.
        await settleBatch(tasks);
      }

      // Update checkpoint after every successful batch to avoid re-processing
      await persistCursor(currentEnd);

      // Move window forward
      currentStart = currentEnd + 1;

      // Optional: Small delay to be nice to the RPC
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (error) {
      // Described, and the raw error not printed: a provider error carries the request address.
      const alertMessage = `Failed during historical event catch-up process between blocks ${currentStart}-${currentEnd}. The oracle may need intervention. Error: ${describeError(error)}`;
      console.error(alertMessage);

      // Critical failure in catch-up stops the oracle startup
      await sendAlert("Oracle Catch-up Failed", alertMessage);

      // Thrown to stop the oracle from starting in a potentially broken state. start() rejects
      // with it and index.js prints it, reports it and exits, so it is the described error.
      throw describedError(error);
    }
  }

  console.log("Catch-up complete.");
}

// The widest block range of one log query when EVENT_BATCH_SIZE is unset.
const DEFAULT_EVENT_BATCH_SIZE = 2000;

/**
 * A positive whole number from the environment, or the default when unset. Start-up validation
 * (startupConfig.js) has already refused a set value that is not one.
 */
function positiveIntFromEnv(name, fallback) {
  const value = Number(process.env[name]);

  return Number.isInteger(value) && value > 0 ? value : fallback;
}

const EVENT_HANDLERS = {
  PromptSubmitted: handlePrompt,
  RegenerationRequested: handleRegeneration,
  BranchRequested: handleBranch,
  MetadataUpdateRequested: handleMetadataUpdate,
};

// The filter asks for ORACLE_WORK_EVENTS; an event with no handler here would be fetched and
// then ignored, so the two lists must name the same events.
if (
  ORACLE_WORK_EVENTS.length !== Object.keys(EVENT_HANDLERS).length ||
  !ORACLE_WORK_EVENTS.every((name) => typeof EVENT_HANDLERS[name] === "function")
) {
  throw new Error("aiAgentOracle: every oracle-work event needs exactly one handler");
}

/**
 * A log matched the oracle-work filter but the ABI could not decode it: a paid request this
 * oracle will not answer. The cursor moves on, so page someone. Fire-and-forget.
 */
function reportUndecodableLog(log) {
  const where = `block ${log.blockNumber}, tx ${log.transactionHash}, log ${log.index}`;
  Sentry.captureMessage(`Undecodable oracle-work log (${where})`, {
    level: "error",
    tags: { site: "undecodable_log" },
  });
  sendAlert(
    "Oracle: an event could not be decoded and was skipped",
    `A log at ${where} matched the oracle's event filter but could not be decoded with the ABI in this build, so it was not answered. The contract's ABI and this image are probably out of step. The user is refunded only by the one-hour timeout.`,
  ).catch((err) => console.error("sendAlert (undecodable log) failed:", describeError(err)));
}

/**
 * Hands an event's work to the work queue. A prompt or a regeneration first waits for its
 * conversation's turn (takeRoomTurn), outside the queue: the prompts of one conversation are
 * answered one at a time, so the ones waiting would otherwise each hold a place in the queue that
 * another owner's prompt could use. A metadata update waits for its conversation's metadata turn
 * (takeMetadataTurn) the same way, so one conversation's updates are applied one at a time and in
 * the order they are handed in here, which is the chain's order for the events of a scan; it does
 * not wait for the conversation's prompts, since it does not use the room. Gives back what the work
 * gives.
 *
 * @param {string} eventName
 * @param {ArrayLike<unknown>} args The event's arguments.
 * @param {() => Promise<unknown>} work
 */
async function enqueueEventWork(eventName, args, work) {
  if (eventName === "MetadataUpdateRequested") {
    // (user, conversationId, …), which the contract tests pin.
    return takeMetadataTurn(String(args[1]), () => queue.add(work));
  }
  if (!ROOM_EVENTS.has(eventName)) return queue.add(work);
  // Both events start with the conversation's owner and then its id, which the contract tests pin.
  const [owner, conversationId] = args;
  let roomId;
  try {
    ({ roomId } = await conversationRoomOf(String(conversationId), owner));
  } catch {
    // No room can be named for it: its handler meets the same and fails its own way.
    return queue.add(work);
  }
  return takeRoomTurn(roomId, () => queue.add(work));
}

/** enqueueEventWork for an event read from the chain. */
function enqueueEvent(event) {
  return enqueueEventWork(event.eventName, event.args, () => dispatchEvent(event));
}

/**
 * Hand one oracle-work event to its handler.
 * @param {import("ethers").EventLog} event
 */
async function dispatchEvent(event) {
  const handler = EVENT_HANDLERS[event.eventName];
  if (!handler) {
    console.warn(`Unknown event encountered: ${event.eventName}`);

    return;
  }

  await handleAndRecord(event.eventName, handler, ...event.args, event);
}

/**
 * Continuously polls the blockchain for new events in specific block ranges.
 * Saves the cursor after every pass so progress survives periods of inactivity.
 *
 * The pass itself is in eventPoller.js; this is the loop around it. A pass never throws: a
 * failure comes back as a longer wait.
 * @param {number} startBlock - The block to start polling from.
 */
async function pollEvents(startBlock) {
  console.log(`✅ Oracle is running and listening for new events from block ${startBlock}.`);

  const poller = createRangePoller({
    startBlock,
    // The same range limit as the catch-up, to respect the provider's eth_getLogs block range.
    batchSize: positiveIntFromEnv("EVENT_BATCH_SIZE", DEFAULT_EVENT_BATCH_SIZE),
    getHead: () => provider.getBlockNumber(),
    roleReady: () => oracleRole.ready(),
    queryEvents: (fromBlock, toBlock) =>
      queryOracleWorkEvents(contract, fromBlock, toBlock, { onUndecodable: reportUndecodableLog }),
    handleEvent: (event) => enqueueEvent(event),
    settle: settleBatch,
    persistCursor,
    rewindCursor,
    // Page on-call: a reorg on a real chain is as operationally significant as the
    // processing-lag/fatal alerts already routed through sendAlert. Fire-and-forget so an
    // alert failure can't stall the rewind (a localnet evm_revert takes the same path).
    onReorg: ({ head, cursor, rewoundTo }) => {
      sendAlert(
        "Chain reorg detected — oracle cursor rewound",
        `Head ${head} dropped below cursor ${cursor}. Rewound to ${rewoundTo}; re-mined events will be re-processed.`,
      ).catch((err) => console.error("sendAlert (reorg) failed:", describeError(err)));
    },
    outage: pollLoopOutage,
    backoff: createPollBackoff({
      baseMs: positiveIntFromEnv("POLL_INTERVAL_MS", DEFAULT_POLL_INTERVAL_MS),
      capMs: positiveIntFromEnv("POLL_BACKOFF_CAP_MS", DEFAULT_POLL_BACKOFF_CAP_MS),
    }),
  });

  while (true) {
    const waitMs = await poller.tick();
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

/**
 * The entry point for the oracle service.
 */
async function start() {
  console.log("--- INITIALIZING ORACLE SERVICE ---");

  // NO validateConfig() HERE — deliberately. index.js is the enforced entry point and validates
  // before anything else.
  //
  // A second call here would be actively wrong. start() is async, so a ConfigError thrown
  // in it becomes a rejected promise, lands in index.js's unhandledRejection handler, and files
  // a Sentry incident — exactly what index.js's ConfigError-specific catch exists to prevent.
  // Unreachable in production (index.js has already exited), but reachable from tests and from
  // any wrapper importing start() directly.

  // BEFORE anything that can serve a prompt. Resolves the Brain's fence strip once and throws if it
  // cannot, so a stale submodule or a partial dist stops the process here rather than letting prompts
  // through unstripped with one log line as the only signal — the same call aiAgentOracle already
  // makes for degraded market context.
  await initInboundPrompt();

  // The Brain's sanitiser, loaded now so the first prompt's thoughts do not wait on the import
  // and time out. Not awaited, and it never rejects: a failed load is logged by kind and the
  // oracle starts all the same (thoughts are then dropped and counted).
  void warmThoughtSanitizer();

  // Initialize the connection to the decentralised storage provider.
  await initializeStorage();

  // Initialize the AI model interface.
  await initializeEliza();

  // If the RPC can say which chain it is on right now, a wrong one stops the start here,
  // before the role is read on it. If it cannot, start-up goes on as in any outage: the role
  // read below only reads, and the check that must pass is made after it, where the chain id
  // is needed and must be had.
  if (expectedChainId !== undefined) {
    const network = await provider.getNetwork().catch(() => null);
    if (network) assertChainOfKeys(network.chainId);
  }

  // Ensure the on-chain oracle address is correctly set to this wallet.
  await ensureOracleAuthorized();

  // From here on the cursor and the failed-job queue live in the oracle's own database when it
  // has one. initializeEliza() above has already run the migration that creates the tables,
  // against this same url.
  const { chainId } = await provider.getNetwork();
  assertChainOfKeys(chainId);
  deploymentChainId = chainId;
  ({ store: stateStore } = createStateStore({
    postgresUrl: agentStateDbUrl,
    chainId,
    contractAddress: contract.target,
    statePath: STATE_FILE_PATH,
    jobsPath: FAILED_JOBS_FILE_PATH,
    metadataPath: METADATA_UPDATES_FILE_PATH,
  }));
  console.log(`[OracleState] Cursor and failed jobs are kept in: ${stateStore.backend}.`);

  // Liveness beat. Standalone and entirely off the prompt path — core reads the newest
  // `kind: "heartbeat"` row and checks its AGE, which is what distinguishes a silent oracle from
  // a healthy-but-idle one. Awaited only to resolve the Brain handles; the chain itself is
  // self-rescheduling and unref'd, so it neither blocks boot nor holds the process open.
  //
  // Not assigned to anything: nothing in this process stops the oracle short of exit, and the
  // returned handle exists for tests. Disk is measured where oracle-state.json actually lives —
  // the volume this process writes to — rather than core's dead PGLITE_DATA_DIR.
  //
  // Started before the first step that can wait for the oracle role: the beat is what tells a
  // waiting oracle from a dead one.
  await startOracleHeartbeat({
    provider,
    walletAddress: signer.address,
    queue,
    getLastProcessedBlock,
    countFailedJobs,
    fetchAccountInfo: () => require("./storage/autonomys").fetchAccountInfo(),
    mirrorSnapshot: () => require("./storage/mirror").snapshot(),
    observeToolServers: () => toolServerWatch.observe(),
    streamSnapshot: () => streamHeartbeatSnapshot(),
    diskPath: path.dirname(STATE_FILE_PATH),
  });

  // Where to resume from is settled here, before the first step that can wait for the oracle
  // role. Measured after a wait, the look-back would start at the head as it is then, and
  // prompts submitted earlier in a wait longer than the look-back would be skipped.
  const resume = await resolveResumeCursor({
    store: stateStore,
    onUnavailable: async (error) => {
      console.error(`[OracleState] Could not read the stored cursor: ${describeError(error)}`);
      Sentry.captureException(error, { tags: { site: "cursor_read_failed" } });
      await sendAlert(
        "Oracle could not read its stored cursor",
        `The oracle started but could not read where it left off (${describeError(error)}). It is resuming from a recent-block lookback, so prompts submitted before that window and not yet answered will be missed until they are refunded. Check the oracle_agent database.`,
      );
    },
  });
  if (resume.source === "none") {
    // Normal on the very first start. On Postgres any later occurrence means the cursor row is
    // gone, so it is a warning there: the lookback below can skip prompts.
    const log = stateStore.backend === "postgres" ? console.warn : console.log;
    log("No stored cursor found. Will start processing from a recent block.");
  }

  const bootBlock = await provider.getBlockNumber();
  // With no stored cursor, look back 1,800 blocks (about six minutes on Base's 200 ms blocks).
  // Otherwise, start from the next block after the last processed one.
  const lookback = 1800;
  let resumeCursor = resume.cursor;
  if (resumeCursor !== null && resumeCursor > bootBlock) {
    // The stored block does not exist (a reverted local chain, an RPC that lags). The store only
    // moves forward, so it would refuse every save until the head caught up while memory claimed
    // the head — and a restart in between would skip the difference.
    console.warn(
      `[OracleState] Stored cursor ${resumeCursor} is ahead of chain head ${bootBlock}; rewinding to the head.`,
    );
    resumeCursor = bootBlock;
    await rewindCursor(resumeCursor);
  }
  const fromBlock = resumeCursor === null ? Math.max(0, bootBlock - lookback) : resumeCursor + 1;
  if (resume.source === "none" && fromBlock > 0) {
    // Stored now, so a restart during a wait resumes from this same block instead of measuring
    // a new look-back from a later head. Not when the cursor could not be read: one may exist,
    // and a restart that can read it must find it as it was. Not at block 0 either (a chain
    // younger than the look-back): there is no earlier block to store.
    await persistCursor(fromBlock - 1);
  }

  // Process any failed jobs from previous runs before catching up on past events.
  await retryFailedJobs();

  // The head as it is after that first wait, which can have lasted any length of time. Blocks
  // added during a further wait inside the catch-up scan are picked up by the poll loop, which
  // reads the head again.
  const latestBlock = await provider.getBlockNumber();

  // 1. Catch Up Phase
  // Note: processPastEvents stores the cursor as it goes.
  await processPastEvents(fromBlock, latestBlock);

  // Ensure state is synced to latest before starting poll (redundant safety save)
  await persistCursor(latestBlock);

  // Start background retry mechanism
  setInterval(retryFailedJobs, RETRY_INTERVAL_MS);

  // 2. Listening Phase — fire-and-forget; the infinite poll loop never resolves
  pollEvents(latestBlock).catch((err) => {
    console.error("Fatal polling loop error:", describedError(err));
    process.exit(1);
  });
}

module.exports = {
  countFailedJobs,
  getLastProcessedBlock,
  persistCursor,
  rewindCursor,
  start,
  queryElizaOS,
  configure,
  initForTest,
  // Expose internal functions for testing purposes
  handlePrompt,
  handleRegeneration,
  handleBranch,
  handleMetadataUpdate,
  queryAIModel,
  reconstructHistory,
  parseMockDelayMs,
  hasMockDropSentinel,
  hasMockReasoningSentinel,
  parseMockStepMs,
  hasMockRerunSentinel,
  setStreamSink,
  streamHeartbeatSnapshot,
  flushStreamsForTest,
  shouldInitializeConversation,
  getSessionKey,
  encryptSymmetrically,
  decryptSymmetrically,
  handleAndRecord,
  ensureOracleAuthorized,
  processPastEvents,
  retryFailedJobs,
  enqueueEventWork,
  wireAgentDbForPluginSql,
};
