"use strict";

/**
 * What `STORAGE_PROVIDER` means, read in one place by the storage router (`storage.js`), the
 * content id shapes (`contentId.js`) and the start-up check (`startupConfig.js`). The value is
 * trimmed and read without regard to case.
 *
 * - unset or empty: `irys-and-autonomys`. Irys and Autonomys are both started; new files go to
 *   Autonomys, and Arweave ids stay readable, with tag queries asking Autonomys first and Irys
 *   after it. Needs `AUTONOMYS_API_KEY` and `IRYS_PAYMENT_PRIVATE_KEY`.
 * - `irys`: Irys only; new files go to Arweave. Needs `IRYS_PAYMENT_PRIVATE_KEY`.
 * - `autonomys-only`: Autonomys only. Irys is never started or funded, tag queries ask Autonomys
 *   alone, and an Arweave-shaped id is not taken (not fetched, not accepted in a payload). For a
 *   deployment that has never written to Arweave. Needs `AUTONOMYS_API_KEY`.
 * - anything else: `null`. The start-up check refuses it.
 *
 * None of this applies under `USE_MOCK_STORAGE=true` or with `LOCAL_IPFS_API_URL` set, which
 * start neither provider; there only the content id rule (`contentId.js`) reads the mode.
 */

const SUPPORTED_STORAGE_PROVIDERS = Object.freeze(["irys", "autonomys-only"]);

/** The mode the setting names, or null when it names none. */
function storageMode(env = process.env) {
  const raw = env.STORAGE_PROVIDER;
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (value === "") return "irys-and-autonomys";
  if (value === "irys") return "irys";
  if (value === "autonomys-only") return "autonomys-only";
  return null;
}

/** Is Irys out of this deployment altogether? */
function isAutonomysOnly(env = process.env) {
  return storageMode(env) === "autonomys-only";
}

module.exports = { storageMode, isAutonomysOnly, SUPPORTED_STORAGE_PROVIDERS };
