const { expect } = require("chai");
const { readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");

const { STREAM_SETTING_DEFAULTS } = require("../src/stream/streamConfig");

/**
 * The oracle machine publishes the live reasoning stream's port and nothing else. ElizaOS can
 * open servers of its own inside the container (it is not started as a server here, but a
 * plugin or a setting could change that); only what compose publishes is reachable from outside,
 * so this list is the whole network surface of the machine.
 *
 * Read line by line rather than with a YAML library: the oracle does not depend on one, and the
 * shape checked is narrow (the generated compose files are written by scripts/rofl-set-secrets.sh,
 * which rewrites only the `environment:` block).
 */
const ROOT = join(__dirname, "..", "..");
const COMPOSE_FILES = readdirSync(ROOT).filter((file) => /^compose(\..+)?\.yaml$/.test(file));
const PORT = STREAM_SETTING_DEFAULTS.STREAM_PORT;

/** The `- ` items of the list under the key `name:` at the given indent. */
function listUnder(lines, name, indent) {
  const start = lines.findIndex((line) => line === `${" ".repeat(indent)}${name}:`);
  if (start === -1) return null;
  const items = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const lead = line.length - line.trimStart().length;
    if (lead <= indent) break;
    if (line.trimStart().startsWith("- ")) items.push(line.trim().slice(2).trim());
  }
  return items;
}

describe("compose files publish only the stream port", () => {
  it("finds all five compose files", () => {
    expect(COMPOSE_FILES).to.have.members([
      "compose.yaml",
      "compose.testnet.yaml",
      "compose.mainnet.yaml",
      "compose.base-testnet.yaml",
      "compose.base-mainnet.yaml",
    ]);
  });

  it("uses 8787 as the stream port, a port no harness service uses", () => {
    expect(PORT).to.equal(8787);
  });

  for (const file of COMPOSE_FILES) {
    describe(file, () => {
      const text = readFileSync(join(ROOT, file), "utf8");
      const lines = text.split("\n");

      it("has one service, the oracle", () => {
        const services = lines.filter((line) => /^ {2}[A-Za-z0-9_-]+:\s*$/.test(line));
        expect(services).to.deep.equal(["  oracle:"]);
      });

      it(`publishes exactly "${PORT}:${PORT}" and nothing else`, () => {
        expect(listUnder(lines, "ports", 4)).to.deep.equal([`"${PORT}:${PORT}"`]);
        const portKeys = lines.filter((line) => /^\s*ports\s*:/.test(line));
        expect(portKeys, "one ports: key in the file").to.have.length(1);
      });

      it("does not open the container's network another way", () => {
        expect(text).to.not.match(/^\s*expose\s*:/m);
        expect(text).to.not.match(/^\s*network_mode\s*:/m);
        expect(text).to.not.match(/^\s*networks\s*:/m);
      });

      it("keeps ports: above the one environment: block, which the secrets script rewrites", () => {
        const envAt = lines.findIndex((line) => /^\s*environment:\s*$/.test(line));
        const portsAt = lines.findIndex((line) => /^\s*ports:\s*$/.test(line));
        expect(lines.filter((line) => /^\s*environment:/.test(line))).to.have.length(1);
        expect(portsAt).to.be.greaterThan(-1);
        expect(portsAt).to.be.below(envAt);
      });

      it("does not move the stream to another port in its environment", () => {
        const env = listUnder(lines, "environment", 4) ?? [];
        const setting = env.find((item) => item.startsWith("STREAM_PORT="));
        if (setting) expect(setting).to.equal(`STREAM_PORT=${PORT}`);
      });
    });
  }
});

/**
 * The stream settings are plain configuration, never secrets: in the settings template and in
 * each generated compose file they sit below the plaintext delimiter (above it is what is pushed
 * on-chain as an encrypted ROFL secret). A testnet compose file and its mainnet twin list the
 * same stream settings, so a setting added on one network is not missing on the other.
 */
const PLAINTEXT_MARKER = "# === 📄 ORC BUNDLE CONFIGURATION (PLAINTEXT) ===";
const STREAM_SETTING = /^STREAM_[A-Z_]+=/;
const KNOWN_STREAM_SETTINGS = new Set([
  ...Object.keys(STREAM_SETTING_DEFAULTS),
  "STREAM_ALLOWED_ORIGINS",
]);
const COMPOSE_TWINS = [
  ["compose.testnet.yaml", "compose.mainnet.yaml"],
  ["compose.base-testnet.yaml", "compose.base-mainnet.yaml"],
];

/** Each stream setting in `lines` (a leading `- ` dropped) and whether it is below the marker. */
function streamSettings(lines) {
  const markerAt = lines.findIndex((line) => line.trim() === PLAINTEXT_MARKER);
  return lines
    .map((line, index) => ({ text: line.trim().replace(/^- /, ""), index }))
    .filter(({ text }) => STREAM_SETTING.test(text))
    .map(({ text, index }) => ({
      name: text.slice(0, text.indexOf("=")),
      belowMarker: markerAt !== -1 && index > markerAt,
    }));
}

describe("stream settings are plain configuration, the same on each network's twins", () => {
  it("finds the stream settings below the marker and flags one above it (the check itself)", () => {
    const below = streamSettings(["SECRET=1", PLAINTEXT_MARKER, "STREAM_ENABLED=true"]);
    expect(below).to.deep.equal([{ name: "STREAM_ENABLED", belowMarker: true }]);
    const above = streamSettings(["STREAM_ENABLED=true", PLAINTEXT_MARKER]);
    expect(above).to.deep.equal([{ name: "STREAM_ENABLED", belowMarker: false }]);
    expect(streamSettings(["      - STREAM_PORT=8787"])[0].belowMarker).to.equal(false);
  });

  it("keeps every stream setting in the settings template below the plaintext delimiter", () => {
    const lines = readFileSync(join(__dirname, "..", ".env.oracle.example"), "utf8").split("\n");
    const settings = streamSettings(lines);
    expect(settings.map((s) => s.name)).to.include("STREAM_ENABLED");
    for (const { name, belowMarker } of settings) {
      expect(belowMarker, `${name} sits below the plaintext delimiter`).to.equal(true);
      expect(KNOWN_STREAM_SETTINGS.has(name), `${name} is a stream setting`).to.equal(true);
    }
  });

  for (const [testnet, mainnet] of COMPOSE_TWINS) {
    it(`${testnet} and ${mainnet} list the same stream settings, below the delimiter`, () => {
      const read = (file) => streamSettings(readFileSync(join(ROOT, file), "utf8").split("\n"));
      const [a, b] = [read(testnet), read(mainnet)];
      expect(a.map((s) => s.name).sort()).to.deep.equal(b.map((s) => s.name).sort());
      for (const { name, belowMarker } of [...a, ...b]) {
        expect(belowMarker, `${name} sits below the plaintext delimiter`).to.equal(true);
      }
    });
  }
});
