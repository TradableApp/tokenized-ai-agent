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
  // Stub postgresBootstrap (the unit under test) plus the two ElizaOS modules the
  // main aiAgentOracle suite also stubs. The plugin `dist/` is BUILD OUTPUT — built
  // in the Dockerfile builder stage and gitignored — so it exists locally but NOT in
  // CI. Without these keys, proxyquire (noCallThru) resolves the real path and the
  // require fails with `Cannot find module …/plugin-senseai/dist/index.js` on CI only.
  const mod = proxyquire("../src/aiAgentOracle", {
    "./postgresBootstrap": stub,
    "./elizaos/plugins/plugin-senseai/dist/index.js": { default: {} },
    "./elizaos/character.js": {},
  });
  // Requiring the module runs dotenv.config() against the real ../.env.oracle, which
  // re-populates POSTGRES_* (dotenv fills only unset vars, and beforeEach cleared
  // them). Clear again AFTER load so each test controls the env it exercises.
  for (const k of PG_KEYS) delete process.env[k];
  return mod.wireAgentDbForPluginSql;
}

/** Runs `fn` with console.error captured, and returns what it wrote. */
function captureConsoleError(fn) {
  const written = [];
  const original = console.error;
  console.error = (...args) => written.push(args.join(" "));
  try {
    fn();
  } finally {
    console.error = original;
  }
  return written;
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

    expect(wire()).to.equal(null); // null ⇒ caller skips the migration too

    expect(called).to.equal(0);
  });

  // The POSTGRES_URL-only shape is one validateConfig DELIBERATELY allows, and initializeEliza
  // implements it a few lines below this call (legacy warning, then migration against that url).
  // This function runs before that branch, so an unconditional error here announced that the
  // process "should have been stopped by validateConfig" about a configuration validateConfig
  // had just approved — a red log contradicting the warning printed immediately after it.
  it("stays quiet on the POSTGRES_URL-only path validateConfig allows", () => {
    const wire = loadWithBootstrapStub({
      bootstrapPostgresFromEnv: () => {
        throw new Error("bootstrap must not run on the legacy path");
      },
      isPostgresConfigured: () => true,
    });
    process.env.POSTGRES_URL = "postgresql://u:p@db.internal:5432/oracle_agent";

    const errors = captureConsoleError(() => {
      expect(wire()).to.equal(null); // still null — initializeEliza migrates against the url
    });

    expect(errors).to.deep.equal([]);
  });

  // The complement, so the quiet above cannot be achieved by silencing the branch outright:
  // with no url either, this IS the unguarded start the message describes.
  it("still reports the PGLite fall-through when neither the agent DB nor a url is named", () => {
    const wire = loadWithBootstrapStub({
      bootstrapPostgresFromEnv: () => {},
      isPostgresConfigured: () => true,
    });

    const errors = captureConsoleError(() => {
      expect(wire()).to.equal(null);
    });

    expect(errors.join("\n")).to.match(/PGLite/);
  });

  it("reports, rather than absorbs, a named agent DB with no connection config", () => {
    // The committed .env.oracle.example carries exactly this shape: a DB *name* with no
    // host/credentials. It must not throw — this runs inside initializeEliza, which the
    // prompt path re-enters behind the ElizaOS→ChainGPT failover, so a throw is caught and
    // silently downgrades every answer. But "does not throw" is not "says nothing": the
    // configuration cannot work, and before this PR the log read like a supported
    // degradation. Asserting the error is what keeps the return-null quiet from drifting
    // back into being quiet all the way down.
    let called = 0;
    const wire = loadWithBootstrapStub({
      bootstrapPostgresFromEnv: () => {
        called += 1;
      },
      isPostgresConfigured: () => false,
    });
    process.env.POSTGRES_AGENT_DATABASE = "oracle_agent";

    const errors = captureConsoleError(() => {
      expect(wire()).to.equal(null);
    });

    expect(called).to.equal(0);
    expect(errors.join("\n")).to.match(/CANNOT work/);
  });

  it("bootstraps with the agent DB name when both the name and the config are present", () => {
    const calls = [];
    const wire = loadWithBootstrapStub({
      bootstrapPostgresFromEnv: (opts) => {
        calls.push(opts);
        return "postgresql://u:p@h:5432/oracle_agent?sslmode=verify-ca";
      },
      isPostgresConfigured: () => true,
    });
    process.env.POSTGRES_AGENT_DATABASE = "oracle_agent";

    const returned = wire();

    expect(calls).to.have.lengthOf(1);
    expect(calls[0].database).to.equal("oracle_agent");
    // Returned so initializeEliza can hand it to runServerLevelMigrations directly
    // instead of reading process.env.POSTGRES_URL back out.
    expect(returned).to.equal("postgresql://u:p@h:5432/oracle_agent?sslmode=verify-ca");
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
