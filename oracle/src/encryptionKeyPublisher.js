"use strict";

/**
 * Makes the agent contract show the oracle's encryption key.
 *
 * Clients encrypt each prompt's session key to `oracleEncryptionKey()` on the agent, or check
 * the key their build names against it before a paid send. So the key on chain must be the key
 * this oracle decrypts with. The oracle publishes it with `setOracleEncryptionKey(key, proof)`,
 * where the proof is signed by the key itself (`decryptor.proveKey`).
 *
 *   check(): reads the key on chain and publishes this oracle's key when it differs. Never
 *            throws. Calls made while one runs share it.
 *   watch(): calls check() on a timer.
 *
 * A key that cannot be published does not stop the oracle or hold its answers: the oracle can
 * only decrypt what was encrypted to its own key, whatever the chain shows, so holding answers
 * would only turn paid prompts into refunds. It alerts instead, at once and hourly while it
 * lasts, and tries again on the next check.
 */

const { describeError } = require("./errorDescription");

/** How often the key on the agent is checked again. A check that finds the key is one read. */
const CHECK_EVERY_MS = 5 * 60 * 1000;
/** 2 minutes is about 600 Base blocks (one every 200 ms): a receipt not in by then is stuck. */
const RECEIPT_TIMEOUT_MS = 2 * 60 * 1000;
const REMIND_EVERY_MS = 60 * 60 * 1000;

const NOT_PUBLISHED_TITLE = "CRITICAL: Oracle Encryption Key Not Published";
const RESOLVED_TITLE = "RESOLVED: Oracle encryption key is published";

const ZERO_ADDRESS = /^0x0{40}$/i;

function sameHex(a, b) {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}

function isZeroAddress(address) {
  return typeof address !== "string" || ZERO_ADDRESS.test(address);
}

/** The agent's custom error in a failed send, decoded by the agent's own ABI, or null. */
function revertOf(contract, error) {
  const candidate = error?.data ?? error?.info?.error?.data;
  if (typeof candidate !== "string" || candidate.length < 10) return null;
  try {
    return contract.interface?.parseError?.(candidate) ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether the error is a transaction that was mined and reverted. ethers throws that from
 * `wait()` with the receipt and no revert data, so the agent's reason cannot be read from it.
 */
function isMinedRevert(error) {
  return error?.code === "CALL_EXCEPTION" && error?.receipt?.status === 0;
}

/** A short name for what went wrong: one page per kind, and the Sentry tag. */
function failureKind(revert, error) {
  if (revert) return `revert-${revert.name}`;
  if (isMinedRevert(error)) return "reverted";
  if (error?.code === "TIMEOUT") return "timeout";
  return "failed";
}

/**
 * @param {{
 *   contract: any,
 *   signerAddress: string,
 *   decryptor: { publicKey: string, proveKey: Function },
 *   chainId: bigint | number,
 *   runExclusive: (work: () => Promise<any>) => Promise<any>,
 *   isRoleLost: () => boolean,
 *   onRoleRefused: (error: Error) => Promise<boolean>,
 *   alert: (title: string, message: string) => any,
 *   report: (kind: string) => any,
 *   log?: { log: Function, warn: Function, error: Function },
 *   now?: () => number,
 * }} options
 */
function createKeyPublisher({
  contract,
  signerAddress,
  decryptor,
  chainId,
  runExclusive,
  isRoleLost,
  onRoleRefused,
  alert,
  report,
  log = console,
  now = Date.now,
}) {
  let running = null;
  // The kind of failure last paged for and when, or null when nothing is paged.
  let paged = null;

  function quietly(fn, ...args) {
    try {
      Promise.resolve(fn(...args)).catch(() => {});
    } catch {
      // An alert or report that cannot even be started changes nothing here.
    }
  }

  function failed(kind, outcome, detail) {
    const message =
      `Oracle ${signerAddress} could not make the agent ${contract.target} show its encryption ` +
      `key (${decryptor.publicKey}). ${detail} Clients that check the agent's key before a paid ` +
      `send refuse to send while it differs from theirs. The oracle keeps answering and checks ` +
      `again every ${CHECK_EVERY_MS / 60000} minutes.`;
    log.error(`[OracleKey] ${message}`);
    const due = paged === null || paged.kind !== kind || now() - paged.at >= REMIND_EVERY_MS;
    if (due) {
      paged = { kind, at: now() };
      quietly(alert, NOT_PUBLISHED_TITLE, message);
      quietly(report, kind);
    }

    return outcome;
  }

  function settled(outcome) {
    if (paged !== null) {
      paged = null;
      quietly(
        alert,
        RESOLVED_TITLE,
        `The agent ${contract.target} shows the encryption key of oracle ${signerAddress}.`,
      );
    }

    return outcome;
  }

  function heldByOther(publisher) {
    return failed(
      "held-by-other",
      "held-by-other",
      `The key on the agent was published by another oracle, ${publisher}, and only its ` +
        `publisher can replace it. The owner removing that oracle (removeOracle(${publisher})) ` +
        `withdraws its key, and this oracle then publishes its own.`,
    );
  }

  async function publish() {
    const proof = decryptor.proveKey({
      chainId,
      agentAddress: contract.target,
      publisher: signerAddress,
    });
    const receipt = await runExclusive(async () => {
      const tx = await contract.setOracleEncryptionKey(decryptor.publicKey, proof);
      return tx.wait(1, RECEIPT_TIMEOUT_MS);
    });
    if (!receipt || receipt.status !== 1) {
      return failed(
        "reverted",
        "failed",
        `The transaction ${receipt?.hash ?? "(no receipt)"} did not succeed.`,
      );
    }
    log.log(`[OracleKey] Published the encryption key on ${contract.target}. Tx: ${receipt.hash}`);

    return settled("published");
  }

  async function run() {
    // The role gate pages for a missing role, and a send would revert.
    if (isRoleLost()) return "role-missing";
    try {
      const onChain = await contract.oracleEncryptionKey();
      if (sameHex(onChain, decryptor.publicKey)) return settled("unchanged");

      const publisher = await contract.oracleEncryptionKeyPublisher();
      if (!isZeroAddress(publisher) && !sameHex(publisher, signerAddress)) {
        return heldByOther(publisher);
      }

      return await publish();
    } catch (error) {
      const revert = revertOf(contract, error);
      if (revert?.name === "EncryptionKeyHeldByAnotherOracle") return heldByOther(revert.args[0]);
      if (revert?.name !== "InvalidEncryptionKey" && revert?.name !== "InvalidEncryptionKeyProof") {
        // A refusal for want of the role (by name, or a mined revert with no reason) is the role
        // gate's to confirm and to page for.
        let roleLost = false;
        try {
          roleLost = await onRoleRefused(error);
        } catch {
          roleLost = false;
        }
        if (roleLost) return "role-missing";
      }
      if (isMinedRevert(error)) {
        // A mined revert carries no reason. The usual cause, with the role held, is another
        // oracle publishing between this one's read and its send: the publisher is read again,
        // so the page says who holds the key and what removes it.
        const holder = await contract.oracleEncryptionKeyPublisher().catch(() => null);
        if (holder !== null && !isZeroAddress(holder) && !sameHex(holder, signerAddress)) {
          return heldByOther(holder);
        }
      }
      return failed(failureKind(revert, error), "failed", `Last failure: ${describeError(error)}.`);
    }
  }

  function check() {
    if (!running) {
      running = run().finally(() => {
        running = null;
      });
    }
    return running;
  }

  function watch({ setIntervalFn = setInterval } = {}) {
    const timer = setIntervalFn(() => {
      void check();
    }, CHECK_EVERY_MS);
    timer?.unref?.();
    return timer;
  }

  return { check, watch };
}

module.exports = { CHECK_EVERY_MS, RECEIPT_TIMEOUT_MS, REMIND_EVERY_MS, createKeyPublisher };
