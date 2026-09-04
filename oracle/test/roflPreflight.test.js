const chai = require("chai");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { expect } = chai;

// Guards `scripts/rofl-preflight.sh`, the last gate before an ORC bundle exists.
//
// WHY THIS FILE EXISTS. Review of PR #85 flagged that the most security-relevant behaviour in
// that script — exit 1 when the ORC marker is absent — had no automated test, and that the
// verified pre-fix bypass (a compose whose only config line was `0xYourAIAgentAddressHere`
// passing with exit 0) was a cheap regression case. It was right: every bypass found in that
// script during the review was reachable only on a hand-edited compose, and each fix to it
// narrowed something else by accident. Without a test the next patch re-opens one silently.
//
// The script is at the REPO root, not under oracle/, but the only JS suite in this repo lives
// here — so this drives it as a subprocess rather than importing anything.

const REPO_ROOT = path.join(__dirname, "..", "..");
const PREFLIGHT = path.join(REPO_ROOT, "scripts", "rofl-preflight.sh");
const MARKER = "# === 📄 ORC BUNDLE CONFIGURATION (PLAINTEXT) ===";

/** Wraps config lines in enough compose shape to exercise the bounded scan, not a stub. */
function composeFixture(configLines, { marker = MARKER } = {}) {
  return [
    "services:",
    "  oracle:",
    "    image: ghcr.io/tradableapp/tokenized-ai-agent:test",
    "    environment:",
    "      # === 🔐 ROFL SECRETS ===",
    "      - PRIVATE_KEY=${PRIVATE_KEY:-}",
    `      ${marker}`,
    ...configLines.map((l) => `      ${l}`),
    // ports:/volumes: after the environment block: in_config_block is never reset, so these
    // fall inside the scan and must not be parsed as key/value pairs.
    "    ports:",
    '      - "3000:3000"',
    "    volumes:",
    "      - /run/rofl-appd.sock:/run/rofl-appd.sock",
    "",
  ].join("\n");
}

function runPreflight(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-preflight-"));
  const file = path.join(dir, "compose.base-testnet.yaml");
  fs.writeFileSync(file, contents);

  try {
    const out = execFileSync("bash", [PREFLIGHT, file], { encoding: "utf8" });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status, out: `${err.stdout || ""}${err.stderr || ""}` };
  }
}

describe("rofl-preflight.sh", function () {
  it("passes a clean compose", function () {
    const { code, out } = runPreflight(composeFixture(["- LOG_LEVEL=warn", "- mcp="]));

    expect(code).to.equal(0);
    expect(out).to.include("✅");
  });

  it("fails closed when the ORC marker is absent", function () {
    // The bypass this script was written to close, and which two later fixes each re-opened in a
    // different way. The placeholder makes it non-vacuous: it MUST be reported.
    const { code, out } = runPreflight(
      composeFixture(["- AI_AGENT_CONTRACT_ADDRESS=0xYourAIAgentAddressHere"], {
        marker: "# not the marker",
      }),
    );

    expect(code).to.equal(1);
    expect(out).to.include("ORC BUNDLE CONFIGURATION");
  });

  it("rejects a placeholder value", function () {
    const { code, out } = runPreflight(
      composeFixture(["- AI_AGENT_CONTRACT_ADDRESS=0xYourAIAgentAddressHere"]),
    );

    expect(code).to.equal(1);
    expect(out).to.include("placeholder");
  });

  it("rejects a quoted value", function () {
    // docker-compose keeps the quotes, so an exact comparison in the container takes the wrong
    // branch. sense-ai-core shipped exactly this on mainnet with SANTIMENT_TIER.
    const { code, out } = runPreflight(composeFixture(['- SANTIMENT_TIER="MAX"']));

    expect(code).to.equal(1);
    expect(out).to.include("quoted");
  });

  it("rejects an inline comment in a config value", function () {
    const { code, out } = runPreflight(composeFixture(["- MODE=home # Or latest"]));

    expect(code).to.equal(1);
    expect(out).to.include("inline comment");
  });

  it("does not mistake a hashtag for an inline comment", function () {
    const { code } = runPreflight(composeFixture(["- TOPICS=defi, #DeFi, layer2 #ETH"]));

    expect(code).to.equal(0);
  });

  it("rejects a non-empty mcp, which registers zero MCP servers", function () {
    for (const bad of ['- mcp=""', "- mcp=#", "-  mcp=#"]) {
      const { code, out } = runPreflight(composeFixture([bad]));

      expect(code, bad).to.equal(1);
      expect(out, bad).to.include("mcp");
    }
  });

  it("allows bare mcp=", function () {
    const { code } = runPreflight(composeFixture(["- mcp="]));

    expect(code).to.equal(0);
  });

  it("does not parse ports or volumes as key/value pairs", function () {
    const { code, out } = runPreflight(composeFixture(["- LOG_LEVEL=warn"]));

    expect(code).to.equal(0);
    expect(out).to.not.include("3000:3000");
    expect(out).to.not.include("rofl-appd.sock");
  });

  it("still opens the scan when the marker line has trailing whitespace", function () {
    const { code, out } = runPreflight(
      composeFixture(["- X=0xYourThingHere"], { marker: `${MARKER}   ` }),
    );

    expect(code).to.equal(1);
    expect(out).to.include("placeholder");
  });

  it("accepts a CRLF compose", function () {
    // awk trimmed [ \t] while the shell trimmed [[:space:]]; on CRLF the marker never matched
    // and a valid file was rejected.
    const { code } = runPreflight(composeFixture(["- LOG_LEVEL=warn"]).replace(/\n/g, "\r\n"));

    expect(code).to.equal(0);
  });

  it("says on the ✅ line when the staleness check was skipped", function () {
    // The fixture has no adjacent env file, so the staleness guard cannot run — and the success
    // line must not attest to a check that never executed.
    const { code, out } = runPreflight(composeFixture(["- LOG_LEVEL=warn"]));

    expect(code).to.equal(0);
    expect(out).to.include("staleness check skipped");
  });
});
