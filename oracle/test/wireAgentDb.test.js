const { expect } = require("chai");
const proxyquire = require("proxyquire").noCallThru();
const { ethers } = require("ethers");

// Guards the branch that decides whether ElizaOS's plugin-sql talks to the oracle's
// dedicated `oracle_agent` Postgres or silently degrades to PGLite. A regression here
// is invisible: the oracle boots, looks healthy, and quietly discards all agent state
// on every restart (PGLite was retired for exactly that). Round-2 review gap
// (CU-86d3dwme6) — the two early-return paths were previously untested.

const PG_KEYS = [
  "POSTGRES_HOST",
  "POSTGRES_PORT",
  "POSTGRES_DATABASE",
  "POSTGRES_USER",
  "POSTGRES_PASSWORD",
  "POSTGRES_CLIENT_CERT",
  "POSTGRES_CLIENT_KEY",
  "POSTGRES_SERVER_CA_CERT",
  "POSTGRES_AGENT_DATABASE",
  "POSTGRES_URL",
];

function loadWithBootstrapStub(stub) {
  // Stub only postgresBootstrap; everything else the module pulls in is heavy
  // (ethers/ElizaOS/storage) but already exercised by the main suite.
  const mod = proxyquire("../src/aiAgentOracle", { "./postgresBootstrap": stub });
  // Requiring the module runs dotenv.config() against the real ../.env.oracle, which
  // re-populates POSTGRES_* (dotenv fills only unset vars, and beforeEach cleared
  // them). Clear again AFTER load so each test controls the env it exercises.
  for (const k of PG_KEYS) delete process.env[k];
  return mod.wireAgentDbForPluginSql;
}

describe("wireAgentDbForPluginSql (agent-DB isolation guard)", () => {
  const saved = {};
  let savedPrivateKey;

  beforeEach(() => {
    // Module load builds an ethers Wallet at top level, and .env.oracle.example
    // carries a placeholder key — same pattern the main aiAgentOracle suite uses.
    savedPrivateKey = process.env.PRIVATE_KEY;
    process.env.PRIVATE_KEY = ethers.Wallet.createRandom().privateKey;
    for (const k of PG_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    if (savedPrivateKey === undefined) delete process.env.PRIVATE_KEY;
    else process.env.PRIVATE_KEY = savedPrivateKey;
  });

  afterEach(() => {
    for (const k of PG_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("skips (PGLite) when POSTGRES_AGENT_DATABASE is unset — never touches Postgres", () => {
    let called = 0;
    const wire = loadWithBootstrapStub({
      bootstrapPostgresFromEnv: () => {
        called += 1;
      },
      isPostgresConfigured: () => true, // configured, but no agent DB requested
    });

    wire();

    expect(called).to.equal(0);
  });

  it("skips (PGLite) when the agent DB is named but the connection config is absent", () => {
    // The committed .env.oracle.example, localnet and e2e all run in exactly this
    // shape: a DB *name* with no host/credentials. Must degrade quietly, not throw.
    let called = 0;
    const wire = loadWithBootstrapStub({
      bootstrapPostgresFromEnv: () => {
        called += 1;
      },
      isPostgresConfigured: () => false,
    });
    process.env.POSTGRES_AGENT_DATABASE = "oracle_agent";

    expect(() => wire()).to.not.throw();
    expect(called).to.equal(0);
  });

  it("bootstraps with the agent DB name when both the name and the config are present", () => {
    const calls = [];
    const wire = loadWithBootstrapStub({
      bootstrapPostgresFromEnv: (opts) => calls.push(opts),
      isPostgresConfigured: () => true,
    });
    process.env.POSTGRES_AGENT_DATABASE = "oracle_agent";

    wire();

    expect(calls).to.have.lengthOf(1);
    expect(calls[0].database).to.equal("oracle_agent");
  });

  it("propagates a bootstrap failure (configured-but-broken must NOT fall back to PGLite)", () => {
    const wire = loadWithBootstrapStub({
      bootstrapPostgresFromEnv: () => {
        throw new Error("POSTGRES_CLIENT_KEY has world/group permissions 644");
      },
      isPostgresConfigured: () => true,
    });
    process.env.POSTGRES_AGENT_DATABASE = "oracle_agent";

    expect(() => wire()).to.throw(/world\/group permissions/);
  });
});
