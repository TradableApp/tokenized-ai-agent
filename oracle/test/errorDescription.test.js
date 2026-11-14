const { expect } = require("chai");
const util = require("node:util");
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

  it("is false for a revert, a plain error and a value that is not an error", () => {
    expect(isTransientProviderError({ code: "CALL_EXCEPTION" })).to.be.false;
    expect(isTransientProviderError(new Error("Decryption failed"))).to.be.false;
    expect(isTransientProviderError(null)).to.be.false;
  });
});
