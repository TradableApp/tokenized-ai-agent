const Sentry = require("@sentry/node");

const TRACE_RATES = {
  localnet: 1.0,
  testnet: 0.5,
  'base-testnet': 0.5,
  mainnet: 0.05,
  'base-mainnet': 0.05,
};

/**
 * Substrings that mark a field as secret, matched against a NORMALISED key.
 *
 * Normalisation is the fix, not the list. The previous matcher compared the raw lowercased key
 * against these entries, so `"private_key".includes("privatekey")` was false and PRIVATE_KEY —
 * the exact name the TEE's own signing secret carries in rofl.yaml — was sent to Sentry in the
 * clear. Every screaming-snake secret missed for the same reason. Stripping separators first
 * makes PRIVATE_KEY, privateKey and private-key one thing.
 *
 * Entries are deliberately specific ("privatekey", "apikey") rather than a bare "key", which
 * would also redact publicKey, keywords and anything ending in -key, hollowing out reports for
 * no gain. Where the choice is genuinely close, over-redaction wins: a redacted field costs one
 * debugging round-trip, a leaked one costs a key rotation.
 */
const SENSITIVE_KEYS = [
  "privatekey",
  "apikey",
  "clientkey",
  "iryskey",
  "roflencryptedkey",
  "encryptedpayload",
  "mnemonic",
  "passphrase",
  "password",
  "passwd",
  "secret",
  "token",
  "credential",
  "authorization",
  "cookie",
];

/** Collapse case and separators so PRIVATE_KEY, privateKey and private-key all compare equal. */
function normaliseKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSensitiveKey(key) {
  const normalised = normaliseKey(key);
  return SENSITIVE_KEYS.some((s) => normalised.includes(s));
}

/**
 * Recursively redact secret-looking fields from a Sentry event.
 *
 * `seen` guards against cycles. Sentry events legitimately contain them (a captured error whose
 * `cause` chain loops, a DOM-ish or request object referencing itself), and the unguarded version
 * recursed to RangeError. Thrown out of `beforeSend`, that drops the event — so a cycle blinded
 * ALL error monitoring, which is strictly worse than whatever was being reported.
 */
function scrubSensitiveData(obj, seen = new WeakSet()) {
  if (!obj || typeof obj !== "object") return obj;
  if (seen.has(obj)) return "[CIRCULAR]";
  seen.add(obj);

  const result = Array.isArray(obj) ? [...obj] : { ...obj };
  for (const key of Object.keys(result)) {
    if (isSensitiveKey(key)) {
      result[key] = "[REDACTED]";
    } else if (typeof result[key] === "object") {
      result[key] = scrubSensitiveData(result[key], seen);
    }
  }
  return result;
}

function initSentry() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    console.log("[Sentry] SENTRY_DSN not set — error monitoring disabled.");
    return;
  }

  const environment = process.env.SENTRY_ENVIRONMENT || "production";
  const tracesSampleRate = TRACE_RATES[environment] ?? 0.1;

  Sentry.init({
    dsn,
    environment,
    tracesSampleRate,
    beforeSend(event) {
      return scrubSensitiveData(event);
    },
  });

  console.log(`[Sentry] Initialized for environment: ${environment}`);
}

module.exports = { initSentry, scrubSensitiveData };
