const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const {
  deployProblems,
  assertDeployAllowed,
  resolveDeployPlan,
  CONFIRM_VAR,
  FILE_ONLY_VARS,
} = require("../scripts/deploy");
const hardhatConfig = require("../hardhat.config");

const ADDRESS = "0x4a0C7e5807f9174499a8F56F2C69c61b39a4c64D";
const OTHER = "0x36ec08471F2b995024967204D7542713cFaf5Fa4";
// An upgrade of both proxies on Base mainnet, with everything the guard asks for.
const resolved = {
  DEPLOY_MODE: "upgrade",
  TOKEN_CONTRACT_ADDRESS: ADDRESS,
  AI_AGENT_CONTRACT_ADDRESS: ADDRESS,
  AI_AGENT_ESCROW_CONTRACT_ADDRESS: ADDRESS,
  TREASURY_ADDRESS: ADDRESS,
  [CONFIRM_VAR]: "1",
};
// A fresh pair on Base mainnet, with everything the guard asks for.
const freshOnBase = {
  DEPLOY_MODE: "fresh",
  TOKEN_CONTRACT_ADDRESS: ADDRESS,
  TREASURY_ADDRESS: ADDRESS,
  EXPECTED_FEE_TOKEN_SYMBOL: "SENSE",
  [CONFIRM_VAR]: "1",
};

describe("scripts/deploy — Base mainnet guard", function () {
  it("is a no-op off Base mainnet for the mainnet-only rules, even with no confirm", function () {
    for (const networkName of ["baseSepolia", "localnet", "hardhat", "sapphire-testnet"]) {
      expect(
        deployProblems({
          networkName,
          env: {
            DEPLOY_MODE: "upgrade",
            AI_AGENT_CONTRACT_ADDRESS: ADDRESS,
            AI_AGENT_ESCROW_CONTRACT_ADDRESS: ADDRESS,
          },
        }),
        networkName,
      ).to.deep.equal([]);
    }
  });

  it("passes on base with real addresses and the confirm", function () {
    expect(deployProblems({ networkName: "base", env: resolved })).to.deep.equal([]);
    expect(deployProblems({ networkName: "base", env: freshOnBase })).to.deep.equal([]);
    expect(() => assertDeployAllowed({ networkName: "base", env: resolved })).to.not.throw();
  });

  it("refuses placeholder or malformed addresses on base, naming each variable and never its value", function () {
    const problems = deployProblems({
      networkName: "base",
      env: {
        ...resolved,
        TOKEN_CONTRACT_ADDRESS: "0xYOUR_MAINNET_TOKEN_ADDRESS",
        TREASURY_ADDRESS: "0x1234",
      },
    });
    expect(problems.some((p) => p.includes("TOKEN_CONTRACT_ADDRESS"))).to.equal(true);
    expect(problems.some((p) => p.includes("TREASURY_ADDRESS"))).to.equal(true);
    expect(problems.some((p) => p.includes("AI_AGENT_CONTRACT_ADDRESS"))).to.equal(false);
    const text = problems.join("\n");
    expect(text).to.not.include("YOUR_MAINNET");
    expect(text).to.not.include("0x1234");
  });

  it("requires TOKEN_CONTRACT_ADDRESS for a fresh pair", function () {
    for (const networkName of ["base", "baseSepolia", "localnet"]) {
      const env = { ...freshOnBase };
      delete env.TOKEN_CONTRACT_ADDRESS;
      const problems = deployProblems({ networkName, env });
      expect(problems, networkName).to.have.lengthOf(1);
      expect(problems[0]).to.include("TOKEN_CONTRACT_ADDRESS");
    }
  });

  it("does not require TREASURY_ADDRESS on base for an upgrade of both proxies", function () {
    const env = { ...resolved };
    delete env.TREASURY_ADDRESS;
    expect(deployProblems({ networkName: "base", env })).to.deep.equal([]);
  });

  it("does not require TOKEN_CONTRACT_ADDRESS on base for an upgrade of both proxies", function () {
    const env = { ...resolved };
    delete env.TOKEN_CONTRACT_ADDRESS;
    expect(deployProblems({ networkName: "base", env })).to.deep.equal([]);
  });

  it(`refuses base unless ${CONFIRM_VAR} is exactly "1", without repeating what it was`, function () {
    for (const value of [undefined, "", "true", "yes", " 1"]) {
      const problems = deployProblems({
        networkName: "base",
        env: { ...resolved, [CONFIRM_VAR]: value },
      });
      expect(problems, JSON.stringify(value)).to.have.lengthOf(1);
      expect(problems[0]).to.include(`${CONFIRM_VAR}=1`);
      if (value) expect(problems[0]).to.not.include(JSON.stringify(value));
    }
  });

  it("assertDeployAllowed throws one error listing every problem", function () {
    expect(() =>
      assertDeployAllowed({
        networkName: "base",
        env: { DEPLOY_MODE: "fresh", TOKEN_CONTRACT_ADDRESS: "0xYOUR_MAINNET_TOKEN_ADDRESS" },
      }),
    )
      .to.throw(Error)
      .with.property("message")
      .that.includes("TOKEN_CONTRACT_ADDRESS")
      .and.includes(`${CONFIRM_VAR}=1`)
      .and.includes("base");
  });
});

describe("scripts/deploy — DEPLOY_MODE says whether a new pair is deployed", function () {
  const EVM_NETWORKS = ["base", "baseSepolia", "localnet", "hardhat"];

  it("is required on every EVM network, and must be exactly fresh or upgrade", function () {
    for (const networkName of EVM_NETWORKS) {
      for (const mode of [undefined, "", "Fresh", "fresh ", "new", "upgrades"]) {
        const env = { ...resolved, DEPLOY_MODE: mode };
        const problems = deployProblems({ networkName, env });
        const modeProblems = problems.filter((p) => p.includes("DEPLOY_MODE"));
        expect(modeProblems, `${networkName} ${JSON.stringify(mode)}`).to.have.lengthOf(1);
        expect(modeProblems[0]).to.include("fresh").and.include("upgrade");
        // A misspelt value is described by its shape, never repeated.
        if (mode && mode.trim() !== "") {
          expect(modeProblems[0]).to.not.include(JSON.stringify(mode));
        }
      }
    }
  });

  it("is not asked for on the Sapphire networks, whose path is unchanged", function () {
    for (const networkName of ["sapphire", "sapphire-testnet", "sapphire-localnet"]) {
      expect(deployProblems({ networkName, env: {} }), networkName).to.deep.equal([]);
    }
  });

  it("fresh refuses when either pair address is set", function () {
    for (const networkName of EVM_NETWORKS) {
      for (const name of ["AI_AGENT_CONTRACT_ADDRESS", "AI_AGENT_ESCROW_CONTRACT_ADDRESS"]) {
        const problems = deployProblems({
          networkName,
          env: { ...freshOnBase, [name]: ADDRESS },
        });
        expect(problems, `${networkName} ${name}`).to.have.lengthOf(1);
        expect(problems[0]).to.include(name).and.include("DEPLOY_MODE=upgrade");
      }
    }
  });

  it("upgrade refuses unless both pair addresses are set", function () {
    for (const networkName of EVM_NETWORKS) {
      for (const missing of ["AI_AGENT_CONTRACT_ADDRESS", "AI_AGENT_ESCROW_CONTRACT_ADDRESS"]) {
        const env = { ...resolved };
        delete env[missing];
        const problems = deployProblems({ networkName, env });
        expect(problems, `${networkName} ${missing}`).to.have.lengthOf(1);
        expect(problems[0]).to.include(missing).and.include("DEPLOY_MODE=fresh");
      }
    }
  });

  it("fresh on a live network needs TREASURY_ADDRESS and EXPECTED_FEE_TOKEN_SYMBOL", function () {
    for (const networkName of ["base", "baseSepolia"]) {
      for (const missing of ["TREASURY_ADDRESS", "EXPECTED_FEE_TOKEN_SYMBOL"]) {
        const env = { ...freshOnBase };
        delete env[missing];
        const problems = deployProblems({ networkName, env });
        expect(problems, `${networkName} ${missing}`).to.have.lengthOf(1);
        expect(problems[0]).to.include(missing);
      }
    }
  });

  it("fresh on a local network falls back to the deploy wallet as treasury and skips the symbol", function () {
    for (const networkName of ["hardhat", "localnet", "localhost"]) {
      expect(
        deployProblems({
          networkName,
          env: { DEPLOY_MODE: "fresh", TOKEN_CONTRACT_ADDRESS: ADDRESS },
        }),
        networkName,
      ).to.deep.equal([]);
    }
  });

  it("ORACLE_ADDRESS, when set, must be an address, described by shape only", function () {
    const problems = deployProblems({
      networkName: "baseSepolia",
      env: { ...freshOnBase, ORACLE_ADDRESS: "0xnot-an-address" },
    });
    expect(problems).to.have.lengthOf(1);
    expect(problems[0]).to.include("ORACLE_ADDRESS").and.not.include("0xnot-an-address");
    expect(
      deployProblems({
        networkName: "baseSepolia",
        env: { ...freshOnBase, ORACLE_ADDRESS: OTHER },
      }),
    ).to.deep.equal([]);
  });
});

describe("scripts/deploy — the mode and the pair are read from ENV_FILE alone", function () {
  const envFile = ".env.base-testnet";
  const freshFile = {
    DEPLOY_MODE: "fresh",
    TOKEN_CONTRACT_ADDRESS: ADDRESS,
    TREASURY_ADDRESS: ADDRESS,
    EXPECTED_FEE_TOKEN_SYMBOL: "SENSE",
  };
  // Hardhat's config has already loaded the root .env and then ENV_FILE over it, so whatever
  // ENV_FILE sets is in the process environment too.
  const plan = (fileEnv, extra = {}) =>
    resolveDeployPlan({
      networkName: "baseSepolia",
      envFile,
      fileEnv,
      processEnv: { ...fileEnv, ...extra },
    });

  it("names the three settings it reads from the file alone", function () {
    expect([...FILE_ONLY_VARS].sort()).to.deep.equal(
      ["AI_AGENT_CONTRACT_ADDRESS", "AI_AGENT_ESCROW_CONTRACT_ADDRESS", "DEPLOY_MODE"].sort(),
    );
  });

  it("gives the plan of a fresh pair from the file", function () {
    const p = plan(freshFile);
    expect(p.mode).to.equal("fresh");
    expect(p.token).to.equal(ADDRESS);
    expect(p.treasury).to.equal(ADDRESS);
    expect(p.oracle).to.equal(null);
    expect(p.expectedSymbol).to.equal("SENSE");
    expect(p.live).to.equal(true);
  });

  it("refuses a pair address set only in the root .env or the shell, without printing it", function () {
    for (const name of ["AI_AGENT_CONTRACT_ADDRESS", "AI_AGENT_ESCROW_CONTRACT_ADDRESS"]) {
      expect(() => plan(freshFile, { [name]: OTHER }), name)
        .to.throw(Error)
        .with.property("message")
        .that.includes(name)
        .and.includes(envFile)
        .and.not.includes(OTHER);
    }
  });

  it("refuses a DEPLOY_MODE set only outside the file", function () {
    const fileEnv = { ...freshFile };
    delete fileEnv.DEPLOY_MODE;
    expect(() => plan(fileEnv, { DEPLOY_MODE: "fresh" }))
      .to.throw(Error)
      .with.property("message")
      .that.includes("DEPLOY_MODE")
      .and.includes(envFile);
  });

  it("accepts the same value in the file and the environment", function () {
    expect(plan(freshFile, { DEPLOY_MODE: "fresh" }).mode).to.equal("fresh");
  });

  it("treats an empty line in the file as unset, as the file's other readers do", function () {
    const fileEnv = {
      ...freshFile,
      AI_AGENT_CONTRACT_ADDRESS: "",
      AI_AGENT_ESCROW_CONTRACT_ADDRESS: "",
    };
    expect(plan(fileEnv).mode).to.equal("fresh");
  });

  it("refuses an EVM deploy with no ENV_FILE", function () {
    expect(() =>
      resolveDeployPlan({
        networkName: "baseSepolia",
        envFile: undefined,
        fileEnv: null,
        processEnv: freshFile,
      }),
    )
      .to.throw(Error)
      .with.property("message")
      .that.includes("ENV_FILE");
  });

  it("carries ORACLE_ADDRESS into the plan when set", function () {
    expect(plan({ ...freshFile, ORACLE_ADDRESS: OTHER }).oracle).to.equal(OTHER);
  });

  it("gives the Sapphire path no mode", function () {
    const p = resolveDeployPlan({
      networkName: "sapphire-testnet",
      envFile: undefined,
      fileEnv: null,
      processEnv: {},
    });
    expect(p.isSapphire).to.equal(true);
  });
});

describe("scripts/deploy — what it prints", function () {
  it("never reads the network's RPC address, which carries the provider's access key", function () {
    const source = fs.readFileSync(path.join(__dirname, "..", "scripts", "deploy.js"), "utf8");

    // Hardhat already holds the address; the script has no use for it except to print it.
    expect(source).to.not.match(/network\.config\.url/);
    expect(source).to.not.match(/rpcUrl/i);
  });
});

describe("hardhat.config — Basescan verify endpoints", function () {
  it("base verifies against the mainnet API, baseSepolia against the sepolia API", function () {
    expect(hardhatConfig.networks.base.verify.etherscan.apiUrl).to.equal(
      "https://api.basescan.org",
    );
    expect(hardhatConfig.networks.baseSepolia.verify.etherscan.apiUrl).to.equal(
      "https://api-sepolia.basescan.org",
    );
  });
});

describe("package scripts — ROFL signing goes through the Keychain wrapper", function () {
  const { scripts } = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
  );
  const signing = Object.entries(scripts).filter(([name]) =>
    /^rofl:(create|update|deploy):/.test(name),
  );

  it("covers every rofl:create / rofl:update / rofl:deploy script (all 13, exactly)", function () {
    const expected = [];
    for (const env of ["testnet", "base-testnet", "mainnet", "base-mainnet"]) {
      expected.push(`rofl:create:${env}`, `rofl:update:${env}`, `rofl:deploy:${env}`);
    }
    expected.push("rofl:update:sepolia-on-mainnet");
    expect(signing.map(([name]) => name).sort()).to.deep.equal(expected.sort());
  });

  it("never invokes a signing `oasis rofl` command bare", function () {
    for (const [name, cmd] of signing) {
      expect(cmd, name).to.not.match(/(^|&&\s*)oasis rofl (create|update|deploy)\b/);
      expect(cmd, name).to.match(/expect scripts\/oasis-unlock\.exp rofl (create|update|deploy)\b/);
    }
  });

  it("routes every logs:<env> script through the same wrapper with the deployment's own account", function () {
    // `rofl machine logs` prompts for the passphrase of the account that owns the machine, so
    // the logs scripts must name that account: the wrapper derives the Keychain item from
    // `--account`, and a logs script without one falls back to the shared item and is refused.
    const logs = Object.entries(scripts).filter(([name]) => /^logs:/.test(name));
    expect(logs.map(([name]) => name).sort()).to.deep.equal([
      "logs:base-mainnet",
      "logs:base-testnet",
    ]);
    const accountFor = { "base-testnet": "oasis_testnet", "base-mainnet": "oasis_mainnet" };
    for (const [name, cmd] of logs) {
      const env = name.slice("logs:".length);
      expect(cmd, name).to.equal(
        `expect scripts/oasis-unlock.exp rofl machine logs --deployment ${env} --account ${accountFor[env]}`,
      );
    }
    expect(
      fs.existsSync(path.join(__dirname, "..", "scripts", "rofl-logs.exp")),
      "rofl-logs.exp",
    ).to.equal(false);
  });

  it("runs the oracle hand-over and the fee token listing on each Base network with its own env file", function () {
    const networks = {
      "base-localnet": "localnet",
      "base-testnet": "baseSepolia",
      "base-mainnet": "base",
    };
    for (const [env, network] of Object.entries(networks)) {
      for (const script of ["authorize-oracle", "list-fee-token-exempt"]) {
        expect(scripts[`${script}:${env}`], `${script}:${env}`).to.equal(
          `ENV_FILE=.env.${env} HARDHAT_NETWORK=${network} node scripts/${script}.js`,
        );
      }
    }
  });

  it("deploy:base-mainnet still targets --network base from .env.base-mainnet (the guard is in deploy.js)", function () {
    expect(scripts["deploy:base-mainnet"]).to.equal(
      "ENV_FILE=.env.base-mainnet hardhat run scripts/deploy.js --network base",
    );
  });
});
