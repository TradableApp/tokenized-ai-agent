const crypto = require("node:crypto");
const { JWT } = require("google-auth-library");
const { sendAlert } = require("../alerting");

/**
 * Write-through mirror of every Autonomys payload CID to a public GCS bucket.
 *
 * WHY. `gateway.autonomys.xyz/file/<cid>` is intermittently 503 (the same CID serves 200 a
 * second later), and the dApp hydrates conversation history exclusively from those CIDs. The
 * mirror is a CACHE in front of Autonomys, not a replacement: Autonomys stays the permanence
 * layer, the on-chain CID stays the root of trust, and the dApp verifies the mirror's bytes
 * against the CID before trusting them. Nothing here can lose data — a missed mirror is a slower
 * read, never a lost payload.
 *
 * THE INVARIANT: the mirror is never on the prompt's critical path.
 *
 * `uploadData` returns the CID as soon as Auto Drive has it and fires the mirror in the
 * background; the mirror never rejects, never delays an answer, and degrades to a counter and a
 * single Slack/email alert per process when the bucket is unreachable or misconfigured. It is a
 * no-op entirely when PAYLOAD_MIRROR_BUCKET is unset (localnet, mock storage, tests).
 *
 * OBJECT CONTRACT (shared with the Infrastructure Terraform and the dApp's resolver):
 *   bucket           ${project_id}-senseai-payloads, uniform access, allUsers objectViewer
 *   object name      the Auto Drive CID, exactly as returned by uploadData
 *   Content-Type     text/plain — the payload is `iv.ciphertext`, opaque to the browser
 *   Cache-Control    public, max-age=31536000, immutable — a CID's bytes never change
 *   metadata.name    the Auto Drive file name. The name is PART of the Auto Drive CID
 *                    (createSingleFileIpldNode(data, name)), so the dApp needs it to recompute
 *                    and verify the CID from the mirrored bytes. Served as `x-goog-meta-name`.
 *   write            JSON API multipart upload with ifGenerationMatch=0: a 412 means another
 *                    writer (or a backfill) already mirrored this CID, which is success.
 */

const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 60_000;
const JITTER_RATIO = 0.25;

const OBJECT_CONTENT_TYPE = "text/plain";
const OBJECT_CACHE_CONTROL = "public, max-age=31536000, immutable";
const STORAGE_SCOPES = ["https://www.googleapis.com/auth/devstorage.read_write"];
const UPLOAD_ENDPOINT = "https://storage.googleapis.com/upload/storage/v1/b";

/** Transient HTTP statuses worth another attempt. Every other 4xx is a configuration fault. */
const RETRYABLE_CLIENT_STATUSES = new Set([408, 429]);

const counters = { mirrored: 0, failed: 0, skipped: 0 };
let hasAlerted = false;
/** One JWT client per service-account key: it caches and refreshes its own access token. */
const jwtClients = new Map();

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isEnabled(env = process.env) {
  const bucket = env.PAYLOAD_MIRROR_BUCKET;

  return typeof bucket === "string" && bucket.trim().length > 0;
}

/** Exponential backoff from 1 s, capped at 60 s, plus up to 25% jitter so retries de-correlate. */
function backoffDelayMs(attempt, random = Math.random) {
  const base = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);

  return Math.round(base * (1 + JITTER_RATIO * random()));
}

/**
 * Multipart/related body for the GCS JSON API: part 1 is the object resource (name, content
 * type, cache control, custom metadata), part 2 is the raw bytes.
 */
function buildMultipartBody(cid, data, fileName, boundary = `senseai-${crypto.randomUUID()}`) {
  const resource = JSON.stringify({
    name: cid,
    contentType: OBJECT_CONTENT_TYPE,
    cacheControl: OBJECT_CACHE_CONTROL,
    metadata: { name: fileName },
  });
  const head = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${resource}\r\n` +
      `--${boundary}\r\nContent-Type: ${OBJECT_CONTENT_TYPE}\r\n\r\n`,
    "utf8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");

  return {
    body: Buffer.concat([head, Buffer.isBuffer(data) ? data : Buffer.from(data), tail]),
    contentType: `multipart/related; boundary=${boundary}`,
  };
}

/**
 * Access token for the writer service account. PAYLOAD_MIRROR_SA_KEY is the JSON key of an SA
 * holding only roles/storage.objectCreator on the bucket — it can add objects, never read,
 * overwrite or delete them, so a leaked key cannot tamper with mirrored history.
 */
async function getAccessToken(env = process.env) {
  const rawKey = env.PAYLOAD_MIRROR_SA_KEY;
  if (typeof rawKey !== "string" || rawKey.trim().length === 0) {
    throw new Error("PAYLOAD_MIRROR_SA_KEY is not set");
  }

  let client = jwtClients.get(rawKey);
  if (!client) {
    const key = JSON.parse(rawKey);
    client = new JWT({ email: key.client_email, key: key.private_key, scopes: STORAGE_SCOPES });
    jwtClients.set(rawKey, client);
  }

  const { token } = await client.getAccessToken();
  if (!token) throw new Error("google-auth-library returned no access token");

  return token;
}

function isPermanentStatus(status) {
  return status >= 400 && status < 500 && !RETRYABLE_CLIENT_STATUSES.has(status);
}

async function recordFailure(cid, reason, alert) {
  counters.failed += 1;
  console.error(`[Payload Mirror] Failed to mirror ${cid}: ${reason}`);

  // One alert per process. The first failure is the signal; the hundredth is noise that buries
  // it, and the counters in the heartbeat vitals carry the running total.
  if (!hasAlerted) {
    hasAlerted = true;
    try {
      await alert(
        "Payload mirror failing",
        `The oracle could not mirror payload ${cid} to the GCS bucket: ${reason}. ` +
          "Autonomys still holds the payload; dApp reads fall back to the gateway. " +
          "Further failures are counted in the heartbeat vitals (payloadMirror) without alerting.",
      );
    } catch (alertError) {
      console.error("[Payload Mirror] Alert delivery failed:", alertError.message);
    }
  }

  return { status: "failed", reason };
}

/**
 * Mirror one payload. Resolves (never rejects) with one of:
 *   { status: "skipped" }          mirror disabled
 *   { status: "created" }          object written
 *   { status: "exists" }           object already present (412) — success
 *   { status: "failed", reason }   gave up; counted and (first time only) alerted
 *
 * @param {object} [deps] injected for tests: env, fetchImpl, getToken, sleep, random, alert
 */
async function mirrorPayload(cid, data, fileName, deps = {}) {
  const {
    env = process.env,
    fetchImpl = globalThis.fetch,
    getToken = getAccessToken,
    sleep = defaultSleep,
    random = Math.random,
    alert = sendAlert,
  } = deps;

  if (!isEnabled(env)) {
    counters.skipped += 1;

    return { status: "skipped" };
  }

  const bucket = env.PAYLOAD_MIRROR_BUCKET.trim();
  const url =
    `${UPLOAD_ENDPOINT}/${encodeURIComponent(bucket)}/o` +
    `?uploadType=multipart&name=${encodeURIComponent(cid)}&ifGenerationMatch=0`;
  const { body, contentType } = buildMultipartBody(cid, data, fileName);

  let lastReason = "unknown";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const token = await getToken(env);
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": contentType,
          "Content-Length": String(body.length),
        },
        body,
      });

      if (response.ok) {
        counters.mirrored += 1;

        return { status: "created" };
      }
      if (response.status === 412) {
        counters.mirrored += 1;

        return { status: "exists" };
      }

      const detail = await response.text().catch(() => "");
      lastReason = `HTTP ${response.status} ${detail}`.trim();
      if (isPermanentStatus(response.status)) {
        return recordFailure(cid, lastReason, alert);
      }
    } catch (error) {
      lastReason = error && error.message ? error.message : String(error);
    }

    if (attempt < MAX_ATTEMPTS - 1) {
      await sleep(backoffDelayMs(attempt, random));
    }
  }

  return recordFailure(cid, `${lastReason} (after ${MAX_ATTEMPTS} attempts)`, alert);
}

/** Fire-and-forget wrapper for uploadData: whatever happens, the caller's promise chain is safe. */
async function mirrorInBackground(cid, data, fileName, deps) {
  try {
    return await mirrorPayload(cid, data, fileName, deps);
  } catch (error) {
    console.error(`[Payload Mirror] Unexpected error mirroring ${cid}:`, error);

    return { status: "failed", reason: error && error.message ? error.message : String(error) };
  }
}

/** Cumulative counters for the heartbeat vitals (`payloadMirror`). */
function snapshot() {
  return { ...counters };
}

function _resetForTest() {
  counters.mirrored = 0;
  counters.failed = 0;
  counters.skipped = 0;
  hasAlerted = false;
  jwtClients.clear();
}

module.exports = {
  isEnabled,
  backoffDelayMs,
  buildMultipartBody,
  getAccessToken,
  mirrorPayload,
  mirrorInBackground,
  snapshot,
  _resetForTest,
};
