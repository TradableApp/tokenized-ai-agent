"use strict";

/**
 * The secret parts of the addresses the oracle is configured with.
 *
 * An address carries credentials in several places: a provider's access key as a path segment,
 * a query value or a host label, and a database's password before the host. `withoutAddresses` removes a whole
 * address wherever one is written out. But tools that describe a request record its parts
 * separately ("POST /v2/<key>", a query string), and a part has no scheme in front for that to
 * find. So the secret parts themselves are collected here, from every configured value that
 * holds an address and from every setting named as a credential, and removed by value from
 * whatever text they turn up in.
 *
 * This is the second line. The first is not recording requests at all (sentryInit.js) and
 * describing errors before they are printed (errorDescription.js).
 */

const REPLACEMENT = "[REDACTED]";

// What separates a credential from an ordinary word is length, or a name that says so. A route
// ("v2", "rpc"), a setting ("mainnet", "require") or a local password ("postgres") is short;
// removing those from every line would blank ordinary text. So a part of an address counts
// when it is long, and a query value or a setting also counts when its name is a credential's.
const MIN_LENGTH = 16;
const MIN_NAMED_LENGTH = 6;
const MIN_PASSWORD_LENGTH = 10;
const MIN_SETTING_LENGTH = 12;
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const CREDENTIAL_PARAMETER = /key|token|secret|auth|password|passwd|signature|credential/i;
const CREDENTIAL_SETTING = /(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_KEY)$/i;
// A project or account number is an id, not a key.
const ONLY_DIGITS = /^\d+$/;

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

/** The secret parts of one address. */
function secretsOfAddress(address) {
  const found = [];
  const long = (value) => value.length >= MIN_LENGTH && !ONLY_DIGITS.test(value);

  if (address.password.length >= MIN_PASSWORD_LENGTH) found.push(address.password);
  // A key given as the user name, with no password after it.
  if (long(address.username)) found.push(address.username);
  // A provider that puts the key in the host name puts it in a label of its own.
  found.push(...address.hostname.split(".").filter(long));
  found.push(...address.pathname.split("/").filter(long));
  if (long(address.hash.slice(1))) found.push(address.hash.slice(1));
  // Split by hand: URLSearchParams would turn "+" into a space, and the text to match is what
  // was written.
  for (const pair of address.search.replace(/^\?/, "").split("&")) {
    const at = pair.indexOf("=");
    const name = at < 0 ? "" : pair.slice(0, at);
    const value = at < 0 ? pair : pair.slice(at + 1);
    const named = CREDENTIAL_PARAMETER.test(name) && value.length >= MIN_NAMED_LENGTH;
    if (named || long(value)) found.push(value);
  }

  return found;
}

/**
 * @param {Record<string, string | undefined>} env
 * @returns {string[]} Each secret once, as it is written and as it reads decoded.
 */
function requestSecretsIn(env) {
  const secrets = new Set();
  for (const [name, raw] of Object.entries(env)) {
    if (typeof raw !== "string") continue;
    // A value may be quoted (a compose list keeps the quotes) or hold several addresses.
    const parts = raw.split(/[\s,]+/).map((part) => part.replace(/^["']+|["']+$/g, ""));
    let heldAnAddress = false;
    for (const part of parts) {
      if (!SCHEME.test(part)) continue;
      let address;
      try {
        address = new URL(part);
      } catch {
        continue;
      }
      heldAnAddress = true;
      for (const secret of secretsOfAddress(address)) secrets.add(secret);
    }
    // A credential set on its own, not inside an address: a database password, an API key.
    const bare = raw.trim().replace(/^["']+|["']+$/g, "");
    if (
      !heldAnAddress &&
      CREDENTIAL_SETTING.test(name) &&
      bare.length >= MIN_SETTING_LENGTH &&
      !/\s/.test(bare) &&
      !ONLY_DIGITS.test(bare)
    ) {
      secrets.add(bare);
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
