"use strict";

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const {
  AGENT_ENV_ALLOW_LIST,
  agentForFramework,
  allowOnlyListedEnv,
  withoutSecrets,
  scrubStoredAgentSettings,
  scrubAgentSettingsInPostgres,
  cleanStoredAgentSettings,
  cleanAgentDatabase,
  startAgentWithCleanSettings,
} = require("../src/elizaos/agentSettings");

// The oracle's source with its comment lines taken out, so a call that is only mentioned in a
// comment is not taken for the call.
function oracleSource() {
  return fs
    .readFileSync(path.join(__dirname, "../src/aiAgentOracle.js"), "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

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

  it("is what the framework is told, name for name", function () {
    const core = require("@elizaos/core");
    const before = core.getAllowedEnvVars();
    try {
      allowOnlyListedEnv(core.setAllowedEnvVars);

      expect(core.getAllowedEnvVars()).to.deep.equal([...AGENT_ENV_ALLOW_LIST]);
    } finally {
      core.setAllowedEnvVars(before);
    }
  });

  // The oracle tells the framework through the function above and in no other way, so the list
  // cannot be set to something else, or to nothing, beside it.
  it("is never set by the oracle itself, only handed to the start-up that sets it", function () {
    const source = oracleSource();

    expect(source.match(/setAllowedEnvVars\(/g) ?? [], "no call of its own").to.have.lengthOf(0);
    expect(source).to.not.include("allowOnlyListedEnv(");
  });
});

describe("cleaning stored agent settings", function () {
  it("drops every stored secret whose name is not allowed, and keeps the allowed ones", function () {
    const cleaned = withoutSecrets(stored(), ["LARGE_MODEL"]);

    expect(cleaned.settings.secrets).to.deep.equal({ LARGE_MODEL: "kept" });
    expect(cleaned.removedSecrets).to.equal(2);
  });

  // A stored tool-server block is put back into the running character on the next start and is
  // then used ahead of the one the oracle built, so none of it may stay: not what a server is
  // started with, and not the command either.
  it("drops the stored tool servers whole", function () {
    const cleaned = withoutSecrets(stored(), ["LARGE_MODEL"]);

    expect(cleaned.settings).to.not.have.property("mcp");
    expect(cleaned.removedToolServers).to.equal(2);
  });

  it("drops a stored tool-server block that names no servers", function () {
    const cleaned = withoutSecrets({ model: "m", mcp: { maxRetries: 2 } }, []);

    expect(cleaned.settings).to.deep.equal({ model: "m" });
    expect(cleaned.removedToolServers).to.equal(1);
  });

  // The framework reads a stored setting ahead of the one the oracle hands the runtime, so a
  // name the character does not define itself has no business in the stored row.
  it("drops a stored setting the character does not define, when told which it defines", function () {
    const input = { ...stored(), POSTGRES_URL: "would-be-a-url", voice: { model: "v" } };

    const cleaned = withoutSecrets(input, ["LARGE_MODEL"], ["model", "voice", "secrets", "mcp"]);

    expect(cleaned.settings).to.deep.equal({
      model: "some-model",
      voice: { model: "v" },
      secrets: { LARGE_MODEL: "kept" },
    });
    expect(cleaned.removedSettings).to.equal(1);
  });

  it("filters the stored secrets by the list whether or not the character is said to define them", function () {
    const cleaned = withoutSecrets(stored(), ["LARGE_MODEL"], ["model"]);

    expect(cleaned.settings).to.deep.equal({
      model: "some-model",
      secrets: { LARGE_MODEL: "kept" },
    });
    expect(cleaned.removedSettings).to.equal(0);
    expect(cleaned.removedSecrets).to.equal(2);
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
      removedToolServers: 0,
      removedSettings: 0,
    });
    expect(withoutSecrets(null, []).settings).to.deep.equal({});
    expect(withoutSecrets({ secrets: "not-an-object" }, []).settings).to.deep.equal({
      secrets: {},
    });
  });

  it("cleans every stored agent, and says how much it removed", async function () {
    const db = fakeDb([stored(), { model: "m", secrets: { LARGE_MODEL: "kept" } }, stored()]);

    const result = await scrubStoredAgentSettings({ query: db.query, allowList: ["LARGE_MODEL"] });

    expect(result).to.deep.equal({
      agents: 3,
      removedSecrets: 4,
      removedToolServers: 4,
      removedSettings: 0,
    });
    const writes = db.calls.filter((call) => /^\s*UPDATE/i.test(call.text));
    expect(writes.map((call) => call.values[0])).to.deep.equal(["agent-0", "agent-2"]);
    for (const write of writes) {
      const written = JSON.parse(write.values[1]);
      expect(written.secrets).to.deep.equal({ LARGE_MODEL: "kept" });
      expect(JSON.stringify(written)).to.not.include("would-be");
    }
  });

  it("writes a row whose only fault is a stored tool server with nothing it is started with", async function () {
    const db = fakeDb([{ model: "m", mcp: { servers: { other: { command: "node" } } } }]);

    const result = await scrubStoredAgentSettings({ query: db.query, allowList: [] });

    expect(result).to.deep.equal({
      agents: 1,
      removedSecrets: 0,
      removedToolServers: 1,
      removedSettings: 0,
    });
    expect(JSON.parse(db.calls[1].values[1])).to.deep.equal({ model: "m" });
  });

  it("leaves the empty tool-server block this build stores, and writes nothing for it", async function () {
    const db = fakeDb([{ model: "m", mcp: {} }]);

    const result = await scrubStoredAgentSettings({ query: db.query, allowList: [] });

    expect(result).to.deep.equal({
      agents: 1,
      removedSecrets: 0,
      removedToolServers: 0,
      removedSettings: 0,
    });
    expect(db.calls).to.have.lengthOf(1);
  });

  it("writes a row whose only fault is a setting the character does not define", async function () {
    const db = fakeDb([{ model: "m", POSTGRES_URL: "would-be-a-url" }]);

    const result = await scrubStoredAgentSettings({
      query: db.query,
      allowList: [],
      keepSettings: ["model"],
    });

    expect(result).to.deep.equal({
      agents: 1,
      removedSecrets: 0,
      removedToolServers: 0,
      removedSettings: 1,
    });
    expect(JSON.parse(db.calls[1].values[1])).to.deep.equal({ model: "m" });
  });

  it("writes nothing, and counts nothing, for a stored tool-server name with no value", async function () {
    const db = fakeDb([{ model: "m", mcp: null }]);

    const result = await scrubStoredAgentSettings({ query: db.query, allowList: [] });

    expect(result.removedToolServers).to.equal(0);
    expect(db.calls).to.have.lengthOf(1);
  });

  it("writes nothing when there is nothing to remove", async function () {
    const db = fakeDb([{ model: "m", secrets: { LARGE_MODEL: "kept" } }]);

    const result = await scrubStoredAgentSettings({ query: db.query, allowList: ["LARGE_MODEL"] });

    expect(result).to.deep.equal({
      agents: 1,
      removedSecrets: 0,
      removedToolServers: 0,
      removedSettings: 0,
    });
    expect(db.calls).to.have.lengthOf(1);
  });

  it("writes nothing when no agent is stored", async function () {
    const db = fakeDb([]);

    const result = await scrubStoredAgentSettings({ query: db.query, allowList: [] });

    expect(result).to.deep.equal({
      agents: 0,
      removedSecrets: 0,
      removedToolServers: 0,
      removedSettings: 0,
    });
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

    // Empty and not absent: an absent name lets a stored block through, an empty one replaces
    // it in the running character. The framework refuses a null setting.
    expect(agent.character.settings.mcp).to.deep.equal({});
    expect(require("@elizaos/core").validateCharacter({ bio: "b", ...agent.character }).success).to
      .be.true;
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

  it("hands the runtime its own copy of the tool servers, not the character's", function () {
    const agent = agentForFramework({ character, env });

    agent.settings.mcp.servers.market.command = "changed";

    expect(character.settings.mcp.servers.market.command).to.equal("node");
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
    // The tool plugin looks for its servers here when the character does not carry them.
    expect(runtime.settings.mcp.servers.market.env.A_KEY).to.equal("tool-key");
    const storedCharacter = JSON.stringify(runtime.character);
    expect(storedCharacter).to.not.include("postgres://");
    expect(storedCharacter).to.not.include("tool-key");
  });

  // What the framework does on a start when the database already holds a row: it puts the
  // stored settings under the character's own, and the tool plugin then looks in the character
  // before the runtime's settings. Followed here with the framework's own merge and the tool
  // plugin's own order of looking.
  it("is not overridden by tool servers an earlier start stored", function () {
    const core = require("@elizaos/core");
    const agent = agentForFramework({ character, env });
    const runtime = new core.AgentRuntime({ character: agent.character, settings: agent.settings });

    runtime.mergeAgentSettings({
      settings: { mcp: { servers: { market: { type: "stdio", command: "stored-command" } } } },
    });

    const usable = (settings) => (settings && settings.servers ? settings : undefined);
    const found =
      usable(runtime.getSetting("mcp")) ??
      usable(runtime.character.settings.mcp) ??
      usable(runtime.settings.mcp);
    expect(found.servers.market.command).to.equal("node");
    expect(found.servers.market.env.A_KEY).to.equal("tool-key");
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
      scrub: async () => ({
        agents: 1,
        removedSecrets: 3,
        removedToolServers: 1,
        removedSettings: 0,
      }),
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

  it("alerts for a stored setting the character does not define", async function () {
    const out = recorder();

    await cleanStoredAgentSettings({
      scrub: async () => ({
        agents: 1,
        removedSecrets: 0,
        removedToolServers: 0,
        removedSettings: 2,
      }),
      alert: out.alert,
      log: out.log,
    });

    expect(out.alerts).to.have.lengthOf(1);
    expect(out.alerts[0].message).to.include("2 other stored setting(s)");
  });

  it("does not alert when nothing an earlier build stored was found", async function () {
    const out = recorder();

    await cleanStoredAgentSettings({
      scrub: async () => ({
        agents: 1,
        removedSecrets: 0,
        removedToolServers: 0,
        removedSettings: 0,
      }),
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
    expect(out.alerts[0].message).to.include("(Error)");
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
    await new Promise((resolve) => setImmediate(resolve));

    expect(out.lines.join(" ")).to.include("could not be sent");
  });

  // The alert is the only notice that secrets need rotating, and only the first clean of an old
  // row sends it: a start that stops soon after must not have left before it was sent.
  it("waits for the alert to be sent", async function () {
    const out = recorder();
    let sent = false;

    await cleanStoredAgentSettings({
      scrub: async () => ({ agents: 1, removedSecrets: 1, removedToolServers: 0 }),
      alert: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        sent = true;
      },
      log: out.log,
    });

    expect(sent).to.be.true;
  });

  it("waits for the alert about a clean that failed, too", async function () {
    const out = recorder();
    let sent = false;

    await cleanStoredAgentSettings({
      scrub: async () => {
        throw Object.assign(new Error("no route"), { code: "ECONNREFUSED" });
      },
      alert: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        sent = true;
      },
      log: out.log,
    });

    expect(sent).to.be.true;
  });

  // The clean runs before the oracle starts on its events. An alert that takes minutes to send,
  // or never comes back, must not hold that up for longer than the wait it is given.
  it("stops waiting for an alert that does not come back, and says so", async function () {
    const out = recorder();
    const started = Date.now();

    await cleanStoredAgentSettings({
      scrub: async () => ({ agents: 1, removedSecrets: 1, removedToolServers: 0 }),
      alert: () => new Promise(() => {}),
      log: out.log,
      alertWaitMs: 30,
    });

    expect(Date.now() - started).to.be.lessThan(1000);
    expect(out.lines.join(" ")).to.include("still being sent");
  });

  it("waits no longer than ten seconds unless told otherwise", function () {
    const source = fs.readFileSync(path.join(__dirname, "../src/elizaos/agentSettings.js"), "utf8");

    expect(source).to.match(/const ALERT_WAIT_MS = 10 \* 1000;/);
    expect(source).to.match(/alertWaitMs = ALERT_WAIT_MS/);
  });
});

describe("the clean of the agent database", function () {
  it("does nothing, and says so, where there is no agent database", async function () {
    const lines = [];
    let scrubbed = false;

    await cleanAgentDatabase({
      postgresUrl: null,
      character: { settings: { model: "m" } },
      alert: async () => {},
      log: (line) => lines.push(line),
      scrubInPostgres: async () => {
        scrubbed = true;
      },
    });

    expect(scrubbed).to.be.false;
    expect(lines.join(" ")).to.include("no agent database");
  });

  it("cleans the database it is given, keeping the settings it is told the character defines", async function () {
    const seen = [];

    await cleanAgentDatabase({
      postgresUrl: "postgres://user:pw@host/db",
      character: { settings: { model: "m", secrets: {} } },
      alert: async () => {},
      log: () => {},
      scrubInPostgres: async (options) => {
        seen.push(options);
        return { agents: 0, removedSecrets: 0, removedToolServers: 0, removedSettings: 0 };
      },
    });

    expect(seen).to.deep.equal([
      { postgresUrl: "postgres://user:pw@host/db", keepSettings: ["model", "secrets"] },
    ]);
  });

  // The connection itself, with a stand-in for the database client.
  function fakeClient(rows, { endFails = false } = {}) {
    const record = { options: null, connected: false, ended: false, listeners: [], writes: [] };
    class Client {
      constructor(options) {
        record.options = options;
      }
      on(event) {
        record.listeners.push(event);
      }
      async connect() {
        record.connected = true;
      }
      async query(text, values) {
        if (/^\s*SELECT/i.test(text)) return { rows };
        record.writes.push(JSON.parse(values[1]));
        return { rows: [] };
      }
      async end() {
        record.ended = true;
        if (endFails) throw new Error("already closed");
      }
    }
    return { Client, record };
  }

  it("removes a stored setting the character does not define, over a connection it closes", async function () {
    const { Client, record } = fakeClient([
      { id: "a", settings: { model: "m", POSTGRES_URL: "would-be-a-url" } },
    ]);

    const result = await scrubAgentSettingsInPostgres({
      postgresUrl: "postgres://user:pw@host/db",
      keepSettings: ["model"],
      Client,
    });

    expect(result.removedSettings).to.equal(1);
    expect(record.writes).to.deep.equal([{ model: "m" }]);
    expect(record.options.connectionString).to.equal("postgres://user:pw@host/db");
    expect(record.options.query_timeout).to.be.a("number");
    expect(record.listeners).to.include("error");
    expect(record.ended).to.be.true;
  });

  it("returns what it cleaned even when closing the connection fails", async function () {
    const { Client } = fakeClient([], { endFails: true });

    const result = await scrubAgentSettingsInPostgres({ postgresUrl: "postgres://h/db", Client });

    expect(result.agents).to.equal(0);
  });
});

describe("the agent's start, with its stored settings cleaned", function () {
  const character = { name: "A", settings: { model: "m", mcp: { servers: { market: {} } } } };

  function standIns({ rows = { agents: 1, removedSecrets: 0, removedToolServers: 0 } } = {}) {
    const calls = [];
    const record = { calls, scrubs: [], alerts: [], allowed: null, added: null, lines: [] };
    return {
      record,
      options: {
        postgresUrl: "postgres://user:pw@host/db",
        character,
        env: { POSTGRES_URL: "postgres://user:pw@host/db", PGLITE_DATA_DIR: undefined },
        alert: async (subject) => record.alerts.push(subject),
        setAllowedEnvVars: (list) => {
          calls.push("allow");
          record.allowed = list;
        },
        addAgent: async (agent) => {
          calls.push("add");
          record.added = agent;
          return ["id-1"];
        },
        startAgents: async (ids) => {
          calls.push(`start:${ids.join(",")}`);
        },
        log: (line) => record.lines.push(line),
        scrubInPostgres: async (options) => {
          calls.push("clean");
          record.scrubs.push(options);
          return typeof rows === "function" ? rows() : rows;
        },
      },
    };
  }

  it("cleans, sets the list, adds the agent, starts it and cleans again, in that order", async function () {
    const { record, options } = standIns();

    const ids = await startAgentWithCleanSettings(options);

    expect(record.calls).to.deep.equal(["clean", "allow", "add", "start:id-1", "clean"]);
    expect(ids).to.deep.equal(["id-1"]);
  });

  it("cleans the database it is given, both times, keeping what the character defines", async function () {
    const { record, options } = standIns();

    await startAgentWithCleanSettings(options);

    expect(record.scrubs).to.deep.equal([
      { postgresUrl: "postgres://user:pw@host/db", keepSettings: ["model", "mcp"] },
      { postgresUrl: "postgres://user:pw@host/db", keepSettings: ["model", "mcp"] },
    ]);
  });

  it("sets exactly the list, and adds the agent as the framework is to store it", async function () {
    const { record, options } = standIns();

    await startAgentWithCleanSettings(options);

    expect(record.allowed).to.deep.equal([...AGENT_ENV_ALLOW_LIST]);
    expect(record.added).to.deep.equal(agentForFramework({ character, env: options.env }));
  });

  it("alerts through the alert it is given when a clean removed something", async function () {
    const { record, options } = standIns({
      rows: { agents: 1, removedSecrets: 2, removedToolServers: 0 },
    });

    await startAgentWithCleanSettings(options);

    expect(record.alerts).to.have.lengthOf(2);
    expect(record.alerts[0]).to.include("were removed");
  });

  it("still sets the list and starts the agent where there is no agent database", async function () {
    const { record, options } = standIns();

    await startAgentWithCleanSettings({ ...options, postgresUrl: null });

    expect(record.calls).to.deep.equal(["allow", "add", "start:id-1"]);
  });

  it("does not clean again, or hide the failure, when the agent does not start", async function () {
    const { record, options } = standIns();

    let thrown;
    try {
      await startAgentWithCleanSettings({
        ...options,
        startAgents: async () => {
          throw new Error("no start");
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown?.message).to.equal("no start");
    expect(record.calls).to.deep.equal(["clean", "allow", "add"]);
  });

  // What is left in the oracle is the hand-over of its own values. The framework is reached
  // only through this start, so nothing can add or start an agent beside it.
  it("is how the oracle starts its agent, with its own database, character and alert", function () {
    const source = oracleSource();
    const at = source.indexOf("await startAgentWithCleanSettings({");
    expect(at, "the oracle calls it").to.be.greaterThan(-1);
    // Only what the oracle hands over: from the call to its first callback. Read to the end of
    // the file, the same words are found in other calls, and a value changed here would pass.
    const call = source.slice(at, source.indexOf("addAgent:", at));
    expect(call, "nothing is spread in over a value").to.not.include("...");
    expect(call).to.match(/POSTGRES_URL: agentStateDbUrl \?\? undefined,/);
    expect(call).to.match(/PGLITE_DATA_DIR: process\.env\.PGLITE_DATA_DIR,/);

    expect(call).to.match(/postgresUrl: agentStateDbUrl,/);
    expect(call).to.match(/character: senseAiCharacter,/);
    expect(call).to.match(/alert: sendAlert,/);
    expect(call).to.match(/\n\s+setAllowedEnvVars,/);
    expect(source.match(/elizaOS\.addAgents\(/g)).to.have.lengthOf(1);
    expect(source.match(/elizaOS\.startAgents\(/g)).to.have.lengthOf(1);
    expect(source.indexOf("elizaOS.addAgents(")).to.be.greaterThan(source.indexOf("addAgent:"));
    expect(source).to.not.include("cleanAgentDatabase(");
    expect(source).to.not.include("agentForFramework(");
  });
});
