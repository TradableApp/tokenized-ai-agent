const { expect } = require("chai");
const util = require("node:util");
const { ethers } = require("ethers");
const {
  describeError,
  describedError,
  describedText,
  errorKind,
  withoutAddresses,
  MAX_DESCRIBED_LENGTH,
  MAX_RAW_INPUT,
} = require("../src/errorDescription");
// What stands where a network peer was (networkPeers.js).
const PEER_REMOVED = "[peer removed]";
const { isTransientProviderError } = require("../src/errors");
const { refusedByProvider } = require("./helpers/refusedByProvider");

describe("errorDescription — what an error is, without the address it was sent to", () => {
  it("the error ethers throws carries the request address in its message", () => {
    // The reason this module exists: logging `error.message` would print it.
    expect(refusedByProvider().message).to.include("rpc.example/v2/not-a-real-key");
  });

  it("describes a provider error by code, short message and status, with no address", () => {
    const text = describeError(refusedByProvider());

    expect(text).to.equal("SERVER_ERROR: server response 429 Too Many Requests");
    expect(text).to.not.include("rpc.example");
    expect(text).to.not.include("not-a-real-key");
  });

  it("keeps a plain error's message", () => {
    expect(describeError(new Error("queue write failed"))).to.equal("queue write failed");
  });

  it("removes any address from a plain error's message", () => {
    const text = describeError(
      new Error("connect ECONNREFUSED https://rpc.example/v2/not-a-real-key while polling"),
    );

    expect(text).to.equal("connect ECONNREFUSED [address removed] while polling");
  });

  it("takes everything up to the next space with the address, punctuation included", () => {
    // Deliberately greedy: stopping at a dot or a colon would stop inside the host name and
    // leave the path, which is where a provider puts the access key.
    expect(
      describeError(
        new Error("connect failed to https://rpc.example:8545/v2/not-a-real-key: timeout"),
      ),
    ).to.equal("connect failed to [address removed] timeout");
  });

  it("removes websocket addresses too", () => {
    expect(describeError(new Error("closed wss://rpc.example/ws/not-a-real-key"))).to.equal(
      "closed [address removed]",
    );
  });

  it("describes a value that is not an Error without throwing", () => {
    expect(describeError(null)).to.equal("null");
    expect(describeError(undefined)).to.equal("undefined");
    expect(describeError("rpc down")).to.equal("rpc down");
    expect(describeError({ code: "TIMEOUT" })).to.equal("TIMEOUT");
  });

  it("removes addresses from any text", () => {
    expect(withoutAddresses("GET https://rpc.example/v2/not-a-real-key failed")).to.equal(
      "GET [address removed] failed",
    );
    expect(withoutAddresses("nothing to remove")).to.equal("nothing to remove");
  });

  it("removes an address whatever its scheme, host form or escaping", () => {
    for (const address of [
      "http://[::1]:8545/v2/not-a-real-key",
      "postgres://oracle:not-a-real-key@db.example/oracle_agent",
      "https:\\/\\/rpc.example\\/v2\\/not-a-real-key",
    ]) {
      const text = withoutAddresses(`request to ${address} failed`);
      expect(text, address).to.equal("request to [address removed] failed");
    }
    expect(withoutAddresses("xhttps://rpc.example/v2/not-a-real-key")).to.not.include(
      "not-a-real-key",
    );
  });

  // The pattern is run on any text an error carries, so its cost must grow with the text and no
  // faster: a long unbroken run of characters a scheme may hold once took tens of seconds on
  // 200,000 characters, blocking the event loop the whole time.
  it("costs time in proportion to the text, however it is made", function () {
    this.timeout(120000);
    const length = 200000;
    for (const [name, text] of [
      ["letters", "a".repeat(length)],
      ["letters and digits", "a1".repeat(length / 2)],
      ["digits then letters", "1a".repeat(length / 2)],
      ["letters and dots", "a.".repeat(length / 2)],
      ["letters, then a colon and one slash", `${"a".repeat(length)}:/`],
      ["colons without slashes", "a:".repeat(length / 2)],
      ["signs then a letter", `${"-".repeat(length)}a`],
    ]) {
      const started = process.hrtime.bigint();
      withoutAddresses(text);
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      expect(elapsedMs, `${name}: ${elapsedMs.toFixed(0)} ms`).to.be.below(1000);
    }
  });

  it("still removes addresses with ordinary schemes, wherever they stand", () => {
    for (const address of [
      "https://rpc.example/v2/not-a-real-key",
      "http://rpc.example:8545/not-a-real-key",
      "wss://rpc.example/ws/not-a-real-key",
      "ws://localhost:8546/not-a-real-key",
      "postgresql://oracle:not-a-real-key@db.example:5432/oracle_agent",
      "redis://:not-a-real-key@cache.example:6379/0",
      "mongodb+srv://oracle:not-a-real-key@cluster.example/db",
      "git+ssh://git@host.example/not-a-real-key.git",
      "chrome-extension://not-a-real-key/page.html",
    ]) {
      for (const text of [
        `${address}`,
        `request to ${address} failed`,
        `(${address})`,
        `url=${address}`,
        `"${address}"`,
        `<${address}>`,
        `failed:${address}`,
      ]) {
        expect(withoutAddresses(text), text).to.not.include("not-a-real-key");
        expect(withoutAddresses(text), text).to.include("[address removed]");
      }
    }
  });

  // A scheme is matched from the first letter of the run of scheme characters before it, as it
  // always was; characters before that letter that a scheme cannot start with stay in the text.
  it("removes an address glued to the characters before it, whatever their length", () => {
    expect(withoutAddresses("1https://rpc.example/v2/not-a-real-key")).to.equal(
      "1[address removed]",
    );
    expect(withoutAddresses("--https://rpc.example/v2/not-a-real-key")).to.equal(
      "--[address removed]",
    );
    expect(withoutAddresses("see.https://rpc.example/v2/not-a-real-key")).to.equal(
      "[address removed]",
    );
    const glued = `${"a".repeat(40)}https://rpc.example/v2/not-a-real-key`;
    expect(withoutAddresses(glued)).to.equal("[address removed]");
    expect(withoutAddresses(`x ${"7".repeat(40)}wss://rpc.example/not-a-real-key y`)).to.equal(
      `x ${"7".repeat(40)}[address removed] y`,
    );
  });

  it("keeps text that holds no address", () => {
    for (const text of [
      "a".repeat(1000),
      "time: 12:30:45",
      "ratio 3:/4",
      "path C:/data/file",
      "a:/b",
    ]) {
      expect(withoutAddresses(text), text).to.equal(text);
    }
  });

  it("keeps the public address an alert sends the operator to", () => {
    const text = "Please top up the account at https://ai3.storage/";
    expect(withoutAddresses(text)).to.equal(text);
    // Only that address exactly: anything after it is treated like any other address.
    expect(withoutAddresses("https://ai3.storage/v1/not-a-real-key")).to.equal("[address removed]");
  });

  // Node's fetch fails with "fetch failed" and puts what happened in `cause`. Its kind is what
  // tells a refused connection from a timeout; its message may carry the address.
  describe("an error with a cause", () => {
    const refused = () =>
      Object.assign(new Error("connect ECONNREFUSED https://rpc.example/v2/not-a-real-key"), {
        code: "ECONNREFUSED",
      });

    it("is described with its cause's kind and never its cause's message", () => {
      const text = describeError(new Error("fetch failed", { cause: refused() }));

      expect(text).to.equal("fetch failed (cause: ECONNREFUSED)");
      expect(describedError(new Error("fetch failed", { cause: refused() })).message).to.equal(
        text,
      );
    });

    it("takes the cause's name where it has no code", () => {
      expect(describeError(new Error("x", { cause: new TypeError("bad") }))).to.equal(
        "x (cause: TypeError)",
      );
    });

    it("cleans a cause whose code or name carries an address", () => {
      const cause = { code: "https://rpc.example/v2/not-a-real-key", name: "postgres://u:pw@db/a" };

      const text = describeError(new Error("fetch failed", { cause }));

      expect(text).to.equal("fetch failed (cause: Error)");
      expect(text).to.not.include("not-a-real-key");
    });

    it("goes one level down only", () => {
      const cause = { code: "EAI_AGAIN", cause: { code: "ENOTFOUND" } };

      expect(describeError(new Error("fetch failed", { cause }))).to.equal(
        "fetch failed (cause: EAI_AGAIN)",
      );
    });

    it("adds nothing when there is no cause", () => {
      expect(describeError(new Error("fetch failed"))).to.equal("fetch failed");
      expect(describeError(new Error("x", { cause: undefined }))).to.equal("x");
    });
  });

  describe("a revert", () => {
    const revert = (extra) =>
      ethers.makeError("execution reverted (unknown custom error)", "CALL_EXCEPTION", {
        action: "estimateGas",
        data: "0x82b42900",
        reason: null,
        transaction: { to: null, data: "0x" },
        invocation: null,
        revert: null,
        ...extra,
      });

    it("is described with its revert data, which is what identifies it", () => {
      expect(describeError(revert())).to.equal(
        "CALL_EXCEPTION: execution reverted (unknown custom error) (revert data 0x82b42900)",
      );
    });

    it("is described with the decoded error when ethers decoded one", () => {
      expect(
        describeError(
          revert({ revert: { signature: "JobAlreadyFinalized()", name: "x", args: [] } }),
        ),
      ).to.include("(reverted with JobAlreadyFinalized())");
    });

    it("marks long revert data as cut", () => {
      const text = describeError(revert({ data: `0x${"ab".repeat(200)}` }));

      expect(text).to.match(/\(revert data 0x(ab){68}…\)$/);
    });

    it("adds nothing when the revert carries no data", () => {
      expect(describeError(revert({ data: null }))).to.equal(
        "CALL_EXCEPTION: execution reverted (unknown custom error)",
      );
    });
  });

  describe("describedError — an error that can be thrown, logged or reported whole", () => {
    it("has the description as its message and no address anywhere in it", () => {
      const error = describedError(refusedByProvider(503, "Service Unavailable"));

      expect(error).to.be.an.instanceOf(Error);
      expect(error.message).to.equal("SERVER_ERROR: server response 503 Service Unavailable");
      expect(util.inspect(error, { depth: 10 })).to.not.include("rpc.example");
    });

    it("keeps the frames of the original, so the failure can still be located", () => {
      const original = new Error("failed at https://rpc.example/v2/not-a-real-key");

      const error = describedError(original);

      expect(error.stack.split("\n").slice(1)).to.deep.equal(original.stack.split("\n").slice(1));
      expect(error.stack).to.not.include("rpc.example");
    });

    it("removes an address carried by a frame of the original", () => {
      const original = new Error("fetch failed");
      original.stack = [
        "Error: fetch failed",
        "    at request (https://rpc.example/v2/not-a-real-key:1:20)",
        "    at poll (/app/src/eventPoller.js:10:5)",
      ].join("\n");

      const error = describedError(original);

      expect(error.stack).to.not.include("not-a-real-key");
      expect(error.stack.split("\n")).to.deep.equal([
        "Error: fetch failed",
        "    at request ([address removed])",
        "    at poll (/app/src/eventPoller.js:10:5)",
      ]);
    });

    it("keeps the original's name only when it is one short word, in the name and the stack", () => {
      const original = new Error("fetch failed");
      original.name = "FetchError https://rpc.example/v2/not-a-real-key";

      const error = describedError(original);

      expect(error.name).to.equal("Error");
      expect(error.stack).to.not.include("not-a-real-key");
      expect(util.inspect(error, { depth: 10 })).to.not.include("not-a-real-key");
      expect(describedError(new TypeError("x")).name).to.equal("TypeError");
    });

    it("keeps no network peer field of the original", () => {
      const original = Object.assign(new Error("connect ECONNREFUSED 192.0.2.10:5432"), {
        code: "ECONNREFUSED",
        syscall: "connect",
        address: "192.0.2.10",
        port: 5432,
        hostname: "db.example.com",
        host: "db.example.com",
      });

      const error = describedError(original);

      expect(error.code).to.equal("ECONNREFUSED");
      for (const field of ["address", "port", "hostname", "host"]) {
        expect(error, field).to.not.have.property(field);
      }
      const shown = util.inspect(error, { depth: 10 });
      expect(shown).to.not.include("192.0.2.10");
      expect(shown).to.not.include("db.example.com");
    });

    it("keeps the code, which callers branch on", () => {
      expect(describedError(refusedByProvider()).code).to.equal("SERVER_ERROR");
    });

    it("makes an error of a value that is not one", () => {
      expect(describedError("down: https://rpc.example/k").message).to.equal(
        "down: [address removed]",
      );
    });
  });
});

describe("errorKind — what kind of error it was, and nothing it says", () => {
  it("is the error's code when it has one", () => {
    const error = Object.assign(new Error("connect to postgres://user:pw@db/agent failed"), {
      code: "ECONNREFUSED",
    });

    expect(errorKind(error)).to.equal("ECONNREFUSED");
  });

  it("is the error's name when it has no code", () => {
    expect(errorKind(new TypeError("postgres://user:pw@db/agent is not valid"))).to.equal(
      "TypeError",
    );
  });

  it("is a numeric code as text", () => {
    expect(errorKind({ code: 503, message: "down" })).to.equal("503");
  });

  it("is never text that spans lines", () => {
    const error = Object.assign(new Error("x"), { code: "E1\nforged log line" });

    expect(errorKind(error)).to.equal("Error");
  });

  it("is never an address", () => {
    const error = { code: "postgres://user:pw@db/agent", name: "https://rpc.example/v2/key" };

    expect(errorKind(error)).to.equal("Error");
  });

  it("is at most 64 characters", () => {
    expect(errorKind({ code: "E".repeat(65) })).to.equal("Error");
    expect(errorKind({ code: "E".repeat(64) })).to.equal("E".repeat(64));
  });

  it("is only a code or name given as text or a number", () => {
    const code = { toString: () => "ECONNREFUSED" };

    expect(errorKind({ code })).to.equal("Error");
  });

  it("does not throw for an error whose code cannot be read", () => {
    const error = {};
    Object.defineProperty(error, "code", {
      get() {
        throw new Error("no");
      },
    });

    expect(errorKind(error)).to.equal("Error");
  });

  it("is the error's name when its code cannot be read", () => {
    const error = new TypeError("x");
    Object.defineProperty(error, "code", {
      get() {
        throw new Error("no");
      },
    });

    expect(errorKind(error)).to.equal("TypeError");
  });

  it("does not throw for an error whose name cannot be read", () => {
    const error = {};
    Object.defineProperty(error, "name", {
      get() {
        throw new Error("no");
      },
    });

    expect(errorKind(error)).to.equal("Error");
  });

  it("reads an object with no prototype", () => {
    const error = Object.assign(Object.create(null), { code: "ECONNRESET" });

    expect(errorKind(error)).to.equal("ECONNRESET");
    expect(errorKind(Object.create(null))).to.equal("Error");
  });

  it("is Error for a value with neither, never its message", () => {
    expect(errorKind({ message: "postgres://user:pw@db/agent" })).to.equal("Error");
    expect(errorKind(null)).to.equal("Error");
    expect(errorKind(undefined)).to.equal("Error");
  });
});

describe("isTransientProviderError — a provider request that a later attempt may get through", () => {
  it("is true for a refused or failed request", () => {
    expect(isTransientProviderError(refusedByProvider(429, "Too Many Requests"))).to.be.true;
    expect(isTransientProviderError(refusedByProvider(503, "Service Unavailable"))).to.be.true;
    expect(isTransientProviderError({ code: "TIMEOUT" })).to.be.true;
    expect(isTransientProviderError({ code: "NETWORK_ERROR" })).to.be.true;
  });

  // What ethers builds for a JSON-RPC error answered to eth_call or eth_estimateGas: a call
  // exception with no revert data, and the provider's own error under `info.error`.
  const answeredWith = (rpcError) => ({
    code: "CALL_EXCEPTION",
    data: null,
    info: { error: rpcError, payload: { method: "eth_estimateGas" } },
  });

  it("is true for a JSON-RPC error that is not a revert", () => {
    expect(isTransientProviderError(answeredWith({ code: -32005, message: "rate limit exceeded" })))
      .to.be.true;
    expect(isTransientProviderError(answeredWith({ code: -32000, message: "header not found" }))).to
      .be.true;
    expect(isTransientProviderError({ code: "UNKNOWN_ERROR" })).to.be.true;
    // A provider behind a load balancer answering with a stale pending nonce.
    expect(isTransientProviderError({ code: "NONCE_EXPIRED" })).to.be.true;
    expect(isTransientProviderError({ code: "REPLACEMENT_UNDERPRICED" })).to.be.true;
  });

  it("is false for a revert the provider reported without its data", () => {
    // Some providers leave the data out of a revert on eth_estimateGas. It is still the
    // contract's answer, and trying again would pay for the same refusal each time.
    expect(isTransientProviderError(answeredWith({ code: 3, message: "execution reverted" }))).to.be
      .false;
    expect(
      isTransientProviderError(answeredWith({ code: -32000, message: "VM Exception: revert" })),
    ).to.be.false;
    // Nothing to tell which it was: not assumed transient.
    expect(isTransientProviderError({ code: "CALL_EXCEPTION", data: null })).to.be.false;
    expect(isTransientProviderError(answeredWith({ code: -32000 }))).to.be.false;
  });

  it("is false for a revert that carries data or was mined", () => {
    expect(isTransientProviderError({ code: "CALL_EXCEPTION", data: "0x82b42900" })).to.be.false;
    expect(isTransientProviderError({ code: "CALL_EXCEPTION", data: null, receipt: {} })).to.be
      .false;
  });

  it("is false for a revert, a plain error and a value that is not an error", () => {
    expect(isTransientProviderError({ code: "CALL_EXCEPTION", data: "0x" })).to.be.false;
    expect(isTransientProviderError(new Error("Decryption failed"))).to.be.false;
    expect(isTransientProviderError(null)).to.be.false;
  });

  describe("a configured access key with no address around it", () => {
    const { refreshRequestSecrets } = require("../src/requestSecrets");

    afterEach(() => refreshRequestSecrets(process.env));

    it("is removed from text as an address is", () => {
      refreshRequestSecrets({ RPC: "https://base.example/v2/aB3dE6gH9jK2mN5pQ8sT" });

      expect(withoutAddresses("request POST /v2/aB3dE6gH9jK2mN5pQ8sT refused")).to.equal(
        "request POST /v2/[REDACTED] refused",
      );
    });

    it("is removed from a host and path written without a scheme", () => {
      refreshRequestSecrets({ RPC: "https://base.example/v2/aB3dE6gH9jK2mN5pQ8sT" });

      expect(withoutAddresses("to base.example/v2/aB3dE6gH9jK2mN5pQ8sT refused")).to.equal(
        "to base.example/v2/[REDACTED] refused",
      );
    });

    // The documented limit: with no scheme to find and no configured value to match, a host
    // and path is ordinary text. Taking every word with a dot and a slash for an address would
    // blank file paths in every stack.
    it("leaves a host and path without a scheme that nothing configured names", () => {
      refreshRequestSecrets({});

      expect(withoutAddresses("to other.example/v2/zY9xW8vU7tS6rQ5pO4nM refused")).to.equal(
        "to other.example/v2/zY9xW8vU7tS6rQ5pO4nM refused",
      );
    });
  });
});

describe("describeError — one line of text, with nothing a reader outside the TEE may not see", () => {
  const { refreshRequestSecrets } = require("../src/requestSecrets");

  afterEach(() => refreshRequestSecrets(process.env));

  describe("a failed connection", () => {
    it("keeps the code and the call, and never the peer", () => {
      const error = Object.assign(new Error("connect ECONNREFUSED 192.0.2.10:5432"), {
        code: "ECONNREFUSED",
        syscall: "connect",
        address: "192.0.2.10",
        port: 5432,
      });

      expect(describeError(error)).to.equal(`connect ECONNREFUSED ${PEER_REMOVED}`);
    });

    it("keeps no peer from a name that does not resolve", () => {
      const error = Object.assign(new Error("getaddrinfo ENOTFOUND db.example.com"), {
        code: "ENOTFOUND",
        hostname: "db.example.com",
      });

      expect(describeError(error)).to.equal(`getaddrinfo ENOTFOUND ${PEER_REMOVED}`);
    });

    it("keeps only the code of a connection tried at several addresses", () => {
      const error = new AggregateError([new Error("connect ECONNREFUSED 2001:db8::10:5432")], "");
      error.code = "ECONNREFUSED";

      expect(describeError(error)).to.equal("ECONNREFUSED");
    });

    it("keeps no peer from a cause or from a peer named outside a known shape", () => {
      const cause = Object.assign(new Error("connect ETIMEDOUT 198.51.100.7:5432"), {
        code: "ETIMEDOUT",
      });

      expect(describeError(new Error("fetch failed", { cause }))).to.equal(
        "fetch failed (cause: ETIMEDOUT)",
      );
      expect(describeError("cannot reach 203.0.113.9")).to.equal(`cannot reach ${PEER_REMOVED}`);
    });

    it("keeps no host from a TLS error", () => {
      const error = Object.assign(
        new Error(
          "Hostname/IP does not match certificate's altnames: Host: db.example.com. is not in the cert's altnames: DNS:*.example.net",
        ),
        { code: "ERR_TLS_CERT_ALTNAME_INVALID", host: "db.example.com" },
      );

      const text = describeError(error);

      expect(text).to.include("ERR_TLS_CERT_ALTNAME_INVALID");
      expect(text).to.not.include("example.com");
      expect(text).to.not.include("example.net");
    });
  });

  it("is the first line only", () => {
    expect(describeError(new Error("line one\nline two\nline three"))).to.equal("line one");
    expect(describeError(new Error("line one\r\nline two"))).to.equal("line one");
  });

  it("is capped, after it is cleaned", () => {
    expect(describeError(new Error("x ".repeat(5000))).length).to.be.at.most(MAX_DESCRIBED_LENGTH);
    expect(describeError(new Error("x".repeat(5000))).length).to.be.at.most(MAX_DESCRIBED_LENGTH);
    expect(MAX_DESCRIBED_LENGTH).to.be.within(100, 500);
  });

  it("says a value was removed when the cut leaves nothing of a long unbroken message", () => {
    const blob = "A".repeat(MAX_RAW_INPUT + 1);

    expect(describeError(new Error(blob))).to.equal("[value removed]");
    expect(describedText(` \n${blob}`)).to.equal("[value removed]");
    expect(describedText(""), "an empty text that was not cut stays empty").to.equal("");
  });

  it("never leaves part of a configured secret where the cap falls", () => {
    const secret = "Kq7Lm2Np9Rs4Tv6Wx8Yz3Ab5Cd";
    refreshRequestSecrets({ SOME_API_KEY: secret });

    for (let lead = MAX_DESCRIBED_LENGTH - 30; lead < MAX_DESCRIBED_LENGTH + 5; lead += 1) {
      const text = describeError(new Error(`${"a".repeat(lead)} ${secret} tail`));

      expect(text, String(lead)).to.not.include(secret.slice(0, 6));
    }
  });

  it("keeps the fact and the code of a failed query, never its text or its values", () => {
    // The message the query builder gives, with the database's error as its cause.
    const cause = Object.assign(new Error("duplicate key value violates unique constraint"), {
      code: "23505",
      detail: "Key (wallet)=(0x1111111111111111111111111111111111111111) already exists.",
      where: "SQL statement",
    });
    const query = "insert into activity (wallet, prompt) values ($1, $2)";
    const params = ["0x1111111111111111111111111111111111111111", "should I sell my coins"];
    const error = new Error(`Failed query: ${query}\nparams: ${params}`, { cause });

    const text = describeError(error);

    expect(text).to.equal("Failed query (cause: 23505)");
    expect(describedText(`Failed query: ${query} params: ${params}`)).to.equal("Failed query");
  });

  it("names the code of a database error and drops the values it quotes", () => {
    const quoted = Object.assign(
      new Error('invalid input syntax for type json: "my secret prompt about buying"'),
      { code: "22P02" },
    );
    const user = Object.assign(new Error('password authentication failed for user "oracle"'), {
      code: "28P01",
    });

    const quotedText = describeError(quoted);
    const userText = describeError(user);

    expect(quotedText).to.match(/^22P02: invalid input syntax for type json: /);
    expect(quotedText).to.not.include("secret prompt");
    expect(userText).to.match(/^28P01: password authentication failed for user /);
    expect(userText).to.not.include("oracle");
  });

  it("drops a quoted file path, and keeps an apostrophe in a word", () => {
    const text = describeError(
      Object.assign(new Error("ENOENT: no such file or directory, open '/home/u/keys/k.pem'"), {
        code: "ENOENT",
      }),
    );

    expect(text).to.match(/^ENOENT: no such file or directory, open /);
    expect(text).to.not.include("/home/u");
    expect(describeError(new Error("can't reach the store"))).to.equal("can't reach the store");
  });

  it("never echoes the request or the response of a model provider", () => {
    const error = Object.assign(
      new Error("Invalid JSON payload received at 'contents[0]': user said: how do I short it"),
      {
        name: "AI_APICallError",
        url: "https://models.example.com/v1/generate?key=Kq7Lm2Np9Rs4Tv6Wx8Yz",
        requestBodyValues: { prompt: "how do I short it" },
        responseBody: '{"error":"how do I short it"}',
        statusCode: 400,
      },
    );

    const text = describeError(error);

    expect(text).to.equal("AI_APICallError (status 400)");
    expect(describeError(Object.assign(new Error("x"), { name: "AI_RetryError" }))).to.equal(
      "AI_RetryError",
    );
  });

  it("keeps only the name and status of an error that carries a request or response body, whatever it is named", () => {
    const renamed = Object.assign(new Error("upstream said: how do I short it"), {
      name: "ProviderError",
      responseBody: '{"error":"how do I short it"}',
      statusCode: 502,
    });

    expect(describeError(renamed)).to.equal("ProviderError (status 502)");
  });

  it("removes a bearer token, a JWT and a long base64 run", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlLXRoYXQtaXMtbG9uZw";
    const base64 = "QWxhZGRpbjpvcGVuIHNlc2FtZSBhbmQgbW9yZSBieXRlcw2";

    expect(describeError(new Error(`Authorization: Bearer ${jwt}`))).to.not.include("eyJ");
    expect(describeError(new Error(`Authorization: Bearer abc.def-123_x`))).to.not.include(
      "abc.def-123_x",
    );
    expect(describeError(new Error(`token ${jwt} expired`))).to.not.include("eyJ");
    expect(describeError(new Error(`bad blob ${base64} here`))).to.equal(
      "bad blob [value removed] here",
    );
  });

  it("removes a wallet address and long hex from the message, and keeps revert data", () => {
    const wallet = "0xAbCdEf0123456789abcdef0123456789ABCDEF01";

    expect(describeError(new Error(`no plan for ${wallet}`))).to.equal(
      "no plan for [value removed]",
    );
    expect(describeError(new Error(`blob ${"ab12".repeat(8)} bad`))).to.equal(
      "blob [value removed] bad",
    );
    // A four-byte selector names the error and is kept.
    expect(describeError(new Error("reverted with 0x82b42900"))).to.equal(
      "reverted with 0x82b42900",
    );
    const revert = ethers.makeError("execution reverted (unknown custom error)", "CALL_EXCEPTION", {
      data: `0x82b42900${"0".repeat(24)}${"11".repeat(20)}`,
    });
    expect(describeError(revert)).to.include(`(revert data 0x82b42900`);
  });

  it("removes an address whatever the case of its scheme", () => {
    expect(describeError(new Error("GET HTTPS://RPC.EXAMPLE/v2/NOTAREALKEY failed"))).to.equal(
      "GET [address removed] failed",
    );
  });

  it("describes any text the same way, for text that is not an error's", () => {
    expect(describedText("connect ECONNREFUSED 192.0.2.10:5432\nparams: x")).to.equal(
      `connect ECONNREFUSED ${PEER_REMOVED}`,
    );
    expect(describedText(undefined)).to.equal("undefined");
  });

  // The schema is public, and a database error an operator cannot act on is no use: the name of
  // the table, column, constraint or schema it is about is kept. Only that: a plain lower-case
  // name, quoted right after the word that says what it names.
  describe("a database identifier", () => {
    const pgError = (message, code) => Object.assign(new Error(message), { code });

    it("keeps the table of an undefined table", () => {
      expect(describeError(pgError('relation "failed_jobs" does not exist', "42P01"))).to.equal(
        '42P01: relation "failed_jobs" does not exist',
      );
    });

    it("keeps the column of an undefined column, and the table it was looked for in", () => {
      expect(describeError(pgError('column "last_error" does not exist', "42703"))).to.equal(
        '42703: column "last_error" does not exist',
      );
      expect(
        describeError(
          pgError('column "last_error" of relation "failed_jobs" does not exist', "42703"),
        ),
      ).to.equal('42703: column "last_error" of relation "failed_jobs" does not exist');
    });

    it("keeps the constraint a duplicate violates, and never the key's values", () => {
      const error = pgError(
        'duplicate key value violates unique constraint "failed_jobs_pkey"\nKey (id)=(0x1111111111111111111111111111111111111111) already exists.',
        "23505",
      );

      expect(describeError(error)).to.equal(
        '23505: duplicate key value violates unique constraint "failed_jobs_pkey"',
      );
    });

    it("keeps a missing schema, and a name qualified by its schema either way it is written", () => {
      expect(describeError(pgError('schema "senseai" does not exist', "3F000"))).to.equal(
        '3F000: schema "senseai" does not exist',
      );
      expect(describedText('relation "public.failed_jobs" does not exist')).to.equal(
        'relation "public.failed_jobs" does not exist',
      );
      expect(describedText('relation "public"."failed_jobs" does not exist')).to.equal(
        'relation "public"."failed_jobs" does not exist',
      );
    });

    it("keeps it after each word that names one, in any case, after up to eight spaces or tabs", () => {
      for (const word of [
        "relation",
        "column",
        "table",
        "constraint",
        "index",
        "type",
        "function",
        "schema",
        "sequence",
        "view",
      ]) {
        expect(describedText(`${word} "a_1" missing`)).to.equal(`${word} "a_1" missing`);
        expect(describedText(`${word.toUpperCase()} "a_1" missing`)).to.equal(
          `${word.toUpperCase()} "a_1" missing`,
        );
      }
      expect(describedText('relation\t"x" missing')).to.equal('relation\t"x" missing');
      expect(describedText(`relation${" ".repeat(8)}"x" missing`)).to.equal(
        `relation${" ".repeat(8)}"x" missing`,
      );
    });

    it("keeps a name of 63 characters and removes a longer one", () => {
      const longest = `n${"m".repeat(62)}`;

      expect(describedText(`relation "${longest}" missing`)).to.equal(
        `relation "${longest}" missing`,
      );
      expect(describedText(`relation "${longest}m" missing`)).to.equal(
        "relation [value removed] missing",
      );
    });

    it("removes a value after a word that names no identifier", () => {
      expect(describedText('password authentication failed for user "oracle"')).to.equal(
        "password authentication failed for user [value removed]",
      );
      expect(describedText('role "oracle_admin" does not exist')).to.equal(
        "role [value removed] does not exist",
      );
      expect(describedText('database "senseai_agent" does not exist')).to.equal(
        "database [value removed] does not exist",
      );
      expect(describedText('value "failed_jobs" is not allowed')).to.equal(
        "value [value removed] is not allowed",
      );
      expect(describedText('Key (id)=("failed_jobs") already exists')).to.equal(
        "Key (id)=([value removed]) already exists",
      );
    });

    it("removes the host, user and database of a refused connection", () => {
      const text = describedText(
        'no pg_hba.conf entry for host "db_primary", user "oracle", database "senseai"',
      );

      expect(text).to.not.include("db_primary");
      expect(text).to.not.include("oracle");
      expect(text).to.not.include("senseai");
    });

    it("removes anything that is not a plain lower-case name, or not right after the word", () => {
      expect(describedText("relation 'failed_jobs' does not exist")).to.equal(
        "relation [value removed] does not exist",
      );
      expect(describedText('relation "Failed_Jobs" does not exist')).to.equal(
        "relation [value removed] does not exist",
      );
      expect(describedText('relation "my secret prompt" does not exist')).to.equal(
        "relation [value removed] does not exist",
      );
      expect(describedText('relation "1abc" does not exist')).to.equal(
        "relation [value removed] does not exist",
      );
      expect(describedText('relation named "failed_jobs" does not exist')).to.equal(
        "relation named [value removed] does not exist",
      );
      expect(describedText('correlation "failed_jobs" missing')).to.equal(
        "correlation [value removed] missing",
      );
      expect(describedText(`relation${" ".repeat(9)}"x" missing`)).to.equal(
        `relation${" ".repeat(9)}[value removed] missing`,
      );
      expect(describedText('relation "a"."b"."c" missing')).to.not.include('"c"');
      expect(describedText('relation "a.b.c" missing')).to.equal(
        "relation [value removed] missing",
      );
      expect(describedText('relation"failed_jobs" missing')).to.equal(
        "relation[value removed] missing",
      );
    });

    // Every part of a qualified name is a name: a schema in front does not carry a value through.
    it("removes a qualified name whose second part is not a plain name", () => {
      expect(describedText('relation "public"."my secret prompt" missing')).to.equal(
        "relation [value removed] missing",
      );
      expect(describedText('relation "public"."Failed_Jobs" missing')).to.equal(
        "relation [value removed] missing",
      );
    });

    it("still removes a kept name that is long hex or a long base64 run", () => {
      expect(describedText('relation "deadbeefdeadbeefdeadbeef" missing')).to.not.include(
        "deadbeef",
      );
      expect(
        describedText('relation "a1_b2_c3_d4_e5_f6_g7_h8_i9_j0_k1_l2" missing'),
      ).to.not.include("a1_b2");
    });

    it("still removes a name that is a configured secret", () => {
      refreshRequestSecrets({ SOME_API_KEY: "sense_ai_internal_key" });

      expect(describedText('relation "sense_ai_internal_key" does not exist')).to.equal(
        "relation [value removed] does not exist",
      );
      // Secrets are removed before quoted values are read, so a name that holds one is not a
      // plain name any more, and no part of it is kept.
      expect(describedText('relation "x_sense_ai_internal_key_y" does not exist')).to.equal(
        "relation [value removed] does not exist",
      );
    });

    it("still removes a name that is the configured database host, whatever its length", () => {
      refreshRequestSecrets({ POSTGRES_HOST: "db_primary" });

      expect(describedText('relation "db_primary" does not exist')).to.equal(
        "relation [value removed] does not exist",
      );
      expect(describedText('relation "public"."db_primary" does not exist')).to.equal(
        "relation [value removed] does not exist",
      );

      refreshRequestSecrets({ POSTGRES_URL: "postgresql://u:pw@agent_db/senseai" });

      expect(describedText('relation "agent_db" does not exist')).to.equal(
        "relation [value removed] does not exist",
      );
      expect(describedText('relation "failed_jobs" does not exist')).to.equal(
        'relation "failed_jobs" does not exist',
      );
    });
  });
});
