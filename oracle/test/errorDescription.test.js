const { expect } = require("chai");
const util = require("node:util");
const { ethers } = require("ethers");
const {
  describeError,
  describedError,
  errorKind,
  withoutAddresses,
} = require("../src/errorDescription");
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

    it("removes an address carried by the original's name, from the name and the stack", () => {
      const original = new Error("fetch failed");
      original.name = "FetchError https://rpc.example/v2/not-a-real-key";

      const error = describedError(original);

      expect(error.name).to.equal("FetchError [address removed]");
      expect(error.stack).to.not.include("not-a-real-key");
      expect(util.inspect(error, { depth: 10 })).to.not.include("not-a-real-key");
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
