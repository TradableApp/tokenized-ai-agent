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
// Documentation addresses (RFC 5737): the one in the env file, and the one gcloud reports.
const ENV_ADDRESS = "203.0.113.10";
const GCLOUD_ADDRESS = "203.0.113.9";

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
      `POSTGRES_HOST=${ENV_ADDRESS}`,
      MARKER,
      "NETWORK_NAME=baseSepolia",
      "POSTGRES_AGENT_DATABASE=oracle_agent",
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
      `  *"instances describe"*) echo '{"ipAddresses":[{"type":"PRIMARY","ipAddress":"${GCLOUD_ADDRESS}"}]}';;`,
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
  let ws;
  beforeEach(function () {
    ws = makeWorkspace();
  });
  afterEach(function () {
    fs.rmSync(ws.dir, { recursive: true, force: true });
  });

  describe("rofl-set-secrets.sh", function () {
    it("without the override, every --deployment follows ENV (control)", function () {
      const { code, out } = run(SET_SECRETS, ["base-testnet"], ws);
      expect(code, out).to.equal(0);
      const log = readLog(ws);
      expect(log).to.include("secret set PRIVATE_KEY --deployment base-testnet");
      expect(log).to.not.include("--deployment base-mainnet");
    });

    it("with ROFL_DEPLOYMENT, secrets go to that deployment while config still comes from ENV", function () {
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
      expect(out).to.include("oasis rofl update --deployment base-mainnet --account oasis_mainnet");
    });

    it("refuses a deployment that is not in rofl.yaml before rewriting anything", function () {
      const { code, out } = run(SET_SECRETS, ["base-testnet"], {
        ...ws,
        env: { ROFL_DEPLOYMENT: "base-mainnnet" },
      });
      expect(code, out).to.not.equal(0);
      expect(out).to.include("base-mainnnet");
      expect(out).to.include("rofl.yaml");
      expect(readLog(ws)).to.not.include("secret set");
      // The compose template is untouched: the guard runs before the rewrite.
      const compose = fs.readFileSync(path.join(ws.dir, "compose.base-testnet.yaml"), "utf8");
      expect(compose).to.include("STALE=1");
    });
  });

  describe("POSTGRES_HOST is a secret", function () {
    const envFilePath = () => path.join(ws.dir, "oracle", ".env.oracle.base-testnet");
    const writeEnvFile = (lines) => fs.writeFileSync(envFilePath(), [...lines, ""].join("\n"));
    const readCompose = () => fs.readFileSync(path.join(ws.dir, "compose.base-testnet.yaml"), "utf8");

    describe("rofl-set-secrets.sh", function () {
      it("pushes the address on-chain and injects it, never writing it into the compose", function () {
        const { code, out } = run(SET_SECRETS, ["base-testnet"], ws);
        expect(code, out).to.equal(0);
        expect(readLog(ws)).to.include("secret set POSTGRES_HOST --deployment base-testnet");
        const compose = readCompose();
        expect(compose).to.include("- POSTGRES_HOST=${POSTGRES_HOST:-}");
        expect(compose).to.not.include(ENV_ADDRESS);
        expect(out).to.not.include(ENV_ADDRESS);
      });

      it("refuses an address below the delimiter before writing or pushing anything", function () {
        writeEnvFile([
          "PRIVATE_KEY=0xabc",
          MARKER,
          "NETWORK_NAME=baseSepolia",
          "POSTGRES_AGENT_DATABASE=oracle_agent",
          `POSTGRES_HOST=${ENV_ADDRESS}`,
          "mcp=",
        ]);
        const { code, out } = run(SET_SECRETS, ["base-testnet"], ws);
        expect(code, out).to.not.equal(0);
        expect(out).to.include("POSTGRES_HOST");
        expect(out).to.include("ABOVE the delimiter");
        expect(out).to.not.include(ENV_ADDRESS);
        expect(readLog(ws)).to.not.include("secret set");
        expect(readCompose()).to.include("STALE=1");
        expect(readCompose()).to.not.include(ENV_ADDRESS);
      });

      it("refuses a host name below the delimiter as it refuses an address", function () {
        writeEnvFile([
          "PRIVATE_KEY=0xabc",
          MARKER,
          "NETWORK_NAME=baseSepolia",
          "POSTGRES_HOST=db.example.com",
          "mcp=",
        ]);
        const { code, out } = run(SET_SECRETS, ["base-testnet"], ws);
        expect(code, out).to.not.equal(0);
        // Refused for being below the delimiter, as an address is, not only for a missing host.
        expect(out).to.include("POSTGRES_HOST is set below the delimiter");
        expect(out).to.not.include("db.example.com");
        expect(readLog(ws)).to.not.include("secret set");
        expect(readCompose()).to.not.include("db.example.com");
      });

      it("refuses a setting below the delimiter whose value holds the address, naming only the setting", function () {
        writeEnvFile([
          "PRIVATE_KEY=0xabc",
          `POSTGRES_HOST=${ENV_ADDRESS}`,
          MARKER,
          "NETWORK_NAME=baseSepolia",
          `DB_PROXY_TARGET=${ENV_ADDRESS}:5432`,
          "mcp=",
        ]);
        const { code, out } = run(SET_SECRETS, ["base-testnet"], ws);
        expect(code, out).to.not.equal(0);
        expect(out).to.include("DB_PROXY_TARGET");
        expect(out).to.not.include(ENV_ADDRESS);
        expect(readLog(ws)).to.not.include("secret set");
        expect(readCompose()).to.not.include(ENV_ADDRESS);
      });

      // The placeholder and quote rules name the setting and describe its value by its length:
      // a value is never printed, whatever it holds.
      it("refuses a quoted value holding the address, naming the host first and printing neither", function () {
        writeEnvFile([
          "PRIVATE_KEY=0xabc",
          `POSTGRES_HOST=${ENV_ADDRESS}`,
          MARKER,
          "NETWORK_NAME=baseSepolia",
          `DB_NOTE="${ENV_ADDRESS}"`,
          "mcp=",
        ]);
        const { code, out } = run(SET_SECRETS, ["base-testnet"], ws);
        expect(code, out).to.not.equal(0);
        expect(out).to.not.include(ENV_ADDRESS);
        const host = out.indexOf("DB_NOTE below the delimiter holds the POSTGRES_HOST value");
        const quoted = out.indexOf("quoted —");
        expect(host, out).to.be.greaterThan(-1);
        expect(quoted, out).to.be.greaterThan(host);
        expect(readLog(ws)).to.not.include("secret set");
      });

      it("never prints a quoted, placeholder or mcp value, only its length", function () {
        writeEnvFile([
          "PRIVATE_KEY=0xabc",
          `POSTGRES_HOST=${ENV_ADDRESS}`,
          MARKER,
          "NETWORK_NAME=baseSepolia",
          'API_TOKEN="tok-not-a-real-one"',
          "SLACK_SECRET=your_slack_secret_here",
          "mcp=db.example.org",
        ]);
        const { code, out } = run(SET_SECRETS, ["base-testnet"], ws);
        expect(code, out).to.not.equal(0);
        expect(out).to.not.include("tok-not-a-real-one");
        expect(out).to.not.include("your_slack_secret_here");
        expect(out).to.not.include("db.example.org");
        expect(out).to.include("API_TOKEN (value not shown, 20 characters)");
        expect(out).to.include("SLACK_SECRET (value not shown, 22 characters)");
        expect(out).to.include("mcp (value not shown, 14 characters)");
      });

      it("refuses a database address below the delimiter, without printing it", function () {
        writeEnvFile([
          "PRIVATE_KEY=0xabc",
          `POSTGRES_HOST=${ENV_ADDRESS}`,
          MARKER,
          "NETWORK_NAME=baseSepolia",
          "POSTGRES_URL=postgres://oracle@198.51.100.20:5432/oracle_agent",
          "mcp=",
        ]);
        const { code, out } = run(SET_SECRETS, ["base-testnet"], ws);
        expect(code, out).to.not.equal(0);
        expect(out).to.include("POSTGRES_URL");
        expect(out).to.not.include("198.51.100.20");
        expect(readCompose()).to.not.include("198.51.100.20");
      });

      it("names a malformed key by its line number, never by its text", function () {
        // A wrapped value's continuation line (base64 padding holds "=") reads as a key.
        writeEnvFile([
          "PRIVATE_KEY=0xabc",
          `POSTGRES_HOST=${ENV_ADDRESS}`,
          "c2VjcmV0S2V5TGluZVR3bw==",
          MARKER,
          "NETWORK_NAME=baseSepolia",
          "mcp=",
        ]);
        const { code, out } = run(SET_SECRETS, ["base-testnet"], ws);
        expect(code, out).to.not.equal(0);
        expect(out).to.include("upper-case");
        expect(out).to.match(/line 3 of .* \(above the delimiter\)/);
        // Nothing above the delimiter reaches the compose, so the reason given is not the compose.
        expect(out).to.not.include("compose would pass it on");
        expect(out).to.not.include("c2VjcmV0S2V5TGluZVR3bw");
        expect(readLog(ws)).to.not.include("secret set");
      });

      for (const line of [`export POSTGRES_HOST=${ENV_ADDRESS}`, `postgres_host=${ENV_ADDRESS}`]) {
        it(`refuses a key that is not upper-case snake case (${line.split("=")[0]})`, function () {
          writeEnvFile([
            "PRIVATE_KEY=0xabc",
            `POSTGRES_HOST=${ENV_ADDRESS}`,
            MARKER,
            "NETWORK_NAME=baseSepolia",
            line,
            "mcp=",
          ]);
          const { code, out } = run(SET_SECRETS, ["base-testnet"], ws);
          expect(code, out).to.not.equal(0);
          expect(out).to.include("upper-case");
          expect(out).to.match(/line 5 of .* \(below the delimiter\)/);
          expect(out).to.include("compose would pass it on");
          expect(out).to.not.include(ENV_ADDRESS);
          expect(readLog(ws)).to.not.include("secret set");
          expect(readCompose()).to.not.include(ENV_ADDRESS);
        });
      }

      it("refuses database settings with no POSTGRES_HOST above the delimiter", function () {
        writeEnvFile([
          "PRIVATE_KEY=0xabc",
          MARKER,
          "NETWORK_NAME=baseSepolia",
          "POSTGRES_AGENT_DATABASE=oracle_agent",
          "mcp=",
        ]);
        const { code, out } = run(SET_SECRETS, ["base-testnet"], ws);
        expect(code, out).to.not.equal(0);
        expect(out).to.include("POSTGRES_HOST");
        expect(out).to.include("ABOVE the delimiter");
        expect(readLog(ws)).to.not.include("secret set");
        expect(readCompose()).to.include("STALE=1");
      });

      it("accepts a blank POSTGRES_HOST below the delimiter, which writes nothing", function () {
        writeEnvFile([
          "PRIVATE_KEY=0xabc",
          `POSTGRES_HOST=${ENV_ADDRESS}`,
          MARKER,
          "NETWORK_NAME=baseSepolia",
          "POSTGRES_AGENT_DATABASE=oracle_agent",
          "POSTGRES_HOST=",
          "mcp=",
        ]);
        const { code, out } = run(SET_SECRETS, ["base-testnet"], ws);
        expect(code, out).to.equal(0);
        // Injected from the secret above; no literal line of its own.
        expect(readCompose()).to.include("- POSTGRES_HOST=${POSTGRES_HOST:-}");
        expect(readCompose()).to.not.match(/- POSTGRES_HOST=(?!\$\{POSTGRES_HOST:-\})/);
      });
    });

    describe("rofl-init-cloud-sql.sh", function () {
      it("stamps the address without printing it", function () {
        const { code, out } = run(INIT_CLOUD_SQL, ["base-testnet"], ws);
        expect(code, out).to.equal(0);
        expect(fs.readFileSync(envFilePath(), "utf8")).to.include(
          `POSTGRES_HOST=${GCLOUD_ADDRESS}`,
        );
        expect(out).to.include("Stamped POSTGRES_HOST");
        expect(out).to.not.include(GCLOUD_ADDRESS);
        expect(out).to.not.include("below the delimiter");
      });

      it("does not stamp a line below the delimiter, and says where it belongs", function () {
        writeEnvFile([
          "PRIVATE_KEY=0xabc",
          MARKER,
          "NETWORK_NAME=baseSepolia",
          `POSTGRES_HOST=${ENV_ADDRESS}`,
        ]);
        const { code, out } = run(INIT_CLOUD_SQL, ["base-testnet"], ws);
        expect(code, out).to.equal(0);
        expect(out).to.include("below the delimiter");
        expect(out).to.include("gcloud sql instances describe");
        expect(out).to.not.include(GCLOUD_ADDRESS);
        expect(out).to.not.include(ENV_ADDRESS);
        expect(fs.readFileSync(envFilePath(), "utf8")).to.not.include(GCLOUD_ADDRESS);
      });

      it("stamps only the line above the delimiter, leaving a blank one below as it is", function () {
        writeEnvFile([
          "PRIVATE_KEY=0xabc",
          `POSTGRES_HOST=${ENV_ADDRESS}`,
          MARKER,
          "NETWORK_NAME=baseSepolia",
          "POSTGRES_HOST=",
        ]);
        const { code, out } = run(INIT_CLOUD_SQL, ["base-testnet"], ws);
        expect(code, out).to.equal(0);
        const [above, below] = fs.readFileSync(envFilePath(), "utf8").split(MARKER);
        expect(above).to.include(`POSTGRES_HOST=${GCLOUD_ADDRESS}`);
        expect(below).to.match(/^POSTGRES_HOST=$/m);
        expect(below).to.not.include(GCLOUD_ADDRESS);
        expect(out).to.not.include(GCLOUD_ADDRESS);
      });

      it("points to gcloud, not the address, when the env file has no POSTGRES_HOST line", function () {
        writeEnvFile(["PRIVATE_KEY=0xabc", MARKER, "NETWORK_NAME=baseSepolia"]);
        const { code, out } = run(INIT_CLOUD_SQL, ["base-testnet"], ws);
        expect(code, out).to.equal(0);
        expect(out).to.include("gcloud sql instances describe");
        expect(out).to.not.include(GCLOUD_ADDRESS);
      });

      it("points to gcloud, not the address, when the env file is missing", function () {
        fs.rmSync(envFilePath());
        const { code, out } = run(INIT_CLOUD_SQL, ["base-testnet"], ws);
        expect(code, out).to.equal(0);
        expect(out).to.include("gcloud sql instances describe");
        expect(out).to.not.include(GCLOUD_ADDRESS);
      });
    });
  });

  describe("rofl-init-cloud-sql.sh", function () {
    it("with ROFL_DEPLOYMENT, the cert is named for the deployment, pushed to it, on ENV's instance", function () {
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
      expect(envFile).to.include(`POSTGRES_HOST=${GCLOUD_ADDRESS}`);
      // The next-steps hint names the deployment's signing account: the CLI default on an
      // operator machine is the testnet account, which is wrong for base-mainnet.
      expect(out).to.include("oasis rofl update --deployment base-mainnet --account oasis_mainnet");
    });

    it("matches the manifest key literally, so a metacharacter typo cannot pass as a real deployment", function () {
      // Under a regex match `base.mainnet` would satisfy `base-mainnet`; the guard must treat
      // the name as literal bytes or this exact typo class walks straight through it.
      const { code, out } = run(INIT_CLOUD_SQL, ["base-testnet"], {
        ...ws,
        env: { ROFL_DEPLOYMENT: "base.mainnet" },
      });
      expect(code, out).to.not.equal(0);
      expect(readLog(ws)).to.not.include("client-certs create");
    });

    it("refuses a deployment that is not in rofl.yaml before minting a cert", function () {
      const { code, out } = run(INIT_CLOUD_SQL, ["base-testnet"], {
        ...ws,
        env: { ROFL_DEPLOYMENT: "base-mainnnet" },
      });
      expect(code, out).to.not.equal(0);
      expect(out).to.include("base-mainnnet");
      expect(out).to.include("rofl.yaml");
      // A cert's private key is emitted exactly once and the slot is consumed on creation,
      // so a typo must fail before gcloud is ever called.
      expect(readLog(ws)).to.not.include("client-certs create");
    });

    it("without the override, cert name and deployment follow ENV (control)", function () {
      const { code, out } = run(INIT_CLOUD_SQL, ["base-testnet"], ws);
      expect(code, out).to.equal(0);
      const log = readLog(ws);
      expect(log).to.include("client-certs create rofl-oracle-base-testnet");
      expect(log).to.include("secret set POSTGRES_CLIENT_CERT --deployment base-testnet");
      expect(out).to.include("oasis rofl update --deployment base-testnet --account oasis_testnet");
    });
  });
});
