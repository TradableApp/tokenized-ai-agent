// Run as its own process by sentryOutgoingRequests.test.js: Sentry can be initialised once per
// process, and its instrumentation of http must be in place before the first request.
//
// Makes the requests an oracle makes (node's http module, as ethers does, and fetch) to an
// address shaped like a provider's, with an access key in the path and in the query, reports
// an error, and prints everything Sentry would have sent.
const fs = require("fs");
const http = require("http");

// The address is served by the test's own process, so the only requests this process knows of
// are the ones it makes.
const address = process.env.PROBE_ADDRESS;

async function main() {
  // The address is deliberately NOT in the configuration, so nothing knows its key by value:
  // what is tested here is that nothing about the request is recorded in the first place.
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

  // Inside a span, as a request made while handling an event would be: only then would a
  // span for the request itself be recorded.
  await Sentry.startSpan({ name: "probe: handling an event", op: "probe" }, async () => {
    await new Promise((resolve, reject) => {
      http
        .request(address, { method: "POST" }, (res) => res.resume().on("end", resolve))
        .on("error", reject)
        .end("{}");
    });
    await (await fetch(address, { method: "POST", body: "{}" })).text();
    console.log("a line printed while handling the event");
  });
  Sentry.captureException(new Error("the oracle failed after its requests"));
  await Sentry.flush(5000);

  // To a file: a pipe may not be drained before the process ends.
  fs.writeFileSync(process.env.PROBE_OUTPUT, JSON.stringify(sent));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
