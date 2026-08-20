const os = require("node:os");

/**
 * Vitals snapshot for the oracle heartbeat (CU-86d438hwt).
 *
 * WHY THIS EXISTS. `daily_activity` could already say the oracle ANSWERED, but not that it is
 * ALIVE: a silent oracle and a healthy-but-idle one both produce zero answer rows, and
 * `oasis rofl machine logs` surfaces warn/error only, so a healthy oracle was indistinguishable
 * from a dead one. These vitals are the payload of the heartbeat that closes that gap.
 *
 * THE ONE INVARIANT: this never throws.
 *
 * It is called by a background timer whose entire purpose is to prove liveness. An exception
 * escaping here kills the beat, core sees a stale heartbeat, and reports the oracle DEAD — a
 * false alarm manufactured by the monitoring itself, which is worse than no monitoring because
 * it teaches you to ignore the alert. Every probe therefore degrades to `null` INDEPENDENTLY;
 * a broken RPC must not blank the memory figures next to it.
 *
 * Field names deliberately mirror core's `ProcessHealth` so the Slack block reads the same for
 * both bodies.
 */

/** Run one probe, converting any failure into `null`. The whole file's safety rests here. */
async function safe(fn) {
  try {
    const value = await fn();

    return value === undefined ? null : value;
  } catch {
    return null;
  }
}

function humaniseUptime(totalSeconds) {
  const s = Math.floor(totalSeconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);

  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;

  return `${m}m`;
}

const BYTES_PER_MB = 1024 * 1024;
const toMB = (bytes) => Math.round(bytes / BYTES_PER_MB);
/** wei -> ETH as a Number. Precision is fine for a dashboard figure; this is not accounting. */
const WEI_PER_ETH = 1e18;

/**
 * Free/total disk for `diskPath`.
 *
 * NOT keyed off PGLITE_DATA_DIR, which core's `storageStats` still uses: PGLite is not used
 * anywhere in this stack (only `@elizaos/plugin-sql`'s default fallback, which both bodies
 * avoid by configuring Postgres), so that variable is never set and the helper silently
 * measures the process cwd. The caller passes a real path instead.
 */
async function probeDisk(diskPath) {
  const { statfs } = require("node:fs/promises");
  const stats = await statfs(diskPath);
  const total = stats.blocks * stats.bsize;
  const free = stats.bavail * stats.bsize;

  return { diskTotalMB: toMB(total), diskFreeMB: toMB(free) };
}

/**
 * @param {object} deps - injected so every network/fs probe is substitutable in tests
 * @param {object} [deps.provider] - ethers provider (chain head + wallet balance)
 * @param {string} [deps.walletAddress] - the oracle signer that pays gas to submit answers
 * @param {object} [deps.queue] - the p-queue instance (`pending` / `size`)
 * @param {Function} [deps.readState] - resolves `{ lastProcessedBlock }` from oracle-state.json
 * @param {Function} [deps.readFailedJobs] - resolves the failed-jobs array
 * @param {Function} [deps.fetchAccountInfo] - Auto-Drive account info (upload/download credits)
 * @param {string} [deps.diskPath] - a real path to measure
 * @returns {Promise<object>} vitals, every field either a value or null
 */
async function collectVitals(deps = {}) {
  const { provider, walletAddress, queue, readState, readFailedJobs, fetchAccountInfo, diskPath } =
    deps;

  // Process vitals come from `process`/`os` and cannot realistically fail. They are collected
  // OUTSIDE `safe()` on purpose: if these ever throw, the snapshot is meaningless anyway, and
  // silently nulling them would hide a genuine fault in the runtime itself.
  const mem = process.memoryUsage();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const [loadAvg1m, loadAvg5m, loadAvg15m] = os.loadavg();
  const uptimeSeconds = Math.floor(process.uptime());

  // Probes run concurrently — a slow RPC should not serialise behind a slow disk when the whole
  // snapshot is meant to be a cheap periodic sample.
  const [chainHead, walletBalanceWei, state, failedJobs, accountInfo, disk] = await Promise.all([
    safe(() => (provider ? provider.getBlockNumber() : null)),
    safe(() => (provider && walletAddress ? provider.getBalance(walletAddress) : null)),
    safe(() => (readState ? readState() : null)),
    safe(() => (readFailedJobs ? readFailedJobs() : null)),
    safe(() => (fetchAccountInfo ? fetchAccountInfo() : null)),
    safe(() => (diskPath ? probeDisk(diskPath) : null)),
  ]);

  const lastProcessedBlock =
    typeof state?.lastProcessedBlock === "number" ? state.lastProcessedBlock : null;

  // Null when EITHER side is unknown, rather than substituting 0 for the missing one. On a fresh
  // deploy the cursor is unwritten, and `chainHead - 0` reads as catastrophically behind — a
  // page-worthy number for a non-event. Clamped at 0 because a load-balanced RPC legitimately
  // serves a slightly stale head, making a small negative lag noise rather than signal.
  const blockLag =
    chainHead === null || lastProcessedBlock === null
      ? null
      : Math.max(0, chainHead - lastProcessedBlock);

  return {
    uptimeSeconds,
    uptimeHuman: humaniseUptime(uptimeSeconds),
    memoryRssMB: toMB(mem.rss),
    memoryHeapUsedMB: toMB(mem.heapUsed),
    memoryTotalMB: toMB(totalMem),
    memoryFreeMB: toMB(freeMem),
    memoryPctUsed: Math.round(((totalMem - freeMem) / totalMem) * 1000) / 10,
    loadAvg1m: Math.round(loadAvg1m * 100) / 100,
    loadAvg5m: Math.round(loadAvg5m * 100) / 100,
    loadAvg15m: Math.round(loadAvg15m * 100) / 100,

    diskTotalMB: disk?.diskTotalMB ?? null,
    diskFreeMB: disk?.diskFreeMB ?? null,

    lastProcessedBlock,
    chainHead,
    blockLag,

    walletBalanceEth:
      walletBalanceWei === null ? null : Number(walletBalanceWei) / WEI_PER_ETH,

    failedJobsCount: Array.isArray(failedJobs) ? failedJobs.length : null,
    queuePending: typeof queue?.pending === "number" ? queue.pending : null,
    queueSize: typeof queue?.size === "number" ? queue.size : null,

    autoDriveUploadCredits:
      typeof accountInfo?.pendingUploadCredits === "number"
        ? accountInfo.pendingUploadCredits
        : null,
    autoDriveDownloadCredits:
      typeof accountInfo?.pendingDownloadCredits === "number"
        ? accountInfo.pendingDownloadCredits
        : null,
  };
}

module.exports = { collectVitals };
