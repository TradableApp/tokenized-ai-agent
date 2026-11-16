const { expect } = require("chai");
const { spawnSync } = require("child_process");
const path = require("path");

// An RPC provider's address carries the account's access key, in the path or in the query.
// Whatever Sentry records about the oracle's own outgoing requests therefore carries it too,
// in fields that hold a path with no scheme in front. This runs the real SDK, as configured
// by initSentry, against requests to such an address and reads what would have been sent.
describe("what Sentry is sent about the oracle's outgoing requests", function () {
  this.timeout(60000);

  const PATH_KEY = "pathKeyaB3dE6gH9jK2mN5pQ8sT";
  const QUERY_KEY = "queryKeyq7Wx2Zr9";
  let sent;

  before(() => {
    const result = spawnSync(
      process.execPath,
      [path.resolve(__dirname, "helpers/sentryEnvelopeProbe.js")],
      {
        cwd: path.resolve(__dirname, ".."),
        env: { ...process.env, PROBE_PATH_KEY: PATH_KEY, PROBE_QUERY_KEY: QUERY_KEY },
        encoding: "utf8",
      },
    );
    expect(result.status, result.stderr).to.equal(0);
    sent = JSON.parse(result.stdout.split("@@SENT@@")[1]);
  });

  it("still reports the error", () => {
    expect(sent.join("\n")).to.include("the oracle failed after its requests");
  });

  it("holds the access key nowhere, in the path or in the query", () => {
    const everything = sent.join("\n");

    expect(everything).to.not.include(PATH_KEY);
    expect(everything).to.not.include(QUERY_KEY);
  });

  it("records no span or breadcrumb for an outgoing request at all", () => {
    const everything = sent.join("\n");

    expect(everything).to.not.include('"type":"transaction"');
    expect(everything).to.not.include("http.client");
    expect(everything).to.not.include('"category":"http"');
  });
});
