const { expect } = require("chai");

const { withoutNetworkPeers, PEER_REMOVED } = require("../src/networkPeers");

/**
 * A failed connection names the machine it was connecting to. The oracle's database and its
 * other peers are not for its logs, its alerts or its reports, so network peer details are never
 * kept: the error's code and system call are, since that is what an operator acts on.
 *
 * Every address and name here is from the ranges set aside for documentation.
 */
describe("networkPeers — network peer details are never kept", () => {
  const shapes = [
    ["a refused connection to an IPv4 address and port", "connect ECONNREFUSED 192.0.2.10:5432"],
    ["a refused connection to an IPv6 address and port", "connect ECONNREFUSED 2001:db8::10:5432"],
    ["a timed-out connection", "connect ETIMEDOUT 198.51.100.7:5432"],
    ["an unreachable host", "connect EHOSTUNREACH 203.0.113.4:5432"],
    ["an unreachable network", "connect ENETUNREACH 2001:db8:1::4:443"],
    ["a name that does not resolve", "getaddrinfo ENOTFOUND db.example.com"],
    ["a name lookup to try again", "getaddrinfo EAI_AGAIN db.example.com"],
    ["a reset naming its peer", "read ECONNRESET 192.0.2.11:5432"],
    ["a socket path", "connect ECONNREFUSED /var/run/postgresql/.s.PGSQL.5432"],
  ];

  for (const [shape, text] of shapes) {
    it(`keeps the code and the call of ${shape}, and nothing of the peer`, () => {
      const [call, code, peer] = text.split(" ");

      const cleaned = withoutNetworkPeers(text);

      expect(cleaned).to.equal(`${call} ${code} ${PEER_REMOVED}`);
      expect(cleaned).to.not.include(peer);
    });
  }

  it("removes an IPv4 address wherever it is written, with or without a port", () => {
    for (const text of [
      "cannot reach 198.51.100.9",
      "upstream 203.0.113.7:8545 closed",
      "(192.0.2.4), refused",
    ]) {
      const cleaned = withoutNetworkPeers(text);

      expect(cleaned, text).to.include(PEER_REMOVED);
      expect(cleaned, text).to.not.match(/\d+\.\d+\.\d+\.\d+/);
    }
  });

  it("removes an IPv6 address, bracketed or not, with or without a port", () => {
    for (const [text, gone] of [
      ["peer [2001:db8::1]:5432 closed", "2001:db8::1"],
      ["peer [2001:db8::1] closed", "2001:db8::1"],
      ["peer 2001:db8::1 closed", "2001:db8::1"],
      ["peer 2001:db8:0:0:0:0:0:1 closed", "2001:db8:0:0:0:0:0:1"],
      ["peer ::1 closed", "::1"],
    ]) {
      const cleaned = withoutNetworkPeers(text);

      expect(cleaned, text).to.equal(`peer ${PEER_REMOVED} closed`);
      expect(cleaned, text).to.not.include(gone);
    }
  });

  it("removes a host name with a port", () => {
    expect(withoutNetworkPeers("db.example.com:5432 refused")).to.equal(`${PEER_REMOVED} refused`);
    expect(withoutNetworkPeers("to localhost:5432 refused")).to.equal(`to ${PEER_REMOVED} refused`);
  });

  it("removes the host and the certificate names a TLS error gives", () => {
    const altnames = withoutNetworkPeers(
      "Hostname/IP does not match certificate's altnames: Host: db.example.com. is not in the cert's altnames: DNS:*.example.net, DNS:example.net",
    );
    const ipList = withoutNetworkPeers(
      "Hostname/IP does not match certificate's altnames: IP: 203.0.113.5 is not in the cert's list: 203.0.113.6",
    );
    const subject = withoutNetworkPeers("certificate subject CN=db.example.com rejected");

    expect(altnames).to.not.include("example.com");
    expect(altnames).to.not.include("example.net");
    expect(altnames).to.include("does not match certificate's altnames");
    expect(ipList).to.not.include("203.0.113");
    expect(subject).to.not.include("example.com");
  });

  it("removes the peer from the connection errors of the database client", () => {
    const hba = withoutNetworkPeers(
      'no pg_hba.conf entry for host "192.0.2.4", user "oracle", database "oracle_agent", SSL off',
    );
    const libpq = withoutNetworkPeers(
      'connection to server at "db.example.com" (192.0.2.4), port 5432 failed: timeout expired',
    );

    expect(hba).to.not.include("192.0.2.4");
    expect(libpq).to.not.include("db.example.com");
    expect(libpq).to.not.include("192.0.2.4");
    expect(libpq).to.not.include("5432");
    expect(libpq).to.include("timeout expired");
  });

  it("leaves text with no peer in it as it was", () => {
    for (const text of [
      "read ECONNRESET",
      "socket hang up",
      "Client network socket disconnected before secure TLS connection was established",
      "self-signed certificate in certificate chain",
      "SERVER_ERROR: server response 429 Too Many Requests",
      "retried at 12:30:45 after 3 attempts",
      "    at poll (/app/src/eventPoller.js:10:5)",
      "    at Object.<anonymous> (eventPoller.js:10:5)",
      "    at node:internal/process/task_queues:95:5",
      "Validation Failed for PromptSubmitted (ZodError).",
      "version 1.2.3 of the plugin",
    ]) {
      expect(withoutNetworkPeers(text), text).to.equal(text);
    }
  });

  it("gives back anything that is not text as it is", () => {
    expect(withoutNetworkPeers(undefined)).to.equal(undefined);
    expect(withoutNetworkPeers(42)).to.equal(42);
  });

  it("takes a long run of address-like text in linear time", () => {
    const started = Date.now();

    withoutNetworkPeers(`${"1.".repeat(100000)} ${"a:".repeat(100000)} ${"x.".repeat(100000)}`);

    expect(Date.now() - started).to.be.below(1000);
  });
});
