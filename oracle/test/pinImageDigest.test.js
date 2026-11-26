const chai = require("chai");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { expect } = chai;

// Guards `scripts/pin-image-digest.sh`, which writes into a compose file the digest of the image
// it names, and `scripts/release-mainnet.sh`, which ends by calling it. The digest lookup is
// replaced by a stub through ROFL_IMAGE_DIGEST_CMD, so nothing here reads a registry.
//
// A pinned image is named by its digest alone (the registry transport refuses a reference with a
// tag and a digest), and the tag the digest was read from is kept in a `# pinned from :<tag>`
// comment on the line above, which is where the next run reads the tag to look up again.

const REPO_ROOT = path.join(__dirname, "..", "..");
const PIN = path.join(REPO_ROOT, "scripts", "pin-image-digest.sh");
const RELEASE = path.join(REPO_ROOT, "scripts", "release-mainnet.sh");
const IMAGE = "ghcr.io/tradableapp/tokenized-ai-agent";
const HEX_A = "a".repeat(64);
const HEX_B = "0123456789abcdef".repeat(4);

/** A compose file whose oracle service has the given image line(s) at service-key indent. */
function compose(imageLines) {
  return [
    "services:",
    "  oracle:",
    "    build:",
    "      dockerfile: ./Dockerfile.oracle",
    ...[].concat(imageLines).map((l) => `    ${l}`),
    "    platform: linux/amd64",
    "    environment:",
    "      - LOG_LEVEL=warn",
    "",
  ].join("\n");
}

/** The two lines the pin script writes. */
const pinned = (tag, hex, name = IMAGE) => [`# pinned from :${tag}`, `image: ${name}@sha256:${hex}`];

/** A temp dir holding the compose file and a lookup stub that prints `answer` and logs its argument. */
function setup(contents, { answer = `sha256:${HEX_A}`, exitCode = 0, name = "compose.base-testnet.yaml" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-pin-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, contents);
  const log = path.join(dir, "lookup.log");
  const stub = path.join(dir, "lookup.sh");
  fs.writeFileSync(
    stub,
    ["#!/bin/bash", `printf '%s\\n' "$*" >> '${log}'`, `printf '%s\\n' '${answer}'`, `exit ${exitCode}`, ""].join("\n"),
    { mode: 0o755 },
  );
  return { dir, file, log, stub };
}

function pin({ file, stub }, extraEnv = {}) {
  const result = spawnSync("bash", [PIN, file], {
    encoding: "utf8",
    env: { ...process.env, ROFL_IMAGE_DIGEST_CMD: stub, ...extraEnv },
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

const lookedUp = ({ log }) => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : []);
const read = ({ file }) => fs.readFileSync(file, "utf8");

describe("pin-image-digest.sh", function () {
  it("names a tag-only image by its digest alone, and records the tag above it", function () {
    const t = setup(compose(`image: ${IMAGE}:base-testnet`));
    const { code, out } = pin(t);

    expect(code, out).to.equal(0);
    expect(read(t)).to.equal(compose(pinned("base-testnet", HEX_A)));
    expect(lookedUp(t)).to.deep.equal([`${IMAGE}:base-testnet`]);
  });

  it("looks up the tag recorded above a pinned image and replaces the old digest", function () {
    const t = setup(compose(pinned("base-testnet", HEX_B)));
    const { code, out } = pin(t);

    expect(code, out).to.equal(0);
    expect(read(t)).to.equal(compose(pinned("base-testnet", HEX_A)));
    expect(lookedUp(t)).to.deep.equal([`${IMAGE}:base-testnet`]);
  });

  it("takes the tag on the line over a recorded one, and rewrites the record", function () {
    // What release-mainnet.sh leaves before it pins: a new version tag under the old record.
    const t = setup(compose(["# pinned from :0.1.0", `image: ${IMAGE}:0.2.0`]));
    const { code, out } = pin(t);

    expect(code, out).to.equal(0);
    expect(read(t)).to.equal(compose(pinned("0.2.0", HEX_A)));
    expect(lookedUp(t)).to.deep.equal([`${IMAGE}:0.2.0`]);
  });

  it("rewrites the tag-and-digest form to the digest alone", function () {
    const t = setup(compose(`image: ${IMAGE}:base-testnet@sha256:${HEX_B}`));
    const { code, out } = pin(t);

    expect(code, out).to.equal(0);
    expect(read(t)).to.equal(compose(pinned("base-testnet", HEX_A)));
    expect(lookedUp(t)).to.deep.equal([`${IMAGE}:base-testnet`]);
  });

  it("keeps a comment that is not the record, above the record it adds", function () {
    const t = setup(compose(["# Pushed by the release script.", `image: ${IMAGE}:base-mainnet-latest`]));
    const { code, out } = pin(t);

    expect(code, out).to.equal(0);
    expect(read(t)).to.equal(compose(["# Pushed by the release script.", ...pinned("base-mainnet-latest", HEX_A)]));
  });

  it("changes nothing on a second run", function () {
    const t = setup(compose(`image: ${IMAGE}:base-testnet`));
    expect(pin(t).code).to.equal(0);
    const once = read(t);
    const mtime = fs.statSync(t.file).mtimeMs;

    const { code, out } = pin(t);

    expect(code, out).to.equal(0);
    expect(out).to.include("already");
    expect(read(t)).to.equal(once);
    expect(fs.statSync(t.file).mtimeMs).to.equal(mtime);
  });

  it("keeps the quotes off, a trailing comment, CRLF line ends and the file's mode", function () {
    const t = setup(compose(`image: "${IMAGE}:base-testnet"   # pushed by image:push`).replace(/\n/g, "\r\n"));
    fs.chmodSync(t.file, 0o644);
    const { code, out } = pin(t);

    expect(code, out).to.equal(0);
    expect(read(t)).to.equal(
      compose(["# pinned from :base-testnet", `image: ${IMAGE}@sha256:${HEX_A}   # pushed by image:push`]).replace(/\n/g, "\r\n"),
    );
    expect(fs.statSync(t.file).mode & 0o777).to.equal(0o644);
    // And a second run on the CRLF file reads its own record back.
    expect(pin(t).out).to.include("already");
  });

  it("pins every service's image", function () {
    const contents = [compose(`image: ${IMAGE}:base-testnet`).trimEnd(), "  sidecar:", "    image: localhost:5000/sidecar:1", ""].join("\n");
    const t = setup(contents);
    const { code, out } = pin(t);

    expect(code, out).to.equal(0);
    const text = read(t);
    expect(text).to.include(`    # pinned from :base-testnet\n    image: ${IMAGE}@sha256:${HEX_A}\n`);
    expect(text).to.include(`  sidecar:\n    # pinned from :1\n    image: localhost:5000/sidecar@sha256:${HEX_A}\n`);
    expect(lookedUp(t)).to.deep.equal([`${IMAGE}:base-testnet`, "localhost:5000/sidecar:1"]);
  });

  it("leaves the file untouched when the lookup fails", function () {
    const before = compose(pinned("base-testnet", HEX_B));
    const t = setup(before, { exitCode: 1 });
    const { code, out } = pin(t);

    expect(code).to.not.equal(0);
    expect(out).to.include(`${IMAGE}:base-testnet`);
    expect(read(t)).to.equal(before);
    expect(fs.readdirSync(t.dir).sort()).to.deep.equal(["compose.base-testnet.yaml", "lookup.log", "lookup.sh"]);
  });

  it("leaves the file untouched when the lookup returns something that is not a digest", function () {
    for (const answer of [
      "",
      HEX_A,
      `sha256:${HEX_A.slice(1)}`,
      `sha256:${HEX_A}0`,
      `sha256:${HEX_B.toUpperCase()}`,
      `sha512:${HEX_A}`,
      `sha256:${HEX_A} sha256:${HEX_B}`,
      "error: not found",
    ]) {
      const before = compose(`image: ${IMAGE}:base-testnet`);
      const t = setup(before, { answer });
      const { code, out } = pin(t);

      expect(code, `answer ${JSON.stringify(answer)}`).to.not.equal(0);
      expect(out).to.include("not a sha256 digest");
      expect(read(t), `answer ${JSON.stringify(answer)}`).to.equal(before);
    }
  });

  it("writes nothing when any one of several lookups fails", function () {
    const before = [compose(`image: ${IMAGE}:base-testnet`).trimEnd(), "  sidecar:", "    image: ghcr.io/example/sidecar:1", ""].join("\n");
    const t = setup(before);
    // The stub answers junk for the second reference only.
    fs.writeFileSync(
      t.stub,
      ["#!/bin/bash", `case "$1" in *sidecar*) echo junk ;; *) echo sha256:${HEX_A} ;; esac`, ""].join("\n"),
      { mode: 0o755 },
    );
    const { code } = pin(t);

    expect(code).to.not.equal(0);
    expect(read(t)).to.equal(before);
  });

  it("refuses, looking nothing up, when there is no tag to look up", function () {
    for (const before of [
      compose(`image: ${IMAGE}`), // no tag at all
      compose(`image: ${IMAGE}@sha256:${HEX_B}`), // pinned, with no record above
      compose(["# pinned from base-testnet", `image: ${IMAGE}@sha256:${HEX_B}`]), // record without its colon
      compose(["# pinned from :bad tag", `image: ${IMAGE}@sha256:${HEX_B}`]), // not a tag
      compose(["# pinned from :base-testnet", "", `image: ${IMAGE}@sha256:${HEX_B}`]), // not directly above
      compose("platform: linux/amd64"), // no image at all
    ]) {
      const t = setup(before);
      const { code, out } = pin(t);

      expect(code, before).to.not.equal(0);
      expect(read(t)).to.equal(before);
      expect(lookedUp(t)).to.deep.equal([]);
      if (before.includes("@sha256")) expect(out).to.include("# pinned from :<tag>");
    }
  });

  it("refuses an image interpolated from the environment", function () {
    const before = compose("image: ${ORACLE_IMAGE}:base-testnet");
    const t = setup(before);
    const { code } = pin(t);

    expect(code).to.not.equal(0);
    expect(read(t)).to.equal(before);
    expect(lookedUp(t)).to.deep.equal([]);
  });

  it("writes what the preflight accepts", function () {
    const t = setup(compose(`image: ${IMAGE}:base-testnet`));
    expect(pin(t).code).to.equal(0);
    const result = spawnSync(
      "bash",
      ["-c", '. "$1"; rofl_unpinned_images "$2"', "_", path.join(REPO_ROOT, "scripts", "rofl-image-refs.sh"), t.file],
      { encoding: "utf8" },
    );

    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal("");
  });

  describe("the default lookup, through docker buildx imagetools", function () {
    // ROFL_DOCKER names the docker CLI (default `docker`), so a fake one stands in here.
    function withDocker(t, body) {
      const docker = path.join(t.dir, "fake-docker");
      fs.writeFileSync(docker, `#!/bin/bash\nprintf '%s\\n' "$*" >> '${t.log}'\n${body}\n`, { mode: 0o755 });
      const result = spawnSync("bash", [PIN, t.file], {
        encoding: "utf8",
        env: { ...process.env, ROFL_IMAGE_DIGEST_CMD: "", ROFL_DOCKER: docker },
      });
      return { code: result.status, out: `${result.stdout}${result.stderr}` };
    }

    it("takes the digest of the reference itself, not of a manifest inside an index", function () {
      const t = setup(compose(`image: ${IMAGE}:base-testnet`));
      const json = JSON.stringify({
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.index.v1+json",
        digest: `sha256:${HEX_A}`,
        size: 856,
        manifests: [{ mediaType: "application/vnd.oci.image.manifest.v1+json", digest: `sha256:${HEX_B}`, size: 1 }],
      });
      const { code, out } = withDocker(
        t,
        `case "$1 $2" in "buildx version") echo v0.20.0 ;; "buildx imagetools") echo '${json}' ;; *) exit 9 ;; esac`,
      );

      expect(code, out).to.equal(0);
      expect(read(t)).to.equal(compose(pinned("base-testnet", HEX_A)));
      expect(lookedUp(t)).to.deep.equal([
        "buildx version",
        `buildx imagetools inspect ${IMAGE}:base-testnet --format {{json .Manifest}}`,
      ]);
    });

    it("says what is needed when buildx is missing, and writes nothing", function () {
      const before = compose(`image: ${IMAGE}:base-testnet`);
      const t = setup(before);
      const { code, out } = withDocker(t, "exit 1");

      expect(code).to.not.equal(0);
      expect(out).to.include("docker buildx imagetools");
      expect(out).to.include("ROFL_IMAGE_DIGEST_CMD");
      expect(read(t)).to.equal(before);
    });

    it("says what is needed when the docker CLI is missing, and writes nothing", function () {
      const before = compose(`image: ${IMAGE}:base-testnet`);
      const t = setup(before);
      const result = spawnSync("bash", [PIN, t.file], {
        encoding: "utf8",
        env: { ...process.env, ROFL_IMAGE_DIGEST_CMD: "", ROFL_DOCKER: path.join(t.dir, "no-such-docker") },
      });
      const out = `${result.stdout}${result.stderr}`;

      expect(result.status).to.not.equal(0);
      expect(out).to.include("docker buildx imagetools");
      expect(out).to.include("ROFL_IMAGE_DIGEST_CMD");
      expect(read(t)).to.equal(before);
    });

    it("refuses an answer with no digest of its own, and writes nothing", function () {
      const before = compose(`image: ${IMAGE}:base-testnet`);
      const t = setup(before);
      const json = JSON.stringify({ schemaVersion: 2, manifests: [{ digest: `sha256:${HEX_B}` }] });
      const { code, out } = withDocker(
        t,
        `case "$1 $2" in "buildx version") echo v0.20.0 ;; "buildx imagetools") echo '${json}' ;; *) exit 9 ;; esac`,
      );

      expect(code).to.not.equal(0);
      expect(out).to.include("not a sha256 digest");
      expect(read(t)).to.equal(before);
    });
  });
});

describe("release-mainnet.sh", function () {
  /** Runs the release in a temp dir with a docker that records what it was asked and does nothing. */
  function release(t, version) {
    fs.writeFileSync(path.join(t.dir, "rofl.yaml"), "name: test\nversion: 0.1.0\n");
    const bin = path.join(t.dir, "bin");
    fs.mkdirSync(bin);
    const dockerLog = path.join(t.dir, "docker.log");
    fs.writeFileSync(path.join(bin, "docker"), `#!/bin/bash\nprintf '%s\\n' "$*" >> '${dockerLog}'\n`, { mode: 0o755 });
    const result = spawnSync("bash", [RELEASE, path.basename(t.file)], {
      cwd: t.dir,
      input: `${version}\n`,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ROFL_IMAGE_DIGEST_CMD: t.stub },
    });
    const docker = fs.existsSync(dockerLog) ? fs.readFileSync(dockerLog, "utf8").trim().split("\n") : [];
    return { code: result.status, out: `${result.stdout}${result.stderr}`, docker };
  }

  const mainnetCompose = (imageLines) =>
    ["services:", "  oracle:", "    # comment kept", ...imageLines.map((l) => `    ${l}`), "    environment:", "      - LOG_LEVEL=warn", ""].join(
      "\n",
    );

  it("ends with the compose naming the digest it pushed, the version recorded above", function () {
    const t = setup(mainnetCompose([`image: ${IMAGE}:base-mainnet-latest`]), { name: "compose.base-mainnet.yaml" });
    const { code, out, docker } = release(t, "0.2.0");

    expect(code, out).to.equal(0);
    expect(read(t)).to.equal(mainnetCompose(pinned("0.2.0", HEX_A)));
    expect(fs.readFileSync(path.join(t.dir, "rofl.yaml"), "utf8")).to.include("version: 0.2.0");
    expect(docker).to.deep.equal([`build --platform linux/amd64 -t ${IMAGE}:0.2.0 -f Dockerfile.oracle .`, `push ${IMAGE}:0.2.0`]);
    expect(lookedUp(t)).to.deep.equal([`${IMAGE}:0.2.0`]);
    expect(out).to.include("compose.base-mainnet.yaml");
  });

  it("moves an already pinned compose to the new version and its digest", function () {
    const t = setup(mainnetCompose(pinned("0.1.0", HEX_B)), { name: "compose.base-mainnet.yaml" });
    const { code, out, docker } = release(t, "0.2.0");

    expect(code, out).to.equal(0);
    expect(read(t)).to.equal(mainnetCompose(pinned("0.2.0", HEX_A)));
    expect(docker).to.deep.equal([`build --platform linux/amd64 -t ${IMAGE}:0.2.0 -f Dockerfile.oracle .`, `push ${IMAGE}:0.2.0`]);
    expect(lookedUp(t)).to.deep.equal([`${IMAGE}:0.2.0`]);
  });

  it("fails, claiming no release, when the digest cannot be read back", function () {
    const t = setup(mainnetCompose([`image: ${IMAGE}:base-mainnet-latest`]), { name: "compose.base-mainnet.yaml", exitCode: 1 });
    const { code, out } = release(t, "0.2.0");

    expect(code).to.not.equal(0);
    expect(out).to.not.include("Success");
    expect(out).to.include("pin-image-digest.sh");
  });
});
