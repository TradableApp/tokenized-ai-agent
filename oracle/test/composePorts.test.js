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
