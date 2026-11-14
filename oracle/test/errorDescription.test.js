const { expect } = require("chai");
const { describeError } = require("../src/errorDescription");
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
});
