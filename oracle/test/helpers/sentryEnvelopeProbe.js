// Run as its own process by sentryOutgoingRequests.test.js: Sentry can be initialised once per
// process, and its instrumentation of http must be in place before the first request.
//
// Makes the requests an oracle makes (node's http module, as ethers does, and fetch) to an
// address shaped like a provider's, with an access key in the path and in the query, reports
// an error, and prints everything Sentry would have sent.
const http = require("http");

const PATH_KEY = process.env.PROBE_PATH_KEY;
const QUERY_KEY = process.env.PROBE_QUERY_KEY;

async function main() {
  const server = http.createServer((req, res) => res.end("{}"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = `http://127.0.0.1:${server.address().port}/v2/${PATH_KEY}?dkey=${QUERY_KEY}`;
  process.env.BASE_SEPOLIA_TESTNET_RPC = address;
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

  await new Promise((resolve, reject) => {
    http
      .request(address, { method: "POST" }, (res) => res.resume().on("end", resolve))
      .on("error", reject)
      .end("{}");
  });
  await (await fetch(address, { method: "POST", body: "{}" })).text();
  Sentry.captureException(new Error("the oracle failed after its requests"));
  await Sentry.flush(5000);
  server.close();

  process.stdout.write(`@@SENT@@${JSON.stringify(sent)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
