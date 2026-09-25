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

// Every real compose carries this, and preflight now fails without it. It is injected into
// the fixture rather than repeated in each case so the parsing tests below keep testing
// parsing — a test about CRLF handling should not also have to assert a Postgres key. The
// gate itself is covered by its own case, which omits it via `omitAgentDb`.
const AGENT_DB_LINE = "- POSTGRES_AGENT_DATABASE=oracle_agent";

/** Wraps config lines in enough compose shape to exercise the bounded scan, not a stub. */
function composeFixture(configLines, { marker = MARKER, omitAgentDb = false } = {}) {
  return [
    "services:",
    "  oracle:",
    "    image: ghcr.io/tradableapp/tokenized-ai-agent:test",
    "    environment:",
    "      # === 🔐 ROFL SECRETS ===",
    "      - PRIVATE_KEY=${PRIVATE_KEY:-}",
    `      ${marker}`,
    ...(omitAgentDb ? [] : [`      ${AGENT_DB_LINE}`]),
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

  describe("POSTGRES_AGENT_DATABASE gate", function () {
    it("rejects a compose that declares no agent database", function () {
      // The real case: compose.testnet.yaml and compose.mainnet.yaml were both regenerated
      // before Postgres was added to the env files, so they carried no POSTGRES_* keys while
      // their base-* siblings had the full block. Without the key plugin-sql falls through to
      // PGLite, whose schema the oracle's programmatic boot never creates, and the runtime
      // dies ~30s in on `relation "agents" does not exist`.
      const { code, out } = runPreflight(
        composeFixture(["- LOG_LEVEL=warn"], { omitAgentDb: true }),
      );

      expect(code).to.equal(1);
      expect(out).to.include("POSTGRES_AGENT_DATABASE");
    });

    it("rejects a compose that declares the key with an empty value", function () {
      // The assert's own comment says "present and non-empty". A bare `- POSTGRES_AGENT_DATABASE=`
      // is exactly the shape a half-finished regeneration leaves behind, and an empty value is no
      // more usable than an absent one — plugin-sql falls through to PGLite either way. Empty
      // values demonstrably do reach generated composes: `mcp=` is one, by design.
      const { code, out } = runPreflight(
        composeFixture(["- POSTGRES_AGENT_DATABASE=", "- LOG_LEVEL=warn"], { omitAgentDb: true }),
      );

      expect(code).to.equal(1);
      expect(out).to.include("POSTGRES_AGENT_DATABASE");
    });

    it("is not satisfied by a secret-form reference to the key", function () {
      // `${POSTGRES_AGENT_DATABASE:-}` is how the SECRET section carries a key: the value is
      // injected by rofl-appd at run time, and the `:-` default means an unset secret arrives
      // EMPTY. Every generated compose puts this key in the plaintext CONFIG section instead
      // (`- POSTGRES_AGENT_DATABASE=oracle_agent`), which is what the gate is asserting — so a
      // key that migrated to the secret section must reopen the gate, not slip through it.
      // Runtime injection is exactly the case this gate cannot verify, and the cost of being
      // wrong is paid from inside a TEE after the bundle is signed.
      const { code, out } = runPreflight(
        composeFixture(["- POSTGRES_AGENT_DATABASE=${POSTGRES_AGENT_DATABASE:-}"], {
          omitAgentDb: true,
        }),
      );

      expect(code).to.equal(1);
      expect(out).to.include("POSTGRES_AGENT_DATABASE");
    });

    it("is not satisfied by a key that merely starts with the same name", function () {
      // The check matches on a both-sides-delimited record precisely so this cannot pass.
      const { code, out } = runPreflight(
        composeFixture(["- POSTGRES_AGENT_DATABASE_EXTRA=oracle_agent"], { omitAgentDb: true }),
      );

      expect(code).to.equal(1);
      expect(out).to.include("POSTGRES_AGENT_DATABASE");
    });
  });

  it("says on the ✅ line when the staleness check was skipped", function () {
    // The fixture has no adjacent env file, so the staleness guard cannot run — and the success
    // line must not attest to a check that never executed.
    const { code, out } = runPreflight(composeFixture(["- LOG_LEVEL=warn"]));

    expect(code).to.equal(0);
    expect(out).to.include("staleness check skipped");
  });
});
