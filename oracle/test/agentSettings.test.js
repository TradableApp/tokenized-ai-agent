"use strict";

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const {
  AGENT_ENV_ALLOW_LIST,
  withoutSecrets,
  scrubStoredAgentSettings,
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

function fakeDb(row) {
  const calls = [];
  return {
    calls,
    query: async (text, values) => {
      calls.push({ text, values });
      if (/^\s*SELECT/i.test(text)) return { rows: row ? [{ settings: row }] : [] };
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

  it("writes the cleaned settings back for the one agent, and says how much it removed", async function () {
    const db = fakeDb(stored());

    const result = await scrubStoredAgentSettings({
      query: db.query,
      agentId: AGENT_ID,
      allowList: ["LARGE_MODEL"],
    });

    expect(result).to.deep.equal({ found: true, removedSecrets: 2, removedToolEnv: 1 });
    expect(db.calls).to.have.lengthOf(2);
    expect(db.calls[0].values).to.deep.equal([AGENT_ID]);
    expect(db.calls[1].text).to.match(/^\s*UPDATE/i);
    expect(db.calls[1].values[0]).to.equal(AGENT_ID);
    const written = JSON.parse(db.calls[1].values[1]);
    expect(written.secrets).to.deep.equal({ LARGE_MODEL: "kept" });
    expect(JSON.stringify(written)).to.not.include("would-be");
  });

  it("writes nothing when there is nothing to remove", async function () {
    const db = fakeDb({ model: "m", secrets: { LARGE_MODEL: "kept" } });

    const result = await scrubStoredAgentSettings({
      query: db.query,
      agentId: AGENT_ID,
      allowList: ["LARGE_MODEL"],
    });

    expect(result).to.deep.equal({ found: true, removedSecrets: 0, removedToolEnv: 0 });
    expect(db.calls).to.have.lengthOf(1);
  });

  it("writes nothing when the agent has no stored row", async function () {
    const db = fakeDb(null);

    const result = await scrubStoredAgentSettings({
      query: db.query,
      agentId: AGENT_ID,
      allowList: [],
    });

    expect(result).to.deep.equal({ found: false, removedSecrets: 0, removedToolEnv: 0 });
    expect(db.calls).to.have.lengthOf(1);
  });

  it("passes a failed query on to the caller", async function () {
    const failing = async () => {
      throw new Error("connection refused");
    };

    let caught = null;
    try {
      await scrubStoredAgentSettings({ query: failing, agentId: AGENT_ID, allowList: [] });
    } catch (error) {
      caught = error;
    }

    expect(caught).to.be.an("error");
  });
});
