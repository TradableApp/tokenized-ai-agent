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
 *
 * "token" is qualified for the same reason, and it matters more here than the -key case. A bare
 * entry redacts tokenAddress, tokenId, ableToken, promptTokens and totalTokens — in a
 * token-gated AI agent that is most of the telemetry you debug with, and none of it is a
 * credential. The credential-shaped names are enumerated instead.
 */
const SENSITIVE_KEYS = [
  "privatekey",
  "apikey",
  "clientkey",
  // Declared fields in payloadValidator's schemas and read off the prompt path — the likeliest
  // secret in this codebase to be attached to a Sentry `extra`, and missed by a list rebuilt
  // without consulting the project's own schema.
  "sessionkey",
  "signingkey",
  "encryptionkey",
  // "seedphrase", not a bare "seed": this codebase carries contentSeed, numericSeed and
  // initialRandomSeed, none of which are credentials. Same trap as the bare "token" entry.
  "seedphrase",
  "iryskey",
  "roflencryptedkey",
  "encryptedpayload",
  "mnemonic",
  "passphrase",
  "password",
  "passwd",
  "secret",
  "accesstoken",
  "authtoken",
  "bearertoken",
  "refreshtoken",
  "idtoken",
  "sessiontoken",
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

/** Deeper than any real Sentry event; past this the shape is pathological, not informative. */
const MAX_SCRUB_DEPTH = 200;

/**
 * Recursively redact secret-looking fields from a Sentry event.
 *
 * EVERYTHING HERE IS ABOUT NOT THROWING. A throw out of `beforeSend` is not a crash anyone
 * sees: Sentry's `processBeforeSend` feeds the result into a promise chain, so the rejection
 * simply drops the event. The scrubber failing therefore blinds ALL error monitoring at exactly
 * the moment something is going wrong — strictly worse than whatever was being reported. Four
 * separate inputs were verified to do it:
 *
 *   - a cycle (`cause` chains, self-referencing request objects) → RangeError;
 *   - DEEP ACYCLIC nesting, which the cycle guard does nothing for → RangeError, hence the
 *     depth cap;
 *   - a property whose getter throws, because spreading an object INVOKES its getters;
 *   - a Proxy whose `ownKeys` trap throws.
 *
 * `path` rather than a global seen-set: a shared sub-object is a DIAMOND, not a cycle, and
 * Sentry events share sub-objects between contexts routinely. Marking the second visit
 * `[CIRCULAR]` silently deletes real data. Entries are removed on unwind so only genuine
 * ancestors count.
 *
 * Keys are read with `Reflect.ownKeys` so symbol-keyed properties are checked too — the spread
 * copies them, but `Object.keys` cannot see them, so `Symbol("PRIVATE_KEY")` used to survive
 * into the event with its value intact.
 */
function scrubSensitiveData(obj, path = new Set(), depth = 0) {
  if (!obj || typeof obj !== "object") return obj;
  if (path.has(obj)) return "[CIRCULAR]";
  if (depth >= MAX_SCRUB_DEPTH) return "[TRUNCATED]";

  let keys;
  try {
    keys = Reflect.ownKeys(obj);
  } catch {
    // A Proxy that refuses to enumerate. Nothing can be read safely, so report the shape.
    return "[UNREADABLE]";
  }

  path.add(obj);
  try {
    const result = Array.isArray(obj) ? [] : {};
    for (const key of keys) {
      // Reflect.ownKeys also returns non-enumerable own keys — on an array, `length`. Copying it
      // assigns result.length, which densifies a sparse array: length 1e6 with no elements
      // serialised to a 5MB payload out of the scrubber that runs on every event. Symbols are
      // kept regardless, since the spread copies enumerable ones and they may be sensitive.
      const descriptor = Object.getOwnPropertyDescriptor(obj, key);
      if (descriptor && !descriptor.enumerable && typeof key !== "symbol") continue;

      if (isSensitiveKey(typeof key === "symbol" ? (key.description ?? "") : key)) {
        result[key] = "[REDACTED]";
        continue;
      }

      let value;
      try {
        value = obj[key];
      } catch {
        // A throwing getter. One unreadable field must not cost the whole event.
        result[key] = "[UNREADABLE]";
        continue;
      }

      result[key] =
        value && typeof value === "object" ? scrubSensitiveData(value, path, depth + 1) : value;
    }
    return result;
  } finally {
    path.delete(obj);
  }
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
      // Last line of defence. scrubSensitiveData is written not to throw, but if it ever does,
      // Sentry drops the event and monitoring goes dark without a word. Send a minimal
      // stand-in instead: never the unscrubbed original, which is the one thing that could
      // leak, but enough to show that something failed and roughly where.
      try {
        return scrubSensitiveData(event);
      } catch (error) {
        // Constructor name and stack only. An error message can carry the very data the
        // scrubber exists to remove — a throwing getter is free to build one out of a key —
        // and this is the one path that would put it in Sentry unscrubbed.
        const errorName = error?.constructor?.name ?? "unknown error";
        // V8 opens `stack` with "<Type>: <message>", so the frames are taken without their first
        // line. Logging the stack whole would reinstate the message suppressed just above.
        const frames = error?.stack?.split("\n").slice(1).join("\n");
        console.error("[Sentry] Scrubbing failed; sending a redacted stand-in.", errorName, frames);
        return {
          event_id: event?.event_id,
          timestamp: event?.timestamp,
          level: "error",
          message: `Sentry scrubbing failed (${errorName}); original event withheld.`,
        };
      }
    },
  });

  console.log(`[Sentry] Initialized for environment: ${environment}`);
}

module.exports = { initSentry, scrubSensitiveData };
