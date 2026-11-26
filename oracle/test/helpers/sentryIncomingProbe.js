// Run as its own process by sentryIncomingRequests.test.js: Sentry can be initialised once per
// process, and its instrumentation of http must be in place before the server is made.
//
// Serves requests shaped like the stream server's (a path naming an answer, a proof header, a
// user agent, one of them asking for its trace to be sampled), reports an error, and writes
// everything Sentry would have sent to PROBE_OUTPUT.
const fs = require("fs");

async function main() {
  process.env.SENTRY_DSN = "https://public@sentry.invalid/1";
  process.env.SENTRY_ENVIRONMENT = "localnet"; // every transaction sampled

  const sent = [];
  const Sentry = require("@sentry/node");
  const { initSentry } = require("../../src/sentryInit");
  initSentry({
    transport: () =>
      Sentry.createTransport({ recordDroppedEvent() {} }, async (request) => {
        sent.push(Buffer.from(request.body).toString("utf8"));

        return { statusCode: 200 };
      }),
  });

  // Required after initSentry, as the oracle's servers are: the instrumentation wraps the module.
  const http = require("http");
  const server = http.createServer((req, res) => {
    // An error raised while the request is being served, in the request's own scope.
    if (req.headers["x-probe-capture"]) {
      Sentry.captureException(new Error("the oracle failed while serving a request"));
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  const request = (path, headers) =>
    new Promise((resolve, reject) => {
      http
        .get({ host: "127.0.0.1", port, path, headers }, (res) => res.resume().on("end", resolve))
        .on("error", reject);
    });

  await request(`/stream/${process.env.PROBE_ANSWER_ID}`, {
    "x-senseai-stream-proof": process.env.PROBE_PROOF,
    "user-agent": process.env.PROBE_USER_AGENT,
  });
  // A caller asking for its trace to be kept, whatever the sample rate.
  await request(`/stream/${process.env.PROBE_ANSWER_ID}`, {
    "sentry-trace": "0123456789abcdef0123456789abcdef-0123456789abcdef-1",
    "x-senseai-stream-proof": process.env.PROBE_PROOF,
  });
  // A request during which the oracle reports an error, from a caller sending its own trace.
  await request(`/stream/${process.env.PROBE_ANSWER_ID}`, {
    "x-probe-capture": "1",
    "x-senseai-stream-proof": process.env.PROBE_PROOF,
    "user-agent": process.env.PROBE_USER_AGENT,
    "last-event-id": process.env.PROBE_LAST_EVENT_ID,
    "sentry-trace": `${process.env.PROBE_CALLER_TRACE_ID}-${process.env.PROBE_CALLER_SPAN_ID}-1`,
    baggage: `sentry-trace_id=${process.env.PROBE_CALLER_TRACE_ID},sentry-sampled=true`,
  });
  await new Promise((resolve) => server.close(resolve));

  Sentry.captureException(new Error("the oracle failed after serving its requests"));
  await Sentry.flush(5000);

  // To a file: a pipe may not be drained before the process ends.
  fs.writeFileSync(process.env.PROBE_OUTPUT, JSON.stringify(sent));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
