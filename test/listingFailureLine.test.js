const { expect } = require("chai");

const { failureLine, ListingError } = require("../scripts/list-fee-token-exempt");

describe("list-fee-token-exempt: what a failed run prints", () => {
  it("prints a refusal's own message whole, since the script wrote it", () => {
    const line = failureLine(new ListingError("The only option is --check. Nothing was sent."));
    expect(line).to.equal("The only option is --check. Nothing was sent.");
  });

  it("prints one line with no address for any other error, never its stack", () => {
    // What a provider error looks like: the request's address, key included, is in the message.
    const error = new Error(
      'could not detect network (request={ "url": "https://rpc.example/v2/abcdefghijklmnopqrstuvwxyz0123456789" })',
    );
    const line = failureLine(error);
    expect(line).to.not.include("rpc.example");
    expect(line).to.not.include("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(line).to.not.include("\n");
    expect(line).to.not.match(/\bat .+:\d+:\d+/);
    expect(line).to.include("could not detect network");
  });

  it("prints something for a thrown value that is not an error", () => {
    expect(failureLine(undefined)).to.be.a("string").and.not.equal("");
  });
});
