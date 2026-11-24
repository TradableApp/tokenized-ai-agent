// Run as its own process by sentryErrorEvents.test.js: Sentry can be initialised once per
// process. Reports the errors the oracle meets, as they are thrown, and writes everything
// Sentry would have sent to a file.
//
// The values that must not be sent come from the environment, not from this file: Sentry sends
// the source lines around each frame, and those must not hold them either. No name below is a
// credential's, so none is removed by value (requestSecrets.js) and each is left to the rule
// under test.
const fs = require("fs");

const { PROBE_PEER, PROBE_HOST, PROBE_WALLET, PROBE_PROMPT, PROBE_JWT } = process.env;

async function main() {
  process.env.SENTRY_DSN = "https://public@sentry.invalid/1";
  process.env.SENTRY_ENVIRONMENT = "localnet";

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

  // A database the oracle could not reach, with the fields Node sets on such an error.
  const refused = Object.assign(new Error(`connect ECONNREFUSED ${PROBE_PEER}:5432`), {
    code: "ECONNREFUSED",
    syscall: "connect",
    address: PROBE_PEER,
    port: 5432,
  });
  Sentry.captureException(refused, { tags: { site: "probe_refused" } });

  // A name that does not resolve, reached through fetch.
  const lookup = Object.assign(new Error(`getaddrinfo ENOTFOUND ${PROBE_HOST}`), {
    code: "ENOTFOUND",
    hostname: PROBE_HOST,
  });
  Sentry.captureException(new TypeError("fetch failed", { cause: lookup }));

  // A failed query, as the query builder words it, with the database's error as its cause.
  const duplicate = Object.assign(new Error("duplicate key value violates unique constraint"), {
    code: "23505",
    detail: `Key (wallet)=(${PROBE_WALLET}) already exists.`,
  });
  Sentry.captureException(
    new Error(
      `Failed query: insert into activity (wallet, prompt) values ($1, $2)\nparams: ${PROBE_WALLET},${PROBE_PROMPT}`,
      { cause: duplicate },
    ),
  );

  // A model provider's error, which carries the request and echoes it in its message.
  Sentry.captureException(
    Object.assign(new Error(`Invalid request: user said: ${PROBE_PROMPT}`), {
      name: "AI_APICallError",
      statusCode: 400,
      requestBodyValues: { prompt: PROBE_PROMPT },
      responseBody: PROBE_PROMPT,
    }),
  );

  // A token in a message, on a line of its own and on the first.
  Sentry.captureException(new Error(`request refused\nsession ${PROBE_JWT} expired`));
  Sentry.captureException(new Error(`session ${PROBE_JWT} expired`));

  await Sentry.flush(5000);

  // To a file: a pipe may not be drained before the process ends.
  fs.writeFileSync(process.env.PROBE_OUTPUT, JSON.stringify(sent));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
