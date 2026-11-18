"use strict";

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const {
  AGENT_ENV_ALLOW_LIST,
  agentForFramework,
  withoutSecrets,
  scrubStoredAgentSettings,
  cleanStoredAgentSettings,
} = require("../src/elizaos/agentSettings");

const AGENT_ID = "11111111-2222-3333-4444-555555555555";

function stored() {
  return {
    model: "some-model",
    secrets: {
      LARGE_MODEL: "kept",
      PRIVATE_KEY: "would-be-a-key",
      POSTGRES_URL: "would-be-a-url",
    },
    mcp: {
      servers: {
        market: { type: "stdio", command: "node", args: ["server.js"], env: { A_KEY: "x" } },
        other: { type: "stdio", command: "node" },
      },
    },
  };
}

function fakeDb(rows) {
  const calls = [];
  return {
    calls,
    query: async (text, values) => {
      calls.push({ text, values });
      if (/^\s*SELECT/i.test(text)) {
        return { rows: rows.map((settings, index) => ({ id: `agent-${index}`, settings })) };
      }
      return { rowCount: 1, rows: [] };
    },
  };
}

describe("what the agent framework may copy from the environment", function () {
  it("names nothing that looks like a secret, a key or an address of a service", function () {
    const secretLike = /KEY|SECRET|TOKEN|PASSWORD|PRIVATE|SALT|URL|RPC|DSN|CERT|POSTGRES|WALLET/;

    for (const name of AGENT_ENV_ALLOW_LIST) {
      expect(name, name).to.not.match(secretLike);
    }
  });

  it("cannot be changed by a caller", function () {
    expect(Object.isFrozen(AGENT_ENV_ALLOW_LIST)).to.equal(true);
  });

  // The framework's own function, with its own list set: this is what addAgents runs.
  it("keeps every other variable out of the character the framework stores", async function () {
    const core = require("@elizaos/core");
    const character = { name: "probe", settings: { secrets: {} } };
    process.env.PROBE_ONLY_SIGNING_KEY = "must-not-be-copied";
    process.env.LARGE_MODEL_PROBE_BACKUP = process.env.LARGE_MODEL ?? "";
    process.env.LARGE_MODEL = "a-model-name";
    const before = core.getAllowedEnvVars();
    try {
      core.setAllowedEnvVars([...AGENT_ENV_ALLOW_LIST]);
      await core.setDefaultSecretsFromEnv(character);
    } finally {
      core.setAllowedEnvVars(before);
      delete process.env.PROBE_ONLY_SIGNING_KEY;
      if (process.env.LARGE_MODEL_PROBE_BACKUP) {
        process.env.LARGE_MODEL = process.env.LARGE_MODEL_PROBE_BACKUP;
      } else {
        delete process.env.LARGE_MODEL;
      }
      delete process.env.LARGE_MODEL_PROBE_BACKUP;
    }

    expect(character.settings.secrets).to.not.have.property("PROBE_ONLY_SIGNING_KEY");
    expect(character.settings.secrets).to.have.property("LARGE_MODEL", "a-model-name");
    for (const name of Object.keys(character.settings.secrets)) {
      expect(AGENT_ENV_ALLOW_LIST, name).to.include(name);
    }
  });

  // Without a list the framework copies everything. This holds the reason the list exists: if a
  // release stops doing that, or renames the function, this fails and the module is re-read.
  it("is needed: with no list set the framework copies every variable", async function () {
    const core = require("@elizaos/core");
    const character = { name: "probe", settings: { secrets: {} } };
    process.env.PROBE_ONLY_SIGNING_KEY = "copied-when-no-list";
    const before = core.getAllowedEnvVars();
    try {
      core.setAllowedEnvVars(null);
      await core.setDefaultSecretsFromEnv(character);
    } finally {
      core.setAllowedEnvVars(before);
      delete process.env.PROBE_ONLY_SIGNING_KEY;
    }

    expect(character.settings.secrets).to.have.property("PROBE_ONLY_SIGNING_KEY");
  });

  it("is set in the oracle before the agent is added", function () {
    const source = fs.readFileSync(path.join(__dirname, "../src/aiAgentOracle.js"), "utf8");
    const set = source.indexOf("setAllowedEnvVars(");
    const added = source.indexOf("elizaOS.addAgents(");

    expect(set, "setAllowedEnvVars is called").to.be.greaterThan(-1);
    expect(added, "addAgents is called").to.be.greaterThan(-1);
    expect(set).to.be.lessThan(added);
  });
});

describe("cleaning stored agent settings", function () {
  it("drops every stored secret whose name is not allowed, and keeps the allowed ones", function () {
    const cleaned = withoutSecrets(stored(), ["LARGE_MODEL"]);

    expect(cleaned.settings.secrets).to.deep.equal({ LARGE_MODEL: "kept" });
    expect(cleaned.removedSecrets).to.equal(2);
  });

  it("drops what each tool server is started with, and keeps how it is started", function () {
    const cleaned = withoutSecrets(stored(), ["LARGE_MODEL"]);

    expect(cleaned.settings.mcp.servers.market).to.deep.equal({
      type: "stdio",
      command: "node",
      args: ["server.js"],
    });
    expect(cleaned.settings.mcp.servers.other).to.deep.equal({ type: "stdio", command: "node" });
    expect(cleaned.removedToolEnv).to.equal(1);
  });

  it("leaves every other setting as it was and does not change what it was given", function () {
    const input = stored();
    const copy = JSON.parse(JSON.stringify(input));

    const cleaned = withoutSecrets(input, ["LARGE_MODEL"]);

    expect(cleaned.settings.model).to.equal("some-model");
    expect(input).to.deep.equal(copy);
  });

  it("copes with settings that have no secrets and no tool servers", function () {
    expect(withoutSecrets({ model: "m" }, [])).to.deep.equal({
      settings: { model: "m" },
      removedSecrets: 0,
      removedToolEnv: 0,
    });
    expect(withoutSecrets(null, []).settings).to.deep.equal({});
    expect(withoutSecrets({ secrets: "not-an-object" }, []).settings).to.deep.equal({
      secrets: {},
    });
  });

  it("cleans every stored agent, and says how much it removed", async function () {
    const db = fakeDb([stored(), { model: "m", secrets: { LARGE_MODEL: "kept" } }, stored()]);

    const result = await scrubStoredAgentSettings({ query: db.query, allowList: ["LARGE_MODEL"] });

    expect(result).to.deep.equal({ agents: 3, removedSecrets: 4, removedToolEnv: 2 });
    const writes = db.calls.filter((call) => /^\s*UPDATE/i.test(call.text));
    expect(writes.map((call) => call.values[0])).to.deep.equal(["agent-0", "agent-2"]);
    for (const write of writes) {
      const written = JSON.parse(write.values[1]);
      expect(written.secrets).to.deep.equal({ LARGE_MODEL: "kept" });
      expect(JSON.stringify(written)).to.not.include("would-be");
    }
  });

  it("writes nothing when there is nothing to remove", async function () {
    const db = fakeDb([{ model: "m", secrets: { LARGE_MODEL: "kept" } }]);

    const result = await scrubStoredAgentSettings({ query: db.query, allowList: ["LARGE_MODEL"] });

    expect(result).to.deep.equal({ agents: 1, removedSecrets: 0, removedToolEnv: 0 });
    expect(db.calls).to.have.lengthOf(1);
  });

  it("writes nothing when no agent is stored", async function () {
    const db = fakeDb([]);

    const result = await scrubStoredAgentSettings({ query: db.query, allowList: [] });

    expect(result).to.deep.equal({ agents: 0, removedSecrets: 0, removedToolEnv: 0 });
    expect(db.calls).to.have.lengthOf(1);
  });

  it("passes a failed query on to the caller", async function () {
    const failing = async () => {
      throw new Error("connection refused");
    };

    let caught = null;
    try {
      await scrubStoredAgentSettings({ query: failing, allowList: [] });
    } catch (error) {
      caught = error;
    }

    expect(caught).to.be.an("error");
  });
});

describe("what the oracle hands the framework for one agent", function () {
  const character = {
    name: "probe",
    settings: {
      model: "some-model",
      secrets: {},
      mcp: { servers: { market: { type: "stdio", command: "node", env: { A_KEY: "tool-key" } } } },
    },
  };
  const env = { POSTGRES_URL: "postgres://user:pw@host/db", PGLITE_DATA_DIR: "./data" };

  it("keeps the tool servers out of the character, which is what gets stored", function () {
    const agent = agentForFramework({ character, env });

    expect(agent.character.settings).to.not.have.property("mcp");
    expect(agent.character.settings.model).to.equal("some-model");
    expect(JSON.stringify(agent.character)).to.not.include("tool-key");
  });

  it("passes the tool servers and the database settings as runtime settings", function () {
    const agent = agentForFramework({ character, env });

    expect(agent.settings).to.deep.equal({
      mcp: character.settings.mcp,
      POSTGRES_URL: env.POSTGRES_URL,
      PGLITE_DATA_DIR: env.PGLITE_DATA_DIR,
    });
  });

  it("leaves out a database setting that is not set, and does not change the character", function () {
    const copy = JSON.parse(JSON.stringify(character));

    const agent = agentForFramework({ character, env: { POSTGRES_URL: "  " } });

    expect(agent.settings).to.not.have.property("POSTGRES_URL");
    expect(agent.settings).to.not.have.property("PGLITE_DATA_DIR");
    expect(character).to.deep.equal(copy);
  });

  // The framework's own runtime: its plugins read the database address and the tool servers
  // through getSetting, which never looks at the environment. This is the check that they can
  // still find both, and that neither is in the character the runtime stores.
  it("lets the framework's plugins find the database and the tool servers", function () {
    const core = require("@elizaos/core");
    const agent = agentForFramework({ character, env });

    const runtime = new core.AgentRuntime({ character: agent.character, settings: agent.settings });

    expect(runtime.getSetting("POSTGRES_URL")).to.equal(env.POSTGRES_URL);
    expect(runtime.getSetting("PGLITE_DATA_DIR")).to.equal(env.PGLITE_DATA_DIR);
    expect(runtime.settings.mcp.servers.market.env.A_KEY).to.equal("tool-key");
    const storedCharacter = JSON.stringify(runtime.character);
    expect(storedCharacter).to.not.include("postgres://");
    expect(storedCharacter).to.not.include("tool-key");
  });

  it("is what the oracle adds the agent with, and the clean follows the start", function () {
    const source = fs.readFileSync(path.join(__dirname, "../src/aiAgentOracle.js"), "utf8");
    const added = source.indexOf("elizaOS.addAgents(");
    const started = source.indexOf("await elizaOS.startAgents()");
    const cleaned = source.indexOf("await cleanStoredAgentSettings(");

    expect(source.slice(added, started)).to.include("agentForFramework(");
    expect(cleaned).to.be.greaterThan(started);
  });
});

describe("the clean at start-up", function () {
  function recorder() {
    const alerts = [];
    const lines = [];
    return {
      alerts,
      lines,
      alert: async (subject, message) => alerts.push({ subject, message }),
      log: (line) => lines.push(line),
    };
  }

  it("says what it removed and alerts, since an earlier build stored it", async function () {
    const out = recorder();

    await cleanStoredAgentSettings({
      scrub: async () => ({ agents: 1, removedSecrets: 3, removedToolEnv: 1 }),
      alert: out.alert,
      log: out.log,
    });

    expect(out.lines.join(" ")).to.include("3").and.to.include("1 agent");
    expect(out.alerts).to.have.lengthOf(1);
    expect(out.alerts[0].subject).to.equal(
      "CRITICAL: Stored agent settings held values that were removed",
    );
    expect(out.alerts[0].message).to.include("3");
  });

  it("does not alert when nothing an earlier build stored was found", async function () {
    const out = recorder();

    await cleanStoredAgentSettings({
      scrub: async () => ({ agents: 1, removedSecrets: 0, removedToolEnv: 0 }),
      alert: out.alert,
      log: out.log,
    });

    expect(out.alerts).to.have.lengthOf(0);
    expect(out.lines).to.have.lengthOf(1);
  });

  it("alerts and carries on when the clean fails, with nothing of the error but its kind", async function () {
    const out = recorder();

    await cleanStoredAgentSettings({
      scrub: async () => {
        throw new Error("password authentication failed for postgres://user:pw@host/db");
      },
      alert: out.alert,
      log: out.log,
    });

    expect(out.alerts).to.have.lengthOf(1);
    expect(out.alerts[0].subject).to.equal("CRITICAL: Stored agent settings could not be cleaned");
    expect(JSON.stringify([out.alerts, out.lines])).to.not.include("pw@host");
  });

  it("still carries on when the alert itself fails", async function () {
    const out = recorder();

    await cleanStoredAgentSettings({
      scrub: async () => {
        throw new Error("down");
      },
      alert: async () => {
        throw new Error("alerting is down too");
      },
      log: out.log,
    });

    expect(out.lines.length).to.be.greaterThan(0);
  });
});
