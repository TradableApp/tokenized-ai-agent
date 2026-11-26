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
  const LAST_EVENT_ID = "run42.7";
  const CALLER_TRACE_ID = "fedcba9876543210fedcba9876543210";
  const CALLER_SPAN_ID = "fedcba9876543210";
  let sent;
  /** The error event captured while the request was being served. */
  let duringRequest;
  /** The error event captured by the oracle outside any request. */
  let outsideRequest;

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
          PROBE_LAST_EVENT_ID: LAST_EVENT_ID,
          PROBE_CALLER_TRACE_ID: CALLER_TRACE_ID,
          PROBE_CALLER_SPAN_ID: CALLER_SPAN_ID,
        },
      },
    );
    let stderr = "";
    probe.stderr.on("data", (chunk) => (stderr += chunk));
    const status = await new Promise((resolve) => probe.on("close", resolve));

    expect(status, stderr).to.equal(0);
    sent = JSON.parse(fs.readFileSync(output, "utf8"));
    fs.rmSync(path.dirname(output), { recursive: true, force: true });

    // An envelope is lines of JSON: its header, then each item's header and the item.
    const events = sent.flatMap((envelope) =>
      envelope
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((item) => Array.isArray(item?.exception?.values)),
    );
    const byMessage = (text) =>
      events.find((e) => e.exception.values.some((v) => String(v.value).includes(text)));
    duringRequest = byMessage("failed while serving a request");
    outsideRequest = byMessage("failed after serving its requests");
  });

  it("still reports the errors, the one raised while serving a request included", () => {
    expect(outsideRequest, "the error outside a request").to.exist;
    expect(duringRequest, "the error raised while serving").to.exist;
  });

  it("sends an error raised while serving with no request, no route as its name and no caller's trace", () => {
    expect(duringRequest).to.not.have.property("request");
    expect(String(duringRequest.transaction ?? "")).to.not.match(/^[A-Z]+ \//);
    const trace = duringRequest.contexts?.trace ?? {};
    expect(trace.trace_id).to.not.equal(CALLER_TRACE_ID);
    expect(trace.parent_span_id).to.not.equal(CALLER_SPAN_ID);
  });

  it("holds the caller's trace, user agent and last event id nowhere in what is sent", () => {
    const everything = sent.join("\n");

    expect(everything).to.not.include(CALLER_TRACE_ID);
    expect(everything).to.not.include(CALLER_SPAN_ID);
    expect(everything).to.not.include(LAST_EVENT_ID);
    expect(everything).to.not.include(USER_AGENT);
  });

  it("keeps the trace of an error the oracle raises outside any request", () => {
    expect(outsideRequest.contexts?.trace?.trace_id).to.match(/^[0-9a-f]{32}$/);
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
