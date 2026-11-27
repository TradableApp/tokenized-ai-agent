const { expect } = require("chai");
const { makeError } = require("ethers");

const { failureText } = require("../scripts/lib/failureText");

class Refusal extends Error {}

describe("scripts: what a failed run prints", () => {
  it("prints a refusal's own message whole, since the script wrote it", () => {
    const text = failureText(new Refusal("The only option is --check. Nothing was sent."), Refusal);
    expect(text).to.equal("The only option is --check. Nothing was sent.");
  });

  it("describes a provider's error without the request's address, and keeps where it was thrown", () => {
    // What ethers throws for a refused request: the address, key included, is in the message,
    // and so in the first line of the stack.
    const error = makeError("server response 401", "SERVER_ERROR", {
      request: { url: "https://rpc.example/v2/abcdefghijklmnopqrstuvwxyz0123456789" },
      info: { requestUrl: "https://rpc.example/v2/abcdefghijklmnopqrstuvwxyz0123456789" },
    });
    expect(error.stack).to.include("abcdefghijklmnopqrstuvwxyz0123456789");

    const text = failureText(error, Refusal);

    expect(text).to.not.include("rpc.example");
    expect(text).to.not.include("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(text.split("\n")[0]).to.include("server response 401");
    // The frames say where it was thrown; they hold file paths, never the message.
    expect(text).to.match(/\n\s+at .+listingFailureLine\.test\.js:\d+:\d+/);
  });

  it("does not take a line of the message that starts like a frame for a frame", () => {
    // A stack starts with the message, every line of it. A message line that begins "    at "
    // is still part of the message, so it is printed once, with its address removed.
    const error = new Error(
      "server error\n    at https://rpc.example/v2/abcdefghijklmnopqrstuvwxyz0123456789",
    );

    const text = failureText(error);

    expect(text).to.not.include("rpc.example");
    expect(text).to.not.include("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(text.split("\n")[0]).to.equal("server error");
    expect(text).to.match(/\n\s+at .+listingFailureLine\.test\.js:\d+:\d+/);
  });

  it("removes a configured key written without its address, when the setting came after loading", () => {
    const before = process.env.FAILURE_TEXT_TEST_RPC_URL;
    process.env.FAILURE_TEXT_TEST_RPC_URL =
      "https://rpc.example/v2/zyxwvutsrqponmlkjihgfedcba987654";
    try {
      const text = failureText(new Error("POST /v2/zyxwvutsrqponmlkjihgfedcba987654 refused"));
      expect(text).to.not.include("zyxwvutsrqponmlkjihgfedcba987654");
      expect(text).to.include("refused");
    } finally {
      if (before === undefined) delete process.env.FAILURE_TEXT_TEST_RPC_URL;
      else process.env.FAILURE_TEXT_TEST_RPC_URL = before;
    }
  });

  it("prints something for a thrown value that is not an error", () => {
    expect(failureText(undefined, Refusal)).to.be.a("string").and.not.equal("");
  });
});
