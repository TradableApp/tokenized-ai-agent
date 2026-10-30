const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const { deployProblems, assertDeployAllowed, CONFIRM_VAR } = require("../scripts/deploy");
const hardhatConfig = require("../hardhat.config");

const ADDRESS = "0x4a0C7e5807f9174499a8F56F2C69c61b39a4c64D";
const resolved = {
  TOKEN_CONTRACT_ADDRESS: ADDRESS,
  AI_AGENT_CONTRACT_ADDRESS: ADDRESS,
  AI_AGENT_ESCROW_CONTRACT_ADDRESS: ADDRESS,
  TREASURY_ADDRESS: ADDRESS,
  [CONFIRM_VAR]: "1",
};

describe("scripts/deploy — Base mainnet guard", function () {
  it("is a no-op off Base mainnet, even with placeholders and no confirm", function () {
    for (const networkName of ["baseSepolia", "localnet", "hardhat", "sapphire-testnet"]) {
      expect(
        deployProblems({ networkName, env: { TOKEN_CONTRACT_ADDRESS: "0xYOUR_TOKEN" } }),
        networkName,
      ).to.deep.equal([]);
    }
  });

  it("passes on base with real addresses and the confirm", function () {
    expect(deployProblems({ networkName: "base", env: resolved })).to.deep.equal([]);
    expect(() => assertDeployAllowed({ networkName: "base", env: resolved })).to.not.throw();
  });

  it("refuses placeholder or malformed addresses on base, naming each variable", function () {
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
  });

  it("requires TOKEN_CONTRACT_ADDRESS on base when a new escrow would be deployed", function () {
    const env = { ...resolved };
    delete env.TOKEN_CONTRACT_ADDRESS;
    delete env.AI_AGENT_ESCROW_CONTRACT_ADDRESS;
    const problems = deployProblems({ networkName: "base", env });
    expect(problems).to.have.lengthOf(1);
    expect(problems[0]).to.include("TOKEN_CONTRACT_ADDRESS");
  });

  it("requires TREASURY_ADDRESS on base when a new proxy would be deployed", function () {
    for (const missing of ["AI_AGENT_CONTRACT_ADDRESS", "AI_AGENT_ESCROW_CONTRACT_ADDRESS"]) {
      const env = { ...resolved };
      delete env[missing];
      delete env.TREASURY_ADDRESS;
      const problems = deployProblems({ networkName: "base", env });
      expect(problems, missing).to.have.lengthOf(1);
      expect(problems[0]).to.include("TREASURY_ADDRESS");
    }
  });

  it("does not require TREASURY_ADDRESS on base for a pure upgrade of both proxies", function () {
    const env = { ...resolved };
    delete env.TREASURY_ADDRESS;
    expect(deployProblems({ networkName: "base", env })).to.deep.equal([]);
  });

  it("does not require TOKEN_CONTRACT_ADDRESS on base when upgrading an existing escrow", function () {
    const env = { ...resolved };
    delete env.TOKEN_CONTRACT_ADDRESS;
    expect(deployProblems({ networkName: "base", env })).to.deep.equal([]);
  });

  it(`refuses base unless ${CONFIRM_VAR} is exactly "1"`, function () {
    for (const value of [undefined, "", "true", "yes", " 1"]) {
      const problems = deployProblems({
        networkName: "base",
        env: { ...resolved, [CONFIRM_VAR]: value },
      });
      expect(problems, JSON.stringify(value)).to.have.lengthOf(1);
      expect(problems[0]).to.include(`${CONFIRM_VAR}=1`);
    }
  });

  it("assertDeployAllowed throws one error listing every problem", function () {
    expect(() =>
      assertDeployAllowed({
        networkName: "base",
        env: { TOKEN_CONTRACT_ADDRESS: "0xYOUR_MAINNET_TOKEN_ADDRESS" },
      }),
    )
      .to.throw(Error)
      .with.property("message")
      .that.includes("TOKEN_CONTRACT_ADDRESS")
      .and.includes(`${CONFIRM_VAR}=1`)
      .and.includes("base");
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

  it("deploy:base-mainnet still targets --network base from .env.base-mainnet (the guard is in deploy.js)", function () {
    expect(scripts["deploy:base-mainnet"]).to.equal(
      "ENV_FILE=.env.base-mainnet hardhat run scripts/deploy.js --network base",
    );
  });
});
