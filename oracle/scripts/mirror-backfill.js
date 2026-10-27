#!/usr/bin/env node
/**
 * Backfill the GCS payload mirror with every Autonomys CID that pre-dates write-through
 * mirroring (CU-14ym9bvm1d4).
 *
 * The subgraph is the index of every CID the dApp will ever ask for (conversationCID,
 * conversationMetadataCID, messageCID, searchDeltaCID). Auto Drive is the source of the bytes
 * AND of the original file name — the name is part of the Auto Drive CID, and the dApp needs it
 * (served as object metadata `name`) to recompute and verify the CID from mirrored bytes. A CID
 * whose name cannot be recovered is reported and NOT mirrored: an unverifiable object costs the
 * dApp a wasted round trip on every read, which is worse than falling straight through to the
 * gateway.
 *
 * Resumable by construction: a CID the bucket already serves (HEAD 200) is skipped before
 * Auto Drive is touched, and the mirror write itself is `ifGenerationMatch=0`, so two runs
 * racing on the same CID cannot corrupt anything. Re-run until `pending`/`failed` are zero.
 *
 * Usage (from oracle/; reads the same env the oracle runs with):
 *   ENV_FILE=.env.oracle.base-testnet SUBGRAPH_URL=https://… node scripts/mirror-backfill.js --dry-run
 *   ENV_FILE=.env.oracle.base-testnet SUBGRAPH_URL=https://… node scripts/mirror-backfill.js
 *
 * Env: SUBGRAPH_URL (required), PAYLOAD_MIRROR_BUCKET, PAYLOAD_MIRROR_SA_KEY, AUTONOMYS_API_KEY.
 * Flags: --dry-run (report only), --page-size N (subgraph page, default 100),
 *        --concurrency N (parallel CIDs, default 4).
 *
 * Exit codes: 0 = nothing left to mirror; 1 = some CIDs failed (re-run); 2 = bad invocation.
 */

const path = require("node:path");

const AUTO_DRIVE_CID = /^bafkr6i[a-z2-7]{52}$/;
const PUBLIC_OBJECT_BASE = "https://storage.googleapis.com";
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_CONCURRENCY = 4;
/** `messages` is a derived list; without an explicit `first` The Graph silently caps it at 100. */
const MESSAGES_PER_CONVERSATION = 1000;

const PAGE_QUERY = `
  query MirrorBackfillPage($lastId: ID!, $first: Int!, $messagesFirst: Int!) {
    conversations(where: { id_gt: $lastId }, orderBy: id, orderDirection: asc, first: $first) {
      id
      conversationCID
      conversationMetadataCID
      messages(first: $messagesFirst) {
        messageCID
        searchDelta {
          searchDeltaCID
        }
      }
    }
  }
`;

/** Every Auto Drive CID a page of conversations points at, deduplicated, first-seen order. */
function collectCids(conversations) {
  const seen = new Set();
  const add = (cid) => {
    if (typeof cid === "string" && AUTO_DRIVE_CID.test(cid) && !seen.has(cid)) seen.add(cid);
  };

  for (const conversation of conversations || []) {
    add(conversation.conversationCID);
    add(conversation.conversationMetadataCID);
    for (const message of conversation.messages || []) {
      add(message.messageCID);
      add(message.searchDelta && message.searchDelta.searchDeltaCID);
    }
  }

  return [...seen];
}

/**
 * Mirror one CID. Resolves (never rejects) with { status, reason? } where status is one of
 * `present` (already in the bucket), `pending` (dry run; would mirror), `created`, `exists`,
 * or `failed`.
 */
async function backfillCid(cid, deps) {
  const { bucket, env, headImpl, lookupName, download, mirror, dryRun } = deps;

  try {
    const head = await headImpl(`${PUBLIC_OBJECT_BASE}/${bucket}/${cid}`, { method: "HEAD" });
    if (head.status === 200) return { status: "present" };
    if (dryRun) return { status: "pending" };

    const fileName = await lookupName(cid);
    if (!fileName) {
      return { status: "failed", reason: "Auto Drive file name not found — cannot be verified" };
    }

    const bytes = await download(cid);
    const result = await mirror(cid, bytes, fileName, { env });

    return result.status === "failed" ? result : { status: result.status };
  } catch (error) {
    return { status: "failed", reason: error && error.message ? error.message : String(error) };
  }
}

/**
 * The original Auto Drive file name for `cid`, or null. Only an EXACT headCid match counts:
 * a neighbour's name would be mirrored as metadata, fail CID verification on every dApp read,
 * and cost a wasted round trip forever — strictly worse than leaving the CID unmirrored.
 */
function nameFromSearchResults(cid, results) {
  const match = (results || []).find((r) => r && r.headCid === cid);

  return match && match.name ? match.name : null;
}

async function queryPage(subgraphUrl, lastId, pageSize) {
  const response = await fetch(subgraphUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: PAGE_QUERY,
      variables: { lastId, first: pageSize, messagesFirst: MESSAGES_PER_CONVERSATION },
    }),
  });
  if (!response.ok) throw new Error(`Subgraph HTTP ${response.status}`);

  const json = await response.json();
  if (json.errors && json.errors.length) {
    throw new Error(`Subgraph errors: ${json.errors.map((e) => e.message).join("; ")}`);
  }

  return json.data.conversations;
}

/** Walk the whole subgraph by id cursor (not `skip`, which The Graph caps at 5000). */
async function* iterateCids(subgraphUrl, pageSize) {
  let lastId = "";
  for (;;) {
    const page = await queryPage(subgraphUrl, lastId, pageSize);
    if (page.length === 0) return;
    yield collectCids(page);
    lastId = page[page.length - 1].id;
  }
}

async function runWithConcurrency(items, limit, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await worker(queue.shift());
  });
  await Promise.all(runners);
}

function parseArgs(argv) {
  const flag = (name) => argv.includes(name);
  const value = (name, fallback) => {
    const index = argv.indexOf(name);
    if (index === -1) return fallback;
    const parsed = Number(argv[index + 1]);
    if (!Number.isInteger(parsed) || parsed <= 0)
      throw new Error(`${name} needs a positive integer`);

    return parsed;
  };

  return {
    dryRun: flag("--dry-run"),
    pageSize: value("--page-size", DEFAULT_PAGE_SIZE),
    concurrency: value("--concurrency", DEFAULT_CONCURRENCY),
  };
}

function loadEnv() {
  const dotenv = require("dotenv");
  if (process.env.ENV_FILE) dotenv.config({ path: process.env.ENV_FILE });
  dotenv.config({ path: path.resolve(__dirname, "../.env.oracle") });
}

async function main() {
  loadEnv();
  const options = parseArgs(process.argv.slice(2));
  const { SUBGRAPH_URL, PAYLOAD_MIRROR_BUCKET, PAYLOAD_MIRROR_SA_KEY, AUTONOMYS_API_KEY } =
    process.env;

  const missing = [
    ["SUBGRAPH_URL", SUBGRAPH_URL],
    ["PAYLOAD_MIRROR_BUCKET", PAYLOAD_MIRROR_BUCKET],
    ["PAYLOAD_MIRROR_SA_KEY", options.dryRun ? "n/a" : PAYLOAD_MIRROR_SA_KEY],
    ["AUTONOMYS_API_KEY", options.dryRun ? "n/a" : AUTONOMYS_API_KEY],
  ]
    .filter(([, v]) => !v || !String(v).trim())
    .map(([k]) => k);
  if (missing.length) {
    console.error(`Missing env: ${missing.join(", ")}`);
    process.exit(2);
  }

  const { createAutoDriveApi } = require("@autonomys/auto-drive");
  const { getNetworkId } = require("../src/storage/autonomys");
  const { mirrorPayload } = require("../src/storage/mirror");

  const autoDrive = options.dryRun
    ? null
    : createAutoDriveApi({ apiKey: AUTONOMYS_API_KEY, network: getNetworkId() });

  const deps = {
    bucket: PAYLOAD_MIRROR_BUCKET,
    env: { PAYLOAD_MIRROR_BUCKET, PAYLOAD_MIRROR_SA_KEY },
    headImpl: fetch,
    dryRun: options.dryRun,
    mirror: mirrorPayload,
    lookupName: async (cid) =>
      nameFromSearchResults(cid, await autoDrive.searchByNameOrCIDInMyFiles(cid)),
    download: async (cid) => {
      const chunks = [];
      for await (const chunk of await autoDrive.downloadFile(cid)) chunks.push(chunk);

      return Buffer.concat(chunks);
    },
  };

  const { scanned, tally, failures } = await runBackfill({
    subgraphUrl: SUBGRAPH_URL,
    options,
    deps,
    log: console.log,
  });

  console.log("\nSummary:", { scanned, ...tally });
  if (failures.length) {
    console.error(`\n${failures.length} CID(s) failed — re-run to retry:`);
    for (const line of failures) console.error(`  ${line}`);
  }
  process.exit(failures.length ? 1 : 0);
}

/**
 * The whole run minus process wiring: walk the subgraph, mirror what is missing, tally.
 * Pure enough to test with a stubbed fetch and stubbed deps.
 */
async function runBackfill({ subgraphUrl, options, deps, log = () => {} }) {
  const tally = { present: 0, pending: 0, created: 0, exists: 0, failed: 0 };
  const failures = [];
  let scanned = 0;

  log(`${options.dryRun ? "[dry-run] " : ""}Backfilling ${deps.bucket} from ${subgraphUrl}`);
  for await (const cids of iterateCids(subgraphUrl, options.pageSize)) {
    scanned += cids.length;
    await runWithConcurrency(cids, options.concurrency, async (cid) => {
      const result = await backfillCid(cid, deps);
      tally[result.status] += 1;
      if (result.status === "failed") failures.push(`${cid}: ${result.reason}`);
      if (result.status !== "present") log(`${result.status.padEnd(8)} ${cid}`);
    });
    log(`… ${scanned} CIDs scanned`);
  }

  return { scanned, tally, failures };
}

module.exports = {
  collectCids,
  backfillCid,
  iterateCids,
  parseArgs,
  runBackfill,
  nameFromSearchResults,
};

if (require.main === module) {
  main().catch((error) => {
    console.error("Backfill aborted:", error);
    process.exit(1);
  });
}
