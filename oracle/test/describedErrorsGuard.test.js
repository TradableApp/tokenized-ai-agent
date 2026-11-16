const { expect } = require("chai");
const fs = require("node:fs");
const path = require("node:path");

/**
 * A provider's or a database's error message can carry the address it was sent to, access key
 * or password included. In the files that talk to the chain and to the oracle's own database,
 * an error's message is therefore never put into text as it is: `describeError(error)` is.
 *
 * Read from the source, because these lines sit in catch blocks that a unit test rarely reaches
 * (a store that fails while recording a failed retry), and one forgotten line is enough.
 */
const SRC = path.join(__dirname, "..", "src");
const GUARDED = [
  "aiAgentOracle.js",
  "eventPoller.js",
  "oracleRoleGate.js",
  "oracleState/runtime.js",
  "oracleState/store.js",
  "oracleState/outageTracker.js",
];

// `${error.message}` in a template, or `error.message` handed to console as an argument.
const RAW_MESSAGE = /\$\{\s*\w+\??\.message\s*\}|console\.\w+\([^;]*\b\w+\.message\s*[,)]/;
// A malformed payload's parse error is about the payload, and is what the dropped event's log
// line needs to say.
// The third is the message of an error that describedError or describeError already made.
const ALLOWED = [
  /BadInputError\(/,
  /Parse error: \$\{parseError\.message\}/,
  /\$\{described\.message\}/,
];

describe("errors are described before they are put into text", () => {
  for (const file of GUARDED) {
    it(`${file} never puts a raw error message into text`, () => {
      const offenders = fs
        .readFileSync(path.join(SRC, file), "utf8")
        .split("\n")
        .map((line, index) => ({ line: line.trim(), number: index + 1 }))
        .filter(({ line }) => !line.startsWith("//") && !line.startsWith("*"))
        .filter(({ line }) => RAW_MESSAGE.test(line))
        .filter(({ line }) => !ALLOWED.some((allowed) => allowed.test(line)))
        .map(({ line, number }) => `${file}:${number}: ${line}`);

      expect(offenders).to.deep.equal([]);
    });
  }

  it("recognises the two forms it looks for", () => {
    expect(RAW_MESSAGE.test("console.warn(`could not store: ${storeError.message}`);")).to.be.true;
    expect(RAW_MESSAGE.test('console.error("idle client error:", error.message);')).to.be.true;
    expect(RAW_MESSAGE.test("console.warn(`could not store: ${describeError(storeError)}`);")).to.be
      .false;
  });
});
