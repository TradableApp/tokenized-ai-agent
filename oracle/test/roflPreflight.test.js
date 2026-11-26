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

// The bundle measures the compose file, so an image is accepted only when named by its digest,
// and by its digest alone: the registry transport refuses a reference with a tag and a digest.
const DIGEST = `sha256:${"0123456789abcdef".repeat(4)}`;
const PINNED_IMAGE = `ghcr.io/tradableapp/tokenized-ai-agent@${DIGEST}`;

/** Wraps config lines in enough compose shape to exercise the bounded scan, not a stub. */
function composeFixture(
  configLines,
  { marker = MARKER, omitAgentDb = false, secretLines = [], imageLine = `image: ${PINNED_IMAGE}`, moreServices = [] } = {},
) {
  return [
    "services:",
    "  oracle:",
    ...(imageLine === null ? [] : [`    ${imageLine}`]),
    "    environment:",
    "      # === 🔐 ROFL SECRETS ===",
    "      - PRIVATE_KEY=${PRIVATE_KEY:-}",
    ...secretLines.map((l) => `      ${l}`),
    `      ${marker}`,
    ...(omitAgentDb ? [] : [`      ${AGENT_DB_LINE}`]),
    ...configLines.map((l) => `      ${l}`),
    // ports:/volumes: after the environment block: in_config_block is never reset, so these
    // fall inside the scan and must not be parsed as key/value pairs.
    "    ports:",
    '      - "3000:3000"',
    "    volumes:",
    "      - /run/rofl-appd.sock:/run/rofl-appd.sock",
    ...moreServices,
    "",
  ].join("\n");
}

function runPreflight(contents, name = "compose.base-testnet.yaml", { env = process.env, mode } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-preflight-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, contents);
  if (mode !== undefined) fs.chmodSync(file, mode);

  try {
    const out = execFileSync("bash", [PREFLIGHT, file], { encoding: "utf8", env });
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

  describe("every image is pinned by digest", function () {
    const refusesImage = ({ code, out }, service) => {
      expect(code, out).to.equal(1);
      expect(out).to.include("not pinned by digest");
      expect(out).to.include(`'${service}'`);
      expect(out).to.include("compose.base-testnet.yaml");
      expect(out).to.include("bun run image:pin:base-testnet");
    };

    it("accepts an image named by its digest alone", function () {
      const { code, out } = runPreflight(composeFixture(["- LOG_LEVEL=warn"]));

      expect(code, out).to.equal(0);
      expect(out).to.not.include("not pinned by digest");
    });

    it("accepts a quoted reference, and a registry host with a port", function () {
      for (const imageLine of [`image: "${PINNED_IMAGE}"`, `image: localhost:5000/tokenized-ai-agent@${DIGEST}`]) {
        const { code, out } = runPreflight(composeFixture(["- LOG_LEVEL=warn"], { imageLine }));

        expect(code, `${imageLine}\n${out}`).to.equal(0);
      }
    });

    it("refuses an image named by tag and digest", function () {
      const imageLine = `image: ghcr.io/tradableapp/tokenized-ai-agent:test@${DIGEST}`;
      const result = runPreflight(composeFixture(["- LOG_LEVEL=warn"], { imageLine }));

      refusesImage(result, "oracle");
      expect(result.out).to.include("tag and a digest");
      // Where the tag goes instead.
      expect(result.out).to.include("# pinned from :<tag>");
    });

    it("refuses an image named by tag alone", function () {
      refusesImage(
        runPreflight(composeFixture(["- LOG_LEVEL=warn"], { imageLine: "image: ghcr.io/tradableapp/tokenized-ai-agent:test" })),
        "oracle",
      );
    });

    it("refuses a digest that is short, long, upper case or not hex", function () {
      const hex = "0123456789abcdef".repeat(4);
      for (const digest of [hex.slice(1), `${hex}0`, hex.toUpperCase(), `${hex.slice(1)}g`, ""]) {
        const imageLine = `image: ghcr.io/tradableapp/tokenized-ai-agent@sha256:${digest}`;
        refusesImage(runPreflight(composeFixture(["- LOG_LEVEL=warn"], { imageLine })), "oracle");
      }
    });

    it("refuses a digest of another algorithm, and two digests", function () {
      for (const imageLine of [
        `image: ghcr.io/tradableapp/tokenized-ai-agent@sha512:${"ab".repeat(64)}`,
        `image: ghcr.io/tradableapp/tokenized-ai-agent@${DIGEST}@${DIGEST}`,
      ]) {
        refusesImage(runPreflight(composeFixture(["- LOG_LEVEL=warn"], { imageLine })), "oracle");
      }
    });

    it("refuses an image interpolated from the environment", function () {
      const imageLine = "image: ${ORACLE_IMAGE}";
      refusesImage(runPreflight(composeFixture(["- LOG_LEVEL=warn"], { imageLine })), "oracle");
    });

    it("refuses one unpinned service among several, and names that one", function () {
      const result = runPreflight(
        composeFixture(["- LOG_LEVEL=warn"], {
          moreServices: [
            "  pinned-sidecar:",
            `    image: ghcr.io/example/sidecar@${DIGEST}`,
            "  sidecar:",
            "    image: ghcr.io/example/sidecar:1",
          ],
        }),
      );

      refusesImage(result, "sidecar");
      expect(result.out).to.not.include("'oracle'");
      expect(result.out).to.not.include("'pinned-sidecar'");
    });

    it("refuses a service with no image", function () {
      refusesImage(runPreflight(composeFixture(["- LOG_LEVEL=warn"], { imageLine: null })), "oracle");
    });

    it("refuses a compose with no service at all", function () {
      const { code, out } = runPreflight(["version: '3'", "volumes:", "  data: {}", ""].join("\n"));

      expect(code).to.equal(1);
      expect(out).to.include("not pinned by digest");
    });

    it("reads a CRLF compose and a trailing comment on the image line", function () {
      const imageLine = `image: ${PINNED_IMAGE}   # the release that went live`;
      const { code, out } = runPreflight(composeFixture(["- LOG_LEVEL=warn"], { imageLine }).replace(/\n/g, "\r\n"));

      expect(code, out).to.equal(0);
    });

    describe("fails closed when the image lines cannot be read", function () {
      const failingAwkEnv = () => {
        const bin = fs.mkdtempSync(path.join(os.tmpdir(), "ta-preflight-bin-"));
        fs.writeFileSync(path.join(bin, "awk"), "#!/bin/bash\nexit 1\n", { mode: 0o755 });
        return { ...process.env, PATH: `${bin}:${process.env.PATH}` };
      };

      it("refuses when the reader fails with no output", function () {
        const { code, out } = runPreflight(composeFixture(["- LOG_LEVEL=warn"]), "compose.base-testnet.yaml", {
          env: failingAwkEnv(),
        });

        expect(code).to.equal(1);
        expect(out).to.include("could not read the image entries");
        expect(out).to.not.include("✅");
      });

      it("refuses when the file cannot be read", function () {
        if (process.getuid && process.getuid() === 0) this.skip(); // root reads a mode-000 file
        const { code, out } = runPreflight(composeFixture(["- LOG_LEVEL=warn"]), "compose.base-testnet.yaml", { mode: 0o000 });

        expect(code).to.equal(1);
        expect(out).to.include("could not read the image entries");
        expect(out).to.not.include("✅");
      });

      it("has the lib refuse on its own, with a non-zero exit", function () {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-preflight-"));
        const file = path.join(dir, "compose.yaml");
        fs.writeFileSync(file, composeFixture(["- LOG_LEVEL=warn"]));
        let failed;
        try {
          execFileSync("bash", [path.join(REPO_ROOT, "scripts", "rofl-image-refs.sh"), "--unpinned", file], {
            encoding: "utf8",
            env: failingAwkEnv(),
          });
        } catch (err) {
          failed = err;
        }

        expect(failed, "the lib exited 0").to.not.equal(undefined);
        expect(failed.stdout).to.include("could not read the image entries");
      });
    });

    it("names the release command for a mainnet compose", function () {
      const imageLine = "image: ghcr.io/tradableapp/tokenized-ai-agent:base-mainnet-latest";
      const { code, out } = runPreflight(composeFixture(["- LOG_LEVEL=warn"], { imageLine }), "compose.base-mainnet.yaml");

      expect(code).to.equal(1);
      expect(out).to.include("bun run release:base-mainnet");
    });
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

  describe("POSTGRES_HOST is a secret", function () {
    // The database address must never be written into a tracked compose: this repo is public.
    // A documentation address (RFC 5737) stands in for a real one.
    const ADDRESS = "203.0.113.7";

    it("rejects a literal address in the plaintext config, without printing it", function () {
      const { code, out } = runPreflight(composeFixture([`- POSTGRES_HOST=${ADDRESS}`]));

      expect(code).to.equal(1);
      expect(out).to.include("POSTGRES_HOST");
      expect(out).to.include("secret");
      expect(out).to.not.include(ADDRESS);
    });

    it("rejects a hostname in the plaintext config too", function () {
      const { code, out } = runPreflight(composeFixture(["- POSTGRES_HOST=db.example.com"]));

      expect(code).to.equal(1);
      expect(out).to.not.include("db.example.com");
    });

    it("passes the injected form in the secrets section", function () {
      const { code } = runPreflight(
        composeFixture(["- LOG_LEVEL=warn"], {
          secretLines: ["- POSTGRES_HOST=${POSTGRES_HOST:-}"],
        }),
      );

      expect(code).to.equal(0);
    });
  });

  describe("tracked compose files", function () {
    // The compose files are generated, but they are also committed to a public repo, so a
    // hand-edit or a regenerate from an old env layout would publish the database address.
    const composeFiles = fs
      .readdirSync(REPO_ROOT)
      .filter((name) => /^compose(\..+)?\.yaml$/.test(name));

    for (const name of ["compose.yaml", "compose.base-testnet.yaml", "compose.base-mainnet.yaml"]) {
      it(`${name} injects POSTGRES_HOST from the secrets section`, function () {
        const lines = fs.readFileSync(path.join(REPO_ROOT, name), "utf8").split(/\r?\n/);
        const markerAt = lines.findIndex((l) => l.trim() === MARKER);
        const hostAt = lines.findIndex((l) => l.trim() === "- POSTGRES_HOST=${POSTGRES_HOST:-}");

        expect(markerAt, `${name} has no ORC marker`).to.be.greaterThan(-1);
        expect(hostAt, `${name} does not inject POSTGRES_HOST`).to.be.greaterThan(-1);
        expect(hostAt, `${name} injects POSTGRES_HOST below the marker`).to.be.lessThan(markerAt);
      });
    }

    // A value paired with POSTGRES_HOST in any form a compose can take (a list item, quoted or
    // not, or a mapping), other than the injection. Reported as true or false, never the value.
    const pairsHostWithValue = (text) =>
      /(?<!\$\{)POSTGRES_HOST[ \t]*[=:][ \t]*["']?[ \t]*(?!\$\{POSTGRES_HOST:-\})[^\s"'#]/.test(text);

    it("finds a database address paired with POSTGRES_HOST in a list item, a quoted item or a mapping, of any shape", function () {
      for (const text of [
        "      - POSTGRES_HOST=10.1.2.3",
        '      - "POSTGRES_HOST=db.internal.example"',
        "      POSTGRES_HOST: db.internal.example",
        "      POSTGRES_HOST: '2001:db8::8'",
      ]) {
        expect(pairsHostWithValue(text), "a literal is found").to.equal(true);
      }
      for (const text of [
        "      - POSTGRES_HOST=${POSTGRES_HOST:-}",
        "      POSTGRES_HOST: ${POSTGRES_HOST:-}",
        "      - POSTGRES_HOST=\n      - PGPORT=5432",
      ]) {
        expect(pairsHostWithValue(text), "the injection or an empty value is not").to.equal(false);
      }
    });

    it("no tracked compose carries a literal POSTGRES_HOST", function () {
      expect(composeFiles).to.include("compose.base-testnet.yaml");
      for (const name of composeFiles) {
        const text = fs.readFileSync(path.join(REPO_ROOT, name), "utf8");
        const literals = text
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => /^-\s*POSTGRES_HOST=/.test(l))
          .filter((l) => l !== "- POSTGRES_HOST=${POSTGRES_HOST:-}");

        // Reported by count, not content: the failing value is the thing being kept out.
        expect(literals.length, `${name} has a literal POSTGRES_HOST line`).to.equal(0);
        // The mapping and quoted forms the line filter above does not read.
        expect(pairsHostWithValue(text), `${name} pairs POSTGRES_HOST with a value`).to.equal(false);
      }
    });

    // Which tracked files may be bundled today. The testnet-side files name the image that was
    // pushed by its digest; no mainnet image has been pushed yet, so the two mainnet files name a
    // tag alone and are refused until a release writes the digest of what it pushed.
    const IMAGE_REFS = path.join(REPO_ROOT, "scripts", "rofl-image-refs.sh");
    // Exit status 1 means "something is not pinned"; its stdout is what to report.
    const unpinned = (name) => {
      try {
        return execFileSync("bash", [IMAGE_REFS, "--unpinned", path.join(REPO_ROOT, name)], { encoding: "utf8" });
      } catch (err) {
        return err.stdout;
      }
    };
    const scripts = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).scripts;
    // The image line and the `# pinned from :<tag>` comment the pin script keeps above it.
    const pinnedFrom = (name) => {
      const m = /^\s+# pinned from :(\S+)\n\s+image:\s*([^@\s]+)@sha256:[0-9a-f]{64}\s*$/m.exec(
        fs.readFileSync(path.join(REPO_ROOT, name), "utf8"),
      );
      return m && `${m[2]}:${m[1]}`;
    };

    it("lists the five compose files this check is about", function () {
      expect([...composeFiles].sort()).to.deep.equal(
        ["compose.base-mainnet.yaml", "compose.base-testnet.yaml", "compose.mainnet.yaml", "compose.testnet.yaml", "compose.yaml"],
      );
    });

    // compose.yaml is the copy of the per-env file the last rofl:build used. A pin committed to a
    // per-env file without the rebuilt copy leaves the two naming different images.
    const imageLines = (name) =>
      fs
        .readFileSync(path.join(REPO_ROOT, name), "utf8")
        .split(/\r?\n/)
        .map((line, i, all) => (/^\s+image:/.test(line) ? [/^\s+# pinned from :/.test(all[i - 1]) ? all[i - 1] : null, line] : null))
        .filter(Boolean);

    it("compose.yaml names the same image, with the same record, as one per-env compose file", function () {
      const copy = imageLines("compose.yaml");
      expect(copy.length, "compose.yaml has an image line").to.be.greaterThan(0);
      const sources = composeFiles.filter((name) => name !== "compose.yaml");
      const matching = sources.filter((name) => JSON.stringify(imageLines(name)) === JSON.stringify(copy));

      expect(matching, `compose.yaml's image is not that of any of ${sources.join(", ")}`).to.not.deep.equal([]);
    });

    it("tells a compose.yaml left behind by a new pin from one that is current", function () {
      const current = imageLines("compose.base-testnet.yaml");
      const stale = current.map(([record, line]) => [record, line.replace(/[0-9a-f]{64}$/, "f".repeat(64))]);
      expect(JSON.stringify(stale)).to.not.equal(JSON.stringify(current));
    });

    for (const name of ["compose.yaml", "compose.base-testnet.yaml", "compose.testnet.yaml"]) {
      it(`${name} names every image by its digest`, function () {
        expect(unpinned(name), name).to.equal("");
      });
    }

    for (const [name, env] of [
      ["compose.base-testnet.yaml", "base-testnet"],
      ["compose.testnet.yaml", "testnet"],
    ]) {
      it(`${name} pins the tag that image:push:${env} pushes, and image:pin:${env} pins it`, function () {
        const tagged = pinnedFrom(name);
        expect(tagged, `${name} records the tag its digest was read from`).to.be.a("string");
        expect(scripts[`image:push:${env}`]).to.equal(`docker push ${tagged} && bun run image:pin:${env}`);
        expect(scripts[`image:build:${env}`]).to.include(` -t ${tagged} `);
        expect(scripts[`image:pin:${env}`]).to.equal(`bash scripts/pin-image-digest.sh ${name}`);
      });
    }

    for (const [name, env] of [
      ["compose.base-mainnet.yaml", "base-mainnet"],
      ["compose.mainnet.yaml", "mainnet"],
    ]) {
      it(`${name} is refused until a release writes its digest`, function () {
        expect(unpinned(name), name).to.include("oracle");
        const { code, out } = runPreflight(fs.readFileSync(path.join(REPO_ROOT, name), "utf8"), name);

        expect(code).to.equal(1);
        expect(out).to.include("not pinned by digest");
        expect(out).to.include(`bun run release:${env}`);
        expect(scripts[`release:${env}`]).to.equal(`bash ./scripts/release-mainnet.sh ${name}`);
      });
    }
  });

  it("says on the ✅ line when the staleness check was skipped", function () {
    // The fixture has no adjacent env file, so the staleness guard cannot run — and the success
    // line must not attest to a check that never executed.
    const { code, out } = runPreflight(composeFixture(["- LOG_LEVEL=warn"]));

    expect(code).to.equal(0);
    expect(out).to.include("staleness check skipped");
  });
});
