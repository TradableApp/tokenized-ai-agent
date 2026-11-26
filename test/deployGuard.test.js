const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const {
  deployProblems,
  assertDeployAllowed,
  resolveDeployPlan,
  CONFIRM_VAR,
  FILE_ONLY_VARS,
  FRESH_LIVE_FILE_ONLY_VARS,
} = require("../scripts/deploy");
const hardhatConfig = require("../hardhat.config");

const ADDRESS = "0x4a0C7e5807f9174499a8F56F2C69c61b39a4c64D";
const OTHER = "0x36ec08471F2b995024967204D7542713cFaf5Fa4";
// The four fees a fresh escrow starts with, in wei: required for a fresh pair on a live network.
const FEES = {
  INITIAL_PROMPT_FEE: "1000000000000000000",
  INITIAL_CANCELLATION_FEE: "100000000000000000",
  INITIAL_METADATA_FEE: "100000000000000000",
  INITIAL_BRANCH_FEE: "500000000000000000",
};
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
  DOMAIN: "tradable.app",
  ...FEES,
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

  it("lets a dry run on base print the plan without the confirm, since it sends nothing", function () {
    const env = { ...freshOnBase, DRY_RUN: "1" };
    delete env[CONFIRM_VAR];
    expect(deployProblems({ networkName: "base", env })).to.deep.equal([]);
    for (const value of ["true", "yes", " 1", ""]) {
      const problems = deployProblems({ networkName: "base", env: { ...env, DRY_RUN: value } });
      expect(problems, JSON.stringify(value)).to.have.lengthOf(1);
      expect(problems[0]).to.include(`${CONFIRM_VAR}=1`);
    }
  });

  it("carries DRY_RUN=1 (exactly) into the plan", function () {
    const plan = (DRY_RUN) =>
      resolveDeployPlan({
        networkName: "baseSepolia",
        envFile: ".env.base-testnet",
        fileEnv: freshOnBase,
        processEnv: { ...freshOnBase, DRY_RUN },
      });
    expect(plan("1").dryRun).to.equal(true);
    expect(plan("true").dryRun).to.equal(false);
    expect(plan(undefined).dryRun).to.equal(false);
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

  it("fresh on a live network needs TREASURY_ADDRESS, EXPECTED_FEE_TOKEN_SYMBOL and DOMAIN", function () {
    for (const networkName of ["base", "baseSepolia"]) {
      for (const missing of ["TREASURY_ADDRESS", "EXPECTED_FEE_TOKEN_SYMBOL", "DOMAIN"]) {
        const env = { ...freshOnBase };
        delete env[missing];
        const problems = deployProblems({ networkName, env });
        expect(problems, `${networkName} ${missing}`).to.have.lengthOf(1);
        expect(problems[0]).to.include(`${missing} must be set for a fresh pair on ${networkName}`);
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

  it("ORACLE_ADDRESS, when set on a local network, must be an address, described by shape only", function () {
    const localFresh = { DEPLOY_MODE: "fresh", TOKEN_CONTRACT_ADDRESS: ADDRESS };
    const problems = deployProblems({
      networkName: "localnet",
      env: { ...localFresh, ORACLE_ADDRESS: "0xnot-an-address" },
    });
    expect(problems).to.have.lengthOf(1);
    expect(problems[0]).to.include("ORACLE_ADDRESS").and.not.include("0xnot-an-address");
    expect(
      deployProblems({
        networkName: "localnet",
        env: { ...localFresh, ORACLE_ADDRESS: OTHER },
      }),
    ).to.deep.equal([]);
  });

  // On a live network the oracle's signer is derived from the new agent's address
  // (oracle/src/oracleKeys.js), so an address set before the agent exists is another pair's.
  it("a fresh pair on a live network refuses a set ORACLE_ADDRESS, naming it and what to do, never its value", function () {
    for (const networkName of ["baseSepolia", "base"]) {
      for (const value of [OTHER, "0xnot-an-address"]) {
        const problems = deployProblems({
          networkName,
          env: { ...freshOnBase, ORACLE_ADDRESS: value },
        });
        const refusal = problems.find((p) => p.includes("derived from the new agent's address"));
        expect(refusal, `${networkName} ${value}`).to.be.a("string");
        expect(refusal)
          .to.include("ORACLE_ADDRESS is set")
          .and.include("the deploy wallet is the first oracle")
          .and.include("authorize-oracle")
          .and.include("ANSWER_TX_HASH");
        expect(problems.join("\n")).to.not.include(value);
      }
    }
  });

  it("an upgrade on a live network does not read ORACLE_ADDRESS, so it is not refused there", function () {
    expect(
      deployProblems({ networkName: "baseSepolia", env: { ...resolved, ORACLE_ADDRESS: OTHER } }),
    ).to.deep.equal([]);
  });
});

describe("scripts/deploy — a fresh pair's initial fees", function () {
  const FEE_NAMES = Object.keys(FEES);

  it("must each be a whole number of wei written in decimal digits, on every network", function () {
    for (const networkName of ["base", "baseSepolia", "localnet", "hardhat"]) {
      for (const name of FEE_NAMES) {
        for (const value of ["1.5", "-1", "+1", "0x10", "1e18", "1_000", "1 000", "ten", "١"]) {
          const problems = deployProblems({
            networkName,
            env: { ...freshOnBase, [name]: value },
          });
          const label = `${networkName} ${name}=${JSON.stringify(value)}`;
          expect(problems, label).to.have.lengthOf(1);
          expect(problems[0], label).to.include(name).and.include("whole number of wei");
          // Described by its shape, never repeated.
          expect(problems[0], label).to.not.include(`(${value})`);
          expect(problems[0], label).to.not.include(`"${value}"`);
        }
      }
    }
  });

  it("accepts zero and any whole number of wei", function () {
    for (const value of ["0", "1", "1000000000000000000", "123456789012345678901234567890"]) {
      expect(
        deployProblems({ networkName: "base", env: { ...freshOnBase, INITIAL_PROMPT_FEE: value } }),
        value,
      ).to.deep.equal([]);
    }
  });

  it("are each required for a fresh pair on a live network", function () {
    for (const networkName of ["base", "baseSepolia"]) {
      for (const name of FEE_NAMES) {
        for (const missing of [undefined, "", "  "]) {
          const problems = deployProblems({
            networkName,
            env: { ...freshOnBase, [name]: missing },
          });
          expect(problems, `${networkName} ${name}`).to.have.lengthOf(1);
          expect(problems[0]).to.include(`${name} must be set for a fresh pair on ${networkName}`);
        }
      }
    }
  });

  it("fall back to the defaults on a local network", function () {
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

  it("are not asked for by an upgrade, which sets no fee", function () {
    expect(
      deployProblems({ networkName: "base", env: { ...resolved, INITIAL_PROMPT_FEE: "1.5" } }),
    ).to.deep.equal([]);
  });

  it("carries each fee into the plan as written", function () {
    const plan = resolveDeployPlan({
      networkName: "baseSepolia",
      envFile: ".env.base-testnet",
      fileEnv: { ...freshOnBase },
      processEnv: { ...freshOnBase },
    });
    expect(plan.fees).to.deep.equal({
      prompt: FEES.INITIAL_PROMPT_FEE,
      cancellation: FEES.INITIAL_CANCELLATION_FEE,
      metadata: FEES.INITIAL_METADATA_FEE,
      branch: FEES.INITIAL_BRANCH_FEE,
    });
  });
});

describe("scripts/deploy — the mode and the pair are read from ENV_FILE alone", function () {
  const envFile = ".env.base-testnet";
  const freshFile = {
    DEPLOY_MODE: "fresh",
    TOKEN_CONTRACT_ADDRESS: ADDRESS,
    TREASURY_ADDRESS: ADDRESS,
    EXPECTED_FEE_TOKEN_SYMBOL: "SENSE",
    DOMAIN: "tradable.app",
    ...FEES,
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

  it("carries ORACLE_ADDRESS into the plan of a fresh pair on a local network", function () {
    const localFile = {
      DEPLOY_MODE: "fresh",
      TOKEN_CONTRACT_ADDRESS: ADDRESS,
      ORACLE_ADDRESS: OTHER,
    };
    const p = resolveDeployPlan({
      networkName: "localnet",
      envFile,
      fileEnv: localFile,
      processEnv: localFile,
    });
    expect(p.oracle).to.equal(OTHER);
  });

  it("refuses ORACLE_ADDRESS for a fresh pair on a live network wherever it is set: the file, the root .env or the shell", function () {
    for (const [fileEnv, extra] of [
      [{ ...freshFile, ORACLE_ADDRESS: OTHER }, {}],
      [freshFile, { ORACLE_ADDRESS: OTHER }],
    ]) {
      expect(() => plan(fileEnv, extra))
        .to.throw(Error)
        .with.property("message")
        .that.includes("ORACLE_ADDRESS is set")
        .and.includes("derived from the new agent's address")
        .and.not.includes(OTHER);
    }
  });

  describe("a fresh pair on a live network takes every setting that wires it from the file", function () {
    const liveFile = {
      ...freshFile,
      DOMAIN: "tradable.app",
    };
    // A value only the root .env or the shell holds: one per setting, each distinct, so a
    // message that repeated it would be caught.
    const outside = {
      TOKEN_CONTRACT_ADDRESS: "0x1111111111111111111111111111111111111111",
      TREASURY_ADDRESS: "0x2222222222222222222222222222222222222222",
      EXPECTED_FEE_TOKEN_SYMBOL: "ROOTSYMBOL",
      INITIAL_PROMPT_FEE: "7777777777",
      INITIAL_CANCELLATION_FEE: "6666666666",
      INITIAL_METADATA_FEE: "5555555555",
      INITIAL_BRANCH_FEE: "4444444444",
      DOMAIN: "root-domain.example",
    };
    const livePlan = (networkName, fileEnv, extra = {}) =>
      resolveDeployPlan({
        networkName,
        envFile,
        fileEnv,
        processEnv: { ...fileEnv, ...extra },
      });

    it("names the settings it reads from the file alone for a fresh pair on a live network", function () {
      expect([...FRESH_LIVE_FILE_ONLY_VARS].sort()).to.deep.equal(Object.keys(outside).sort());
    });

    it("passes when the file holds them all", function () {
      const p = livePlan("baseSepolia", liveFile);
      expect(p.oracle).to.equal(null);
      expect(p.domain).to.equal("tradable.app");
    });

    for (const name of Object.keys(outside)) {
      it(`refuses ${name} set only in the root .env or the shell, naming it and the file, never its value`, function () {
        for (const networkName of ["baseSepolia", "base"]) {
          const fileEnv = { ...liveFile, [CONFIRM_VAR]: "1" };
          delete fileEnv[name];
          expect(() => livePlan(networkName, fileEnv, { [name]: outside[name] }), networkName)
            .to.throw(Error)
            .with.property("message")
            .that.includes(`${name} is not set in ${envFile}`)
            .and.not.includes(outside[name]);
        }
      });

      it(`refuses ${name} that differs between the file and the shell, never printing either`, function () {
        const fileEnv = { ...liveFile };
        expect(() => livePlan("baseSepolia", fileEnv, { [name]: outside[name] }))
          .to.throw(Error)
          .with.property("message")
          .that.includes(`${name} in the root .env or the shell differs from ${envFile}`)
          .and.not.includes(outside[name]);
      });
    }

    it("an upgrade does not ask: it reads none of them", function () {
      const upgradeFile = {
        DEPLOY_MODE: "upgrade",
        AI_AGENT_CONTRACT_ADDRESS: ADDRESS,
        AI_AGENT_ESCROW_CONTRACT_ADDRESS: ADDRESS,
      };
      expect(livePlan("baseSepolia", upgradeFile, outside).mode).to.equal("upgrade");
    });

    it("a local network still reads them from the merged environment, as the e2e bring-up writes only some to the file", function () {
      const localFile = { DEPLOY_MODE: "fresh", TOKEN_CONTRACT_ADDRESS: ADDRESS };
      const p = livePlan("localnet", localFile, { TREASURY_ADDRESS: outside.TREASURY_ADDRESS });
      expect(p.treasury).to.equal(outside.TREASURY_ADDRESS);
    });
  });

  it("refuses DRY_RUN=1 on a Sapphire network, whose deploy has no dry run, before anything is sent", function () {
    for (const networkName of ["sapphire", "sapphire-testnet", "sapphire-localnet"]) {
      expect(
        () =>
          resolveDeployPlan({
            networkName,
            envFile: undefined,
            fileEnv: null,
            processEnv: { DRY_RUN: "1" },
          }),
        networkName,
      )
        .to.throw(Error)
        .with.property("message")
        .that.includes("DRY_RUN=1")
        .and.includes("fresh pair on an EVM network")
        .and.includes("Nothing was sent");
    }
  });

  it("leaves the Sapphire path as it was without DRY_RUN=1", function () {
    for (const DRY_RUN of [undefined, "", "true"]) {
      const p = resolveDeployPlan({
        networkName: "sapphire-testnet",
        envFile: undefined,
        fileEnv: null,
        processEnv: { DRY_RUN },
      });
      expect(p.isSapphire, JSON.stringify(DRY_RUN)).to.equal(true);
    }
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

// Hardhat loads ENV_FILE over the shell, so a line there would replace what was typed. DRY_RUN
// and the mainnet confirmation are read from what was typed alone (`typedEnv`, recorded before
// the files load), and a file that contradicts it stops the deploy.
describe("scripts/deploy — DRY_RUN and the mainnet confirmation come from what was typed", function () {
  const envFile = ".env.base-testnet";
  const plan = ({ networkName = "baseSepolia", loaded = {}, typed = {} } = {}) =>
    resolveDeployPlan({
      networkName,
      envFile,
      fileEnv: freshOnBase,
      processEnv: { ...freshOnBase, [CONFIRM_VAR]: undefined, ...loaded },
      typedEnv: typed,
    });

  it("a typed DRY_RUN=1 that the file replaces stops the deploy, so a dry run never sends", function () {
    for (const loaded of ["0", ""]) {
      expect(() => plan({ loaded: { DRY_RUN: loaded }, typed: { DRY_RUN: "1" } }), loaded)
        .to.throw(Error)
        .with.property("message")
        .that.includes("DRY_RUN was typed on the command line")
        .and.includes(envFile);
    }
  });

  it("a DRY_RUN=1 that only a file sets is refused, not taken as a dry run", function () {
    expect(() => plan({ loaded: { DRY_RUN: "1" } }))
      .to.throw(Error)
      .with.property("message")
      .that.includes("DRY_RUN is set in");
  });

  it("takes the dry run from what was typed", function () {
    expect(plan({ loaded: { DRY_RUN: "1" }, typed: { DRY_RUN: "1" } }).dryRun).to.equal(true);
    expect(plan().dryRun).to.equal(false);
  });

  it("the mainnet confirmation never comes from a file", function () {
    expect(() => plan({ networkName: "base", loaded: { [CONFIRM_VAR]: "1" } }))
      .to.throw(Error)
      .with.property("message")
      .that.includes(`${CONFIRM_VAR} is set in`)
      .and.includes(`needs exactly ${CONFIRM_VAR}=1`);
    expect(
      plan({
        networkName: "base",
        loaded: { [CONFIRM_VAR]: "1" },
        typed: { [CONFIRM_VAR]: "1" },
      }).mode,
    ).to.equal("fresh");
  });

  it("refuses a typed DRY_RUN=1 on a Sapphire network as before, and a file's line there too", function () {
    const sapphire = (processEnv, typedEnv) =>
      resolveDeployPlan({
        networkName: "sapphire-testnet",
        envFile: undefined,
        fileEnv: null,
        processEnv,
        typedEnv,
      });
    expect(() => sapphire({ DRY_RUN: "1" }, { DRY_RUN: "1" })).to.throw(
      /the Sapphire deploy has none/,
    );
    expect(() => sapphire({ DRY_RUN: "1" }, {})).to.throw(/DRY_RUN is set in/);
  });
});

describe("scripts/deploy — what it prints", function () {
  it("never reads the network's RPC address, which carries the provider's access key", function () {
    const source = fs.readFileSync(path.join(__dirname, "..", "scripts", "deploy.js"), "utf8");

    // Hardhat already holds the address; the script has no use for it except to print it.
    expect(source).to.not.match(/network\.config\.url/);
    expect(source).to.not.match(/rpcUrl/i);
  });

  it("prints a failure through failureText, never the error or its stack, which carry the request", function () {
    for (const script of ["deploy.js", "authorize-oracle.js", "list-fee-token-exempt.js"]) {
      const source = fs.readFileSync(path.join(__dirname, "..", "scripts", script), "utf8");
      expect(source, script).to.not.match(/console\.error\(\s*error\s*\)/);
      // An ethers error's message holds the request's address, and a stack starts with the message.
      expect(source, script).to.not.match(/error\??\.stack/);
      expect(source, script).to.match(/console\.error\(chalk\.red\(failureText\(error/);
    }
  });
});

describe(".env.example — the deploy's settings are named", function () {
  const template = fs.readFileSync(path.join(__dirname, "..", ".env.example"), "utf8");

  for (const name of [
    "DEPLOY_MODE",
    "EXPECTED_FEE_TOKEN_SYMBOL",
    "TREASURY_ADDRESS",
    "ORACLE_ADDRESS",
    "INITIAL_PROMPT_FEE",
    "INITIAL_CANCELLATION_FEE",
    "INITIAL_METADATA_FEE",
    "INITIAL_BRANCH_FEE",
  ]) {
    it(`names ${name} with an empty value and a comment above it`, function () {
      const lines = template.split("\n");
      const at = lines.findIndex((line) => line.startsWith(`${name}=`));
      expect(at, name).to.be.greaterThan(0);
      expect(lines[at], name).to.equal(`${name}=`);
      expect(lines[at - 1], name).to.match(/^#/);
    });
  }
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

  it("has a dry run of the deploy on each live Base network, which prints the plan and sends nothing", function () {
    expect(scripts["deploy:base-testnet:dry"]).to.equal(
      "DRY_RUN=1 ENV_FILE=.env.base-testnet hardhat run scripts/deploy.js --network baseSepolia",
    );
    expect(scripts["deploy:base-mainnet:dry"]).to.equal(
      "DRY_RUN=1 ENV_FILE=.env.base-mainnet hardhat run scripts/deploy.js --network base",
    );
  });

  it("deploy:base-mainnet still targets --network base from .env.base-mainnet (the guard is in deploy.js)", function () {
    expect(scripts["deploy:base-mainnet"]).to.equal(
      "ENV_FILE=.env.base-mainnet hardhat run scripts/deploy.js --network base",
    );
  });
});
