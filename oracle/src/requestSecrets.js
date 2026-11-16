"use strict";

/**
 * The secret parts of the addresses the oracle is configured with.
 *
 * An address carries credentials in three places: a provider's access key as a path segment or
 * a query value, and a database's password before the host. `withoutAddresses` removes a whole
 * address wherever one is written out. But tools that describe a request record its parts
 * separately ("POST /v2/<key>", a query string), and a part has no scheme in front for that to
 * find. So the secret parts themselves are collected here, from every configured value that is
 * an address, and removed by value from whatever text they turn up in.
 */

const REPLACEMENT = "[REDACTED]";
// A route name ("v2", "rpc", "api") is short; an access key is not. Removing short segments
// from every line would blank ordinary text.
const MIN_PATH_SEGMENT_LENGTH = 16;
const MIN_QUERY_VALUE_LENGTH = 6;
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

function escapeForPattern(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decoded(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * @param {Record<string, string | undefined>} env
 * @returns {string[]} Each secret once, as it is written in the address and as it reads decoded.
 */
function requestSecretsIn(env) {
  const secrets = new Set();
  for (const raw of Object.values(env)) {
    if (typeof raw !== "string" || !SCHEME.test(raw.trim())) continue;
    let address;
    try {
      address = new URL(raw.trim());
    } catch {
      continue;
    }
    if (address.password) secrets.add(address.password);
    for (const segment of address.pathname.split("/")) {
      if (segment.length >= MIN_PATH_SEGMENT_LENGTH) secrets.add(segment);
    }
    // Split by hand: URLSearchParams would turn "+" into a space, and the text to match is
    // what was written.
    for (const pair of address.search.replace(/^\?/, "").split("&")) {
      const value = pair.slice(pair.indexOf("=") + 1);
      if (pair.includes("=") && value.length >= MIN_QUERY_VALUE_LENGTH) secrets.add(value);
    }
  }
  for (const secret of [...secrets]) {
    secrets.add(decoded(secret));
    secrets.add(encodeURIComponent(decoded(secret)));
  }

  return [...secrets];
}

let pattern = null;

/**
 * Reads the configuration again. Called once the environment is complete (the env files are
 * loaded after the first modules are), and by tests.
 * @param {Record<string, string | undefined>} [env]
 */
function refreshRequestSecrets(env = process.env) {
  // Longest first, so a secret that contains another is removed whole.
  const secrets = requestSecretsIn(env).sort((a, b) => b.length - a.length);
  pattern = secrets.length ? new RegExp(secrets.map(escapeForPattern).join("|"), "g") : null;
}

/** The text without any configured secret. Anything that is not a string is returned as it is. */
function withoutRequestSecrets(text) {
  if (pattern === null || typeof text !== "string") return text;

  return text.replace(pattern, REPLACEMENT);
}

refreshRequestSecrets();

module.exports = { requestSecretsIn, refreshRequestSecrets, withoutRequestSecrets };
