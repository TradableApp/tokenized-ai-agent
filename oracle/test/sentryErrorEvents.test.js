const { expect } = require("chai");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// What Sentry is sent about an error is the described line, not the error's message as it was
// thrown: no network peer, no query text or bound value, no wallet, no prompt, no token. This
// runs the real SDK, as configured by initSentry, on the errors the oracle meets, and reads
// what would have been sent. Every address and name is from the documentation ranges.
describe("what Sentry is sent about an error", function () {
  this.timeout(60000);

  const PEER = "192.0.2.10";
  const HOST = "db.example.com";
  const WALLET = "0x2222222222222222222222222222222222222222";
  const PROMPT = "should I sell everything today";
  const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlLXRoYXQtaXMtbG9uZw";
  let everything;

  before(() => {
    const output = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sentry-errors-")), "sent.json");
    const probe = spawnSync(
      process.execPath,
      [path.resolve(__dirname, "helpers/sentryErrorProbe.js")],
      {
        cwd: path.resolve(__dirname, ".."),
        env: {
          ...process.env,
          PROBE_OUTPUT: output,
          PROBE_PEER: PEER,
          PROBE_HOST: HOST,
          PROBE_WALLET: WALLET,
          PROBE_PROMPT: PROMPT,
          PROBE_JWT: TOKEN,
        },
        encoding: "utf8",
      },
    );

    expect(probe.status, probe.stderr).to.equal(0);
    everything = JSON.parse(fs.readFileSync(output, "utf8")).join("\n");
    fs.rmSync(path.dirname(output), { recursive: true, force: true });
  });

  it("still reports each error, with what an operator acts on", () => {
    expect(everything).to.include("ECONNREFUSED");
    expect(everything).to.include("ENOTFOUND");
    expect(everything).to.include("Failed query");
    expect(everything).to.include("AI_APICallError");
    expect(everything).to.include("request refused");
    expect(everything).to.include("probe_refused");
  });

  it("holds no network peer", () => {
    expect(everything).to.not.include(PEER);
    expect(everything).to.not.include(HOST);
  });

  it("holds no query text, bound value, wallet or prompt", () => {
    expect(everything).to.not.include("insert into activity");
    expect(everything).to.not.include("params:");
    expect(everything.toLowerCase()).to.not.include(WALLET.slice(2, 22));
    expect(everything).to.not.include(PROMPT);
  });

  it("holds no token", () => {
    expect(everything).to.not.include(TOKEN.split(".")[0]);
  });
});
