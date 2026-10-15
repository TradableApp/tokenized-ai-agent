const chai = require("chai");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { expect } = chai;

// Guards ROFL_DEPLOYMENT, the override that lets one env's config be pushed to a DIFFERENT
// deployment. It exists for one job: running the Base-Sepolia oracle on a mainnet machine
// (deployment base-mainnet, config base-testnet) so the verification run has no one-hour
// testnet lease and the mainnet deploy path is rehearsed on the real app.
//
// The failure it prevents is quiet: without the override every `--deployment` flag follows
// the ENV argument, so `rofl:set base-testnet` pushes secrets to base-testnet while
// `rofl build --deployment base-mainnet` bundles a compose whose secrets were never set on
// that app. The TEE boots with empty credentials and fails at first use, not at boot.

const REPO_ROOT = path.join(__dirname, "..", "..");
const SET_SECRETS = path.join(REPO_ROOT, "scripts", "rofl-set-secrets.sh");
const INIT_CLOUD_SQL = path.join(REPO_ROOT, "scripts", "rofl-init-cloud-sql.sh");
const MARKER = "# === 📄 ORC BUNDLE CONFIGURATION (PLAINTEXT) ===";

/** A throwaway repo root with env files, a compose template, rofl.yaml and PATH shims. */
function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-rofl-override-"));
  fs.mkdirSync(path.join(dir, "oracle"));
  fs.mkdirSync(path.join(dir, "bin"));
  fs.writeFileSync(
    path.join(dir, "oracle", ".env.oracle"),
    ["SLACK_ACCESS_TOKEN=slack-token", MARKER, "BASE_MAINNET_RPC=https://mainnet.base.org", ""].join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, "oracle", ".env.oracle.base-testnet"),
    [
      "PRIVATE_KEY=0xabc",
      "POSTGRES_CLIENT_CERT=",
      "POSTGRES_PASSWORD=",
      MARKER,
      "NETWORK_NAME=baseSepolia",
      "POSTGRES_AGENT_DATABASE=oracle_agent",
      "POSTGRES_HOST=1.2.3.4",
      "mcp=",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, "compose.base-testnet.yaml"),
    [
      "services:",
      "  oracle:",
      "    image: ghcr.io/tradableapp/tokenized-ai-agent:base-testnet",
      "    environment:",
      "      - STALE=1",
      "    ports:",
      '      - "3000:3000"',
      "",
    ].join("\n"),
  );
  // base-testnet already holds PRIVATE_KEY on-chain (so the control run exercises the rm+set
  // path); base-mainnet is a fresh deployment with no secrets block.
  fs.writeFileSync(
    path.join(dir, "rofl.yaml"),
    [
      "deployments:",
      "  base-testnet:",
      "    app_id: rofl1testnet",
      "    secrets:",
      "      - name: PRIVATE_KEY",
      "        value: enc",
      "  base-mainnet:",
      "    app_id: rofl1mainnet",
      "",
    ].join("\n"),
  );

  const log = path.join(dir, "shim.log");
  const shim = (name, body) => {
    const file = path.join(dir, "bin", name);
    fs.writeFileSync(file, `#!/usr/bin/env bash\necho "${name} $*" >> "${log}"\n${body}\n`);
    fs.chmodSync(file, 0o755);
  };
  shim("oasis", "exit 0");
  shim(
    "gcloud",
    [
      'case "$*" in',
      // Secret Manager reads (password + CA) — any non-empty value will do.
      '  *"secrets versions access"*) echo "sm-value";;',
      // No cert yet, so the script takes the create path.
      '  *"client-certs list"*) ;;',
      // `client-certs create NAME KEYPATH --instance= --project=`: argv is sql ssl client-certs create NAME KEYPATH, so the key path is $6.
      '  *"client-certs create"*) echo "fake-key" > "$6";;',
      '  *"client-certs describe"*) echo "fake-cert";;',
      '  *"instances describe"*) echo \'{"ipAddresses":[{"type":"PRIMARY","ipAddress":"10.9.9.9"}]}\';;',
      "esac",
    ].join("\n"),
  );
  return { dir, log };
}

function run(script, args, { dir, env = {} }) {
  const res = spawnSync("bash", [script, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PATH: `${path.join(dir, "bin")}:${process.env.PATH}`, ...env },
  });
  return { code: res.status, out: `${res.stdout}${res.stderr}` };
}

const readLog = (ws) => (fs.existsSync(ws.log) ? fs.readFileSync(ws.log, "utf8") : "");

describe("ROFL_DEPLOYMENT override", function () {
  this.timeout(20000);

  describe("rofl-set-secrets.sh", function () {
    it("without the override, every --deployment follows ENV (control)", function () {
      const ws = makeWorkspace();
      const { code, out } = run(SET_SECRETS, ["base-testnet"], ws);
      expect(code, out).to.equal(0);
      const log = readLog(ws);
      expect(log).to.include("secret set PRIVATE_KEY --deployment base-testnet");
      expect(log).to.not.include("--deployment base-mainnet");
    });

    it("with ROFL_DEPLOYMENT, secrets go to that deployment while config still comes from ENV", function () {
      const ws = makeWorkspace();
      const { code, out } = run(SET_SECRETS, ["base-testnet"], {
        ...ws,
        env: { ROFL_DEPLOYMENT: "base-mainnet" },
      });
      expect(code, out).to.equal(0);
      const log = readLog(ws);
      expect(log).to.include("secret set PRIVATE_KEY --deployment base-mainnet");
      expect(log).to.not.include("--deployment base-testnet");
      // The compose regenerated is still ENV's — the config source did not move.
      const compose = fs.readFileSync(path.join(ws.dir, "compose.base-testnet.yaml"), "utf8");
      expect(compose).to.include("- NETWORK_NAME=baseSepolia");
      expect(compose).to.include("- PRIVATE_KEY=${PRIVATE_KEY:-}");
      expect(compose).to.not.include("STALE=1");
      // And the operator is told which deployment to commit.
      expect(out).to.include("oasis rofl update --deployment base-mainnet");
    });
  });

  describe("rofl-init-cloud-sql.sh", function () {
    it("with ROFL_DEPLOYMENT, the cert is named for the deployment, pushed to it, on ENV's instance", function () {
      const ws = makeWorkspace();
      const { code, out } = run(INIT_CLOUD_SQL, ["base-testnet"], {
        ...ws,
        env: { ROFL_DEPLOYMENT: "base-mainnet" },
      });
      expect(code, out).to.equal(0);
      const log = readLog(ws);
      // Cert identity follows the DEPLOYMENT: the existing rofl-oracle-base-testnet cert's key
      // was emitted once and is gone, so reusing that name would skip creation and push nothing.
      expect(log).to.match(/client-certs create rofl-oracle-base-mainnet .*--instance=sense-ai-app-garrick --project=tradable-app-garrick/);
      expect(log).to.include("secret set POSTGRES_CLIENT_CERT --deployment base-mainnet");
      expect(log).to.include("secret set POSTGRES_CLIENT_KEY --deployment base-mainnet");
      expect(log).to.not.include("--deployment base-testnet");
      // POSTGRES_HOST is stamped into ENV's env file, which is what rofl:set reads next.
      const envFile = fs.readFileSync(path.join(ws.dir, "oracle", ".env.oracle.base-testnet"), "utf8");
      expect(envFile).to.include("POSTGRES_HOST=10.9.9.9");
    });

    it("without the override, cert name and deployment follow ENV (control)", function () {
      const ws = makeWorkspace();
      const { code, out } = run(INIT_CLOUD_SQL, ["base-testnet"], ws);
      expect(code, out).to.equal(0);
      const log = readLog(ws);
      expect(log).to.include("client-certs create rofl-oracle-base-testnet");
      expect(log).to.include("secret set POSTGRES_CLIENT_CERT --deployment base-testnet");
    });
  });
});
