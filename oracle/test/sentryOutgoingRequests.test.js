const { expect } = require("chai");
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
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

  before(async () => {
    const output = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sentry-probe-")), "sent.json");
    const requests = [];
    const server = http.createServer((req, res) => {
      requests.push(req.url);
      res.end("{}");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = `http://127.0.0.1:${server.address().port}/v2/${PATH_KEY}?dkey=${QUERY_KEY}`;

    // Not spawnSync: this process has to stay free to serve the probe's requests.
    const probe = spawn(
      process.execPath,
      [path.resolve(__dirname, "helpers/sentryEnvelopeProbe.js")],
      {
        cwd: path.resolve(__dirname, ".."),
        env: { ...process.env, PROBE_ADDRESS: address, PROBE_OUTPUT: output },
      },
    );
    let stderr = "";
    probe.stderr.on("data", (chunk) => (stderr += chunk));
    const status = await new Promise((resolve) => probe.on("close", resolve));
    await new Promise((resolve) => server.close(resolve));

    expect(status, stderr).to.equal(0);
    // Both requests were really made, with the key in them.
    expect(requests).to.deep.equal([
      `/v2/${PATH_KEY}?dkey=${QUERY_KEY}`,
      `/v2/${PATH_KEY}?dkey=${QUERY_KEY}`,
    ]);
    sent = JSON.parse(fs.readFileSync(output, "utf8"));
    fs.rmSync(path.dirname(output), { recursive: true, force: true });
  });

  it("still reports the error", () => {
    expect(sent.join("\n")).to.include("the oracle failed after its requests");
  });

  it("holds the access key nowhere, in the path or in the query", () => {
    const everything = sent.join("\n");

    expect(everything).to.not.include(PATH_KEY);
    expect(everything).to.not.include(QUERY_KEY);
  });

  it("records the work the requests were part of, and no span for the requests", () => {
    const everything = sent.join("\n");

    // The parent span was sent, so a span for each request would have been sent with it.
    expect(everything).to.include("probe: handling an event");
    expect(everything).to.not.include("http.client");
    expect(everything).to.include('"spans":[]');
  });

  it("records no breadcrumb for a request, while other breadcrumbs still arrive", () => {
    const everything = sent.join("\n");

    expect(everything).to.include("a line printed while handling the event");
    expect(everything).to.not.include('"category":"http"');
  });
});
