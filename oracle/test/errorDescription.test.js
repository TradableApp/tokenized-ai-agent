const { expect } = require("chai");
const util = require("node:util");
const { ethers } = require("ethers");
const { describeError, describedError, withoutAddresses } = require("../src/errorDescription");
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
});
