"use strict";

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");
const proxyquire = require("proxyquire").noCallThru();

const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

const { MARKET_DATA_TOOLS } = require("../src/elizaos/marketDataTools");

const ORACLE_ROOT = path.join(__dirname, "..");
const PACKAGE_NAME = "@coingecko/coingecko-mcp";
// Written out, not read from package.json: moving the version is then a deliberate edit here too,
// made by someone who has started the new release and looked at the tools it offers.
const PINNED_VERSION = "2.5.0";
const INSTALLED_PACKAGE = path.join(ORACLE_ROOT, "node_modules", ...PACKAGE_NAME.split("/"));

function loadLaunchSettings() {
  // Loaded inside each test so a missing module fails that test, not the whole file.
  return require("../src/elizaos/coingeckoToolServer").coingeckoToolServer;
}

function loadCharacter() {
  // The character reads env files as it loads; a test must not depend on what is in them.
  return proxyquire("../src/elizaos/character.js", { dotenv: { config: () => ({}) } });
}

function isInsideInstalledPackage(file) {
  return fs.realpathSync(file).startsWith(fs.realpathSync(INSTALLED_PACKAGE) + path.sep);
}

async function listToolNames(settings) {
  const transport = new StdioClientTransport({
    command: settings.command,
    args: settings.args,
    // As the framework's MCP plugin starts it: the server's own settings and PATH. The MCP
    // library adds a few defaults of its own (HOME, USER, SHELL and the like).
    env: { ...settings.env, PATH: process.env.PATH },
    stderr: "pipe",
  });
  let serverErrors = "";
  transport.stderr.on("data", (chunk) => {
    serverErrors += chunk;
  });
  const client = new Client({ name: "oracle-test", version: "0" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    return tools.map((tool) => tool.name);
  } catch (error) {
    // "Connection closed" alone says nothing; what the server printed says why.
    error.message = `${error.message}\n--- tool server stderr ---\n${serverErrors}`;
    throw error;
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
    });

    it("runs the entry file of the installed package", function () {
      const [entry] = loadLaunchSettings()({}).args;

      expect(path.isAbsolute(entry)).to.equal(true);
      expect(isInsideInstalledPackage(entry)).to.equal(true);
    });

    // The entry is found through the package's main field. It has to be the file the package
    // itself names as its server, or a release that splits the two would start the wrong one.
    it("runs the file the package names as its server", function () {
      const [entry] = loadLaunchSettings()({}).args;
      const named = require(path.join(INSTALLED_PACKAGE, "package.json")).bin["mcp-server"];

      expect(fs.realpathSync(entry)).to.equal(
        fs.realpathSync(path.resolve(INSTALLED_PACKAGE, named)),
      );
    });

    it("passes one option only, the one that turns the documentation search off", function () {
      const [, ...options] = loadLaunchSettings()({}).args;

      expect(options).to.deep.equal(["--no-tools=docs"]);
    });

    it("uses the pro environment when a key is set", function () {
      const settings = loadLaunchSettings()({ COINGECKO_API_KEY: "a-key" });

      expect(settings.env).to.deep.equal({
        COINGECKO_PRO_API_KEY: "a-key",
        COINGECKO_ENVIRONMENT: "pro",
      });
    });

    // What the settings are with no key, not a claim that calls then succeed: the demo
    // environment wants a demo key, which the oracle does not have a setting for.
    it("names the demo environment and passes no key when none is set", function () {
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

  describe("the agent's character", function () {
    it("starts the server with exactly those launch settings", function () {
      const servers = loadCharacter().settings.mcp.servers;

      expect(servers.coingecko_mcp_local).to.deep.equal(loadLaunchSettings()(process.env));
    });

    it("starts every tool server it has from an installed package, with node itself", function () {
      const servers = Object.entries(loadCharacter().settings.mcp.servers);
      const nodeModules = fs.realpathSync(path.join(ORACLE_ROOT, "node_modules")) + path.sep;

      expect(servers).to.not.be.empty;
      for (const [name, server] of servers) {
        expect(server.type, name).to.equal("stdio");
        expect(server.command, name).to.equal(process.execPath);
        expect(fs.realpathSync(server.args[0]).startsWith(nodeModules), name).to.equal(true);
      }
    });
  });

  describe("the dependency", function () {
    it("is declared at the pinned version, with no range, and installed at it", function () {
      const declared = require("../package.json").dependencies[PACKAGE_NAME];
      const installed = require(path.join(INSTALLED_PACKAGE, "package.json")).version;

      expect(declared).to.equal(PINNED_VERSION);
      expect(installed).to.equal(PINNED_VERSION);
    });

    it("is locked at that version", function () {
      const lock = fs.readFileSync(path.join(ORACLE_ROOT, "bun.lock"), "utf8");

      expect(lock).to.include(`"${PACKAGE_NAME}@${PINNED_VERSION}"`);
    });
  });

  describe("started from the installed package", function () {
    this.timeout(30000);

    let names;
    before(async function () {
      names = await listToolNames(loadLaunchSettings()({}));
    });

    it("offers the fixed market-data tools", function () {
      expect(names).to.include.members(["get_simple_price", "get_coins_markets"]);
    });

    // The watch alerts when a server does not offer these. This is the same check made here, on
    // the installed package, so a move of the pin that drops one fails a test and not a run day.
    it("offers every tool the watch expects of it", function () {
      expect(names).to.include.members([...MARKET_DATA_TOOLS.coingecko_mcp_local]);
    });

    // The package has one, off unless asked for. It would send code written by the model, and the
    // CoinGecko key with it, to a third party to be run.
    it("offers no tool that runs code", function () {
      expect(names).to.not.include("execute");
    });

    // It would send text chosen by the model, which can carry a user's prompt, to a third party.
    it("offers no documentation search", function () {
      expect(names).to.not.include("search_docs");
    });

    it("offers endpoint tools only", function () {
      const others = names.filter((name) => !name.startsWith("get_"));

      expect(others).to.deep.equal([]);
    });
  });
});
