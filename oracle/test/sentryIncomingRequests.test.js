const { expect } = require("chai");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// The oracle serves requests of its own (the live reasoning stream). Nothing about a request it
// serves is sent to Sentry: not the path that names an answer, not the proof header, not the
// caller's user agent, and no transaction, whatever trace header the caller sends. This runs the
// real SDK, as configured by initSentry, against a server it has instrumented.
describe("what Sentry is sent about requests the oracle serves", function () {
  this.timeout(60000);

  const ANSWER_ID = "778899112233";
  const PROOF = "proofValueQ3rT7yU1iO5pA9sD2fG6hJ0k";
  const USER_AGENT = "probe-agent/9.9.9";
  let sent;

  before(async () => {
    const output = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sentry-in-")), "sent.json");
    const probe = spawn(
      process.execPath,
      [path.resolve(__dirname, "helpers/sentryIncomingProbe.js")],
      {
        cwd: path.resolve(__dirname, ".."),
        env: {
          ...process.env,
          PROBE_OUTPUT: output,
          PROBE_ANSWER_ID: ANSWER_ID,
          PROBE_PROOF: PROOF,
          PROBE_USER_AGENT: USER_AGENT,
        },
      },
    );
    let stderr = "";
    probe.stderr.on("data", (chunk) => (stderr += chunk));
    const status = await new Promise((resolve) => probe.on("close", resolve));

    expect(status, stderr).to.equal(0);
    sent = JSON.parse(fs.readFileSync(output, "utf8"));
    fs.rmSync(path.dirname(output), { recursive: true, force: true });
  });

  it("still reports the error", () => {
    expect(sent.join("\n")).to.include("the oracle failed after serving its requests");
  });

  it("sends no transaction for a request served, even one asking for its trace to be kept", () => {
    const everything = sent.join("\n");

    expect(everything).to.not.include('"type":"transaction"');
    expect(everything).to.not.include("http.server");
  });

  it("holds the proof, the answer id and the user agent nowhere", () => {
    const everything = sent.join("\n");

    expect(everything).to.not.include(PROOF);
    expect(everything).to.not.include(ANSWER_ID);
    expect(everything).to.not.include(USER_AGENT);
  });
});
