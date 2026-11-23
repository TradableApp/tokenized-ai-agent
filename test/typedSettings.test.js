const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const {
  TYPED_SETTINGS,
  SNAPSHOT_VAR,
  captureTypedSettings,
  typedSettings,
  typedOnlyProblems,
} = require("../scripts/lib/typedSettings");

// hardhat.config.js loads the root .env and then ENV_FILE with override, so a line in either file
// replaces what the operator typed. The settings that decide whether a script sends at all are
// read from what was typed alone: the record of it is taken before either file is loaded.
describe("scripts/lib/typedSettings — what was typed, kept from before the env files load", function () {
  it("records each setting the shell holds, and leaves out none", function () {
    const env = { DRY_RUN: "1", OTHER: "x" };
    captureTypedSettings(env, { pid: 10, ppid: 1 });
    const typed = typedSettings(env);
    expect(Object.keys(typed).sort()).to.deep.equal([...TYPED_SETTINGS].sort());
    expect(typed.DRY_RUN).to.equal("1");
    expect(typed.DEPLOY_MAINNET_CONFIRMED).to.equal(undefined);
  });

  it("keeps the record its parent took (the Hardhat CLI that forks a `hardhat run` script)", function () {
    const env = { DRY_RUN: "1" };
    captureTypedSettings(env, { pid: 10, ppid: 1 });
    // The forked script inherits the environment with the files loaded over it.
    const child = { ...env, DRY_RUN: "0" };
    captureTypedSettings(child, { pid: 11, ppid: 10 });
    expect(typedSettings(child).DRY_RUN).to.equal("1");
  });

  it("replaces a record inherited from any other process, and on request", function () {
    const env = { DRY_RUN: "1" };
    captureTypedSettings(env, { pid: 10, ppid: 1 });
    const unrelated = { ...env, DRY_RUN: undefined };
    captureTypedSettings(unrelated, { pid: 99, ppid: 98 });
    expect(typedSettings(unrelated).DRY_RUN).to.equal(undefined);

    const forced = { ...env, DRY_RUN: "" };
    captureTypedSettings(forced, { pid: 10, ppid: 1, fresh: true });
    expect(typedSettings(forced).DRY_RUN).to.equal("");
  });

  it("gives null when there is no record, or the record cannot be read", function () {
    expect(typedSettings({})).to.equal(null);
    expect(typedSettings({ [SNAPSHOT_VAR]: "not json" })).to.equal(null);
  });

  describe("typedOnlyProblems", function () {
    const envFile = ".env.base-testnet";
    const problems = (typed, loaded) =>
      typedOnlyProblems({
        names: ["DRY_RUN", "DEPLOY_MAINNET_CONFIRMED"],
        typedEnv: typed,
        processEnv: loaded,
        envFile,
      });

    it("passes when the files leave each setting as it was typed", function () {
      expect(problems({ DRY_RUN: "1" }, { DRY_RUN: "1" })).to.deep.equal([]);
      expect(problems({}, {})).to.deep.equal([]);
      // An empty line and no line both mean unset.
      expect(problems({}, { DRY_RUN: "" })).to.deep.equal([]);
    });

    it("refuses a typed value that a file replaced, naming the setting and the file", function () {
      for (const loaded of ["0", "", "true"]) {
        const found = problems({ DRY_RUN: "1" }, { DRY_RUN: loaded });
        expect(found, JSON.stringify(loaded)).to.have.lengthOf(1);
        expect(found[0]).to.include("DRY_RUN was typed on the command line").and.include(envFile);
      }
    });

    it("refuses a setting that only a file sets: it can never come from a file", function () {
      const found = problems({}, { DEPLOY_MAINNET_CONFIRMED: "1" });
      expect(found).to.have.lengthOf(1);
      expect(found[0])
        .to.include("DEPLOY_MAINNET_CONFIRMED is set in")
        .and.include(envFile)
        .and.include("the root .env")
        .and.include("typed on the command line");
    });

    it("refuses when there is no record of what was typed", function () {
      const found = problems(null, {});
      expect(found).to.have.lengthOf(1);
      expect(found[0]).to.include(SNAPSHOT_VAR).and.include("package script");
    });
  });
});

// Each script run the way its package script runs it, in a child process, against a settings
// file of its own: deploy.js and admin-rehearsal.js under `hardhat run` (Hardhat forks the script
// with the files already loaded), the hand-over and the listing under node. Every case is refused
// before anything is sent, whatever the outcome; the files leave something out so that even a
// script that let the setting through would stop before it reads the chain.
describe("the typed-only settings, through each script's real loading path", function () {
  this.timeout(120_000);

  const ROOT = path.join(__dirname, "..");
  const HARDHAT = path.join(ROOT, "node_modules", "hardhat", "internal", "cli", "bootstrap.js");
  const TOKEN = "0x4a0C7e5807f9174499a8F56F2C69c61b39a4c64D";

  let dir;
  before(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "typed-settings-"));
  });
  after(function () {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Runs `args` with `fileLines` as ENV_FILE and `typed` as what was typed before it. */
  function run(args, { fileLines, typed, network }) {
    const envFile = path.join(dir, `run-${Math.random().toString(16).slice(2)}.settings`);
    fs.writeFileSync(envFile, [...fileLines, ""].join("\n"));
    const env = { ...process.env };
    // This test process holds a record of its own; a child must start from a shell's state.
    delete env[SNAPSHOT_VAR];
    for (const name of [...TYPED_SETTINGS, "ENV_FILE", "HARDHAT_NETWORK"]) delete env[name];
    const result = spawnSync(process.execPath, args, {
      cwd: ROOT,
      env: {
        ...env,
        ...typed,
        ENV_FILE: envFile,
        ...(network ? { HARDHAT_NETWORK: network } : {}),
      },
      encoding: "utf8",
    });
    return { envFile, status: result.status, out: `${result.stdout}\n${result.stderr}` };
  }

  const deploy = (network, opts) =>
    run([HARDHAT, "run", "scripts/deploy.js", "--network", network], opts);

  it("deploy: a typed DRY_RUN=1 that ENV_FILE replaces stops the script before anything is sent", function () {
    for (const line of ["DRY_RUN=0", "DRY_RUN="]) {
      const { envFile, status, out } = deploy("hardhat", {
        fileLines: ["DEPLOY_MODE=fresh", `TOKEN_CONTRACT_ADDRESS=${TOKEN}`, line],
        typed: { DRY_RUN: "1" },
      });
      expect(status, line).to.equal(1);
      expect(out, line).to.include("DRY_RUN was typed on the command line").and.include(envFile);
      expect(out, line).to.not.include("Deploying EVMAIAgent proxy");
    }
  });

  it("deploy: a typed DRY_RUN=1 reaches the script through Hardhat's fork when no file sets it", function () {
    const { out } = deploy("hardhat", {
      fileLines: ["DEPLOY_MODE=fresh", `TOKEN_CONTRACT_ADDRESS=${TOKEN}`],
      typed: { DRY_RUN: "1" },
    });
    expect(out).to.not.include("DRY_RUN was typed on the command line");
    expect(out).to.include("--- Starting deployment to");
  });

  it("deploy: the mainnet confirmation in ENV_FILE is refused, never taken", function () {
    const { envFile, status, out } = deploy("base", {
      // No fees: the plan is refused on base whatever happens to the confirmation.
      fileLines: ["DEPLOY_MODE=fresh", "DEPLOY_MAINNET_CONFIRMED=1"],
      typed: {},
    });
    expect(status).to.equal(1);
    expect(out).to.include("DEPLOY_MAINNET_CONFIRMED is set in").and.include(envFile);
  });

  it("authorize-oracle: the mainnet confirmation in ENV_FILE is refused, never taken", function () {
    const { envFile, status, out } = run(["scripts/authorize-oracle.js", "grant"], {
      fileLines: ["DEPLOY_MAINNET_CONFIRMED=1"],
      typed: {},
      network: "base",
    });
    expect(status).to.equal(1);
    expect(out).to.include("DEPLOY_MAINNET_CONFIRMED is set in").and.include(envFile);
  });

  it("list-fee-token-exempt: the mainnet confirmation in ENV_FILE is refused, never taken", function () {
    const { envFile, status, out } = run(["scripts/list-fee-token-exempt.js"], {
      fileLines: ["DEPLOY_MAINNET_CONFIRMED=1"],
      typed: {},
      network: "base",
    });
    expect(status).to.equal(1);
    expect(out).to.include("DEPLOY_MAINNET_CONFIRMED is set in").and.include(envFile);
  });

  it("admin-rehearsal: a typed DRY_RUN=1 that ENV_FILE replaces stops the script before anything is sent", function () {
    const { envFile, status, out } = run(
      [HARDHAT, "run", "scripts/admin-rehearsal.js", "--network", "hardhat"],
      {
        // Empty pair lines: even a run that let DRY_RUN through stops at the missing pair.
        fileLines: ["AI_AGENT_CONTRACT_ADDRESS=", "AI_AGENT_ESCROW_CONTRACT_ADDRESS=", "DRY_RUN=0"],
        typed: { DRY_RUN: "1" },
      },
    );
    expect(status).to.equal(1);
    expect(out).to.include("DRY_RUN was typed on the command line").and.include(envFile);
  });

  it("admin-rehearsal: the rehearsal's mainnet confirmation in ENV_FILE is refused, never taken", function () {
    const { envFile, status, out } = run(
      [HARDHAT, "run", "scripts/admin-rehearsal.js", "--network", "hardhat"],
      {
        fileLines: [
          "AI_AGENT_CONTRACT_ADDRESS=",
          "AI_AGENT_ESCROW_CONTRACT_ADDRESS=",
          "REHEARSAL_MAINNET_CONFIRMED=1",
        ],
        typed: {},
      },
    );
    expect(status).to.equal(1);
    expect(out).to.include("REHEARSAL_MAINNET_CONFIRMED is set in").and.include(envFile);
  });
});
