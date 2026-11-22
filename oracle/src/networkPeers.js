"use strict";

/**
 * Text without the network peers it names.
 *
 * A failed connection names the machine it was connecting to: Node writes the address and port
 * after the code ("connect ECONNREFUSED <address>:<port>", "getaddrinfo ENOTFOUND <host>"), a
 * TLS check writes the host and the names on the certificate, and the database client writes
 * the host it was given. None of that is for the oracle's logs, its alerts or its reports, so
 * network peer details are never kept. The code and the system call are, since they are what
 * an operator acts on ("connect ECONNREFUSED" says the database refused, "getaddrinfo
 * ENOTFOUND" that its name does not resolve).
 *
 * What is removed: whatever Node writes after a network error code; the host and certificate
 * names a TLS error gives; the host the database client quotes; "port N"; every IPv4 address,
 * with or without a port; every IPv6 address, bracketed or not, with or without a port (written
 * bare, one with "::" or with all eight groups, so a time such as 12:30:45 is left alone); and
 * a dotted host name or localhost with a port. A source file with a line number ("x.js:10:5")
 * is a stack frame, not a host, and is kept. A host name written alone, outside these shapes,
 * is not recognised: it reads like any dotted word. The configured database host is removed by
 * value wherever it is written (requestSecrets.js).
 *
 * Every pattern starts only at the beginning of a run (a left boundary) and repeats a bounded
 * number of times, so no text is rescanned from every position inside a long run.
 */

const PEER_REMOVED = "[peer removed]";

// The codes after which Node writes the peer it was talking to.
const NETWORK_CODES = [
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_FAIL",
  "EAI_NONAME",
  "EAI_NODATA",
  "ENODATA",
  "ESERVFAIL",
  "EHOSTUNREACH",
  "EHOSTDOWN",
  "ENETUNREACH",
  "ENETDOWN",
  "EADDRNOTAVAIL",
  "EADDRINUSE",
  "ENOTCONN",
  "EPIPE",
  "EPROTO",
];
// What follows the code, unless it was already removed ("[address removed]").
const AFTER_CODE = new RegExp(`\\b(${NETWORK_CODES.join("|")})([ \\t]+)(?!\\[)\\S+`, "g");

// The names a TLS error gives: the host it checked, and the names and addresses on the
// certificate ("Host: <host>.", "DNS:<name>", "IP: <address>", "CN=<name>").
const TLS_NAME = /\b([Hh]ost|DNS|IP(?: Address)?|URI|CN|[Ss]ervername)(\s*[:=]\s*)(?!\[)[^\s,;]+/g;

// The host the database client quotes ('for host "<host>"', 'server at "<host>"').
const QUOTED_HOST = /\b(host|server at)(\s+)"[^"\n]{0,255}"/g;

const PORT_PHRASE = /\bport\s+\d{1,5}\b/g;

const IPV6_BRACKETED =
  /\[[0-9a-f.]{0,39}:[0-9a-f.]{0,39}:[0-9a-f:.]{0,39}(?:%[\w.-]{1,32})?\](?::\d{1,5})?/gi;

const IPV4 = /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?!\.?\d)/g;

const GROUP = "[0-9a-f]{1,4}";
const ZONE = "(?:%[\\w.-]{1,32})?";
const IPV6_BARE = new RegExp(
  [
    // With "::", groups on either side or none.
    `(?<![\\w:.])(?:${GROUP}(?::${GROUP}){0,6})?::(?:${GROUP}(?::${GROUP}){0,6})?${ZONE}(?![\\w:])`,
    // All eight groups.
    `(?<![\\w:.])${GROUP}(?::${GROUP}){7}${ZONE}(?![\\w:])`,
  ].join("|"),
  "gi",
);

// A source file with its line: a stack frame, kept.
const SOURCE_FILE = "[\\w.-]{0,256}\\.(?:[cm]?[jt]sx?|json|sol|node):\\d";
const HOST = "(?:localhost|[a-z0-9][a-z0-9-]{0,62}(?:\\.[a-z0-9-]{1,63}){1,16})";
const HOST_WITH_PORT = new RegExp(
  `(?<![\\w.@/\\\\-])(?!${SOURCE_FILE})${HOST}:\\d{1,5}(?!\\d)`,
  "gi",
);

/**
 * @param {string} text
 * @returns {string} The text with every network peer it names replaced; anything that is not a
 *   string is returned as it is.
 */
function withoutNetworkPeers(text) {
  if (typeof text !== "string") return text;

  return text
    .replace(AFTER_CODE, `$1$2${PEER_REMOVED}`)
    .replace(TLS_NAME, `$1$2${PEER_REMOVED}`)
    .replace(QUOTED_HOST, `$1$2"${PEER_REMOVED}"`)
    .replace(PORT_PHRASE, `port ${PEER_REMOVED}`)
    .replace(IPV6_BRACKETED, PEER_REMOVED)
    .replace(IPV4, PEER_REMOVED)
    .replace(IPV6_BARE, PEER_REMOVED)
    .replace(HOST_WITH_PORT, PEER_REMOVED);
}

module.exports = { withoutNetworkPeers, PEER_REMOVED };
