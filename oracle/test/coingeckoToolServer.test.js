"use strict";

const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

const ORACLE_ROOT = path.join(__dirname, "..");
const PACKAGE_NAME = "@coingecko/coingecko-mcp";
const PACKAGE_RUNNERS = /\b(npx|bunx|pnpx|npm\s+exec|pnpm\s+dlx|yarn\s+dlx)\b/;

function loadLaunchSettings() {
  // Loaded inside each test so a missing module fails that test, not the whole file.
  return require("../src/elizaos/coingeckoToolServer").coingeckoToolServer;
}

async function listToolNames(settings, extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: settings.command,
    args: settings.args,
    // As the framework's MCP plugin starts it: the server's own settings and PATH, nothing else.
    env: { ...settings.env, PATH: process.env.PATH, ...extraEnv },
    stderr: "pipe",
  });
  const client = new Client({ name: "oracle-test", version: "0" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    return tools.map((tool) => tool.name);
  } finally {
    await client.close();
  }
}

describe("the market-data tool server", function () {
  describe("launch settings", function () {
    it("starts with node's own executable, not through a shell or a package runner", function () {
      const settings = loadLaunchSettings()({});

      expect(settings.type).to.equal("stdio");
      expect(settings.command).to.equal(process.execPath);
      expect([settings.command, ...settings.args].join(" ")).to.not.match(PACKAGE_RUNNERS);
    });

    it("runs the entry file of the installed package", function () {
      const settings = loadLaunchSettings()({});
      const [entry] = settings.args;
      const installed = path.join(ORACLE_ROOT, "node_modules", ...PACKAGE_NAME.split("/"));

      expect(path.isAbsolute(entry)).to.equal(true);
      expect(fs.realpathSync(entry).startsWith(fs.realpathSync(installed) + path.sep)).to.equal(
        true,
      );
      expect(settings.args).to.have.lengthOf(1);
    });

    it("uses the pro environment when a key is set", function () {
      const settings = loadLaunchSettings()({ COINGECKO_API_KEY: "a-key" });

      expect(settings.env).to.deep.equal({
        COINGECKO_PRO_API_KEY: "a-key",
        COINGECKO_ENVIRONMENT: "pro",
      });
    });

    it("uses the demo environment when no key is set", function () {
      const settings = loadLaunchSettings()({});

      expect(settings.env).to.deep.equal({
        COINGECKO_PRO_API_KEY: "",
        COINGECKO_ENVIRONMENT: "demo",
      });
    });

    it("hands the server nothing from the oracle's environment but its own key", function () {
      const settings = loadLaunchSettings()({
        COINGECKO_API_KEY: "a-key",
        POSTGRES_PASSWORD: "not-for-the-server",
        SLACK_BOT_TOKEN: "not-for-the-server",
      });

      expect(Object.keys(settings.env).sort()).to.deep.equal([
        "COINGECKO_ENVIRONMENT",
        "COINGECKO_PRO_API_KEY",
      ]);
    });
  });

  describe("the dependency", function () {
    it("is declared at one exact version, and that version is the one installed", function () {
      const declared = require("../package.json").dependencies[PACKAGE_NAME];
      const installed = require(
        path.join(ORACLE_ROOT, "node_modules", ...PACKAGE_NAME.split("/"), "package.json"),
      ).version;

      expect(declared, "an exact version, with no range").to.match(/^\d+\.\d+\.\d+$/);
      expect(installed).to.equal(declared);
    });

    it("is locked at that version", function () {
      const declared = require("../package.json").dependencies[PACKAGE_NAME];
      const lock = fs.readFileSync(path.join(ORACLE_ROOT, "bun.lock"), "utf8");

      expect(lock).to.include(`"${PACKAGE_NAME}@${declared}"`);
    });
  });

  describe("started from the installed package", function () {
    this.timeout(30000);

    it("offers the fixed price tool and no tool that runs code", async function () {
      const names = await listToolNames(loadLaunchSettings()({}));

      expect(names).to.include("get_simple_price");
      expect(names).to.not.include("execute");
    });

    it("starts where typescript cannot be loaded, as in the image", async function () {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-tool-server-"));
      const preload = path.join(dir, "no-typescript.cjs");
      fs.writeFileSync(
        preload,
        [
          'const Module = require("module");',
          "const load = Module._load;",
          "Module._load = function (request, ...rest) {",
          '  if (request === "typescript") throw new Error("typescript is not in the image");',
          "  return load.call(this, request, ...rest);",
          "};",
        ].join("\n"),
      );

      try {
        const names = await listToolNames(loadLaunchSettings()({}), {
          NODE_OPTIONS: `--require ${preload}`,
        });

        expect(names).to.include("get_simple_price");
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });
  });

  describe("the oracle's own code", function () {
    function sourceFiles(dir) {
      return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          return ["node_modules", "dist"].includes(entry.name) ? [] : sourceFiles(full);
        }
        return /\.(js|cjs|mjs|ts)$/.test(entry.name) ? [full] : [];
      });
    }

    it("starts nothing through a package runner", function () {
      const offenders = sourceFiles(path.join(ORACLE_ROOT, "src")).filter((file) => {
        const code = fs
          .readFileSync(file, "utf8")
          .split("\n")
          .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
          .join("\n");
        return /["'`]\s*(npx|bunx|pnpx)\s*["'`]|\b(npm\s+exec|pnpm\s+dlx|yarn\s+dlx)\b/.test(code);
      });

      expect(offenders.map((file) => path.relative(ORACLE_ROOT, file))).to.deep.equal([]);
    });
  });
});
