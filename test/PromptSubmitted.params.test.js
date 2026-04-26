const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const path = require("path");
const fs = require("fs");

describe("Suite 1 — PromptSubmitted Event Parameter Order", function () {
  const domain = "example.com";

  async function deployFixture() {
    const [deployer, user, oracle] = await ethers.getSigners();
    const EVMAIAgent = await ethers.getContractFactory("EVMAIAgent");
    const MockEscrowFactory = await ethers.getContractFactory("MockEVMAIAgentEscrow");

    const aiAgent = await upgrades.deployProxy(
      EVMAIAgent,
      [domain, oracle.address, deployer.address],
      { initializer: "initialize", kind: "uups" },
    );
    await aiAgent.waitForDeployment();

    const mockEscrow = await MockEscrowFactory.deploy(await aiAgent.getAddress());
    await mockEscrow.waitForDeployment();
    await aiAgent.connect(deployer).setAgentEscrow(await mockEscrow.getAddress());

    return { aiAgent, mockEscrow, user, oracle, deployer };
  }

  describe("Event signature and ABI encoding", function () {
    it("should emit PromptSubmitted with correct parameter order: (user, conversationId, promptMessageId, answerMessageId, encryptedPayload, roflEncryptedKey)", async function () {
      const { aiAgent, mockEscrow, user } = await loadFixture(deployFixture);

      const conversationId = 1;
      const promptMessageId = 0;
      const answerMessageId = 1;
      const encryptedPayload = "0xdeadbeef";
      const roflEncryptedKey = "0xcafebabe";

      const tx = await mockEscrow
        .connect(user)
        .callSubmitPrompt(
          user.address,
          conversationId,
          promptMessageId,
          answerMessageId,
          encryptedPayload,
          roflEncryptedKey,
        );

      const receipt = await tx.wait();

      // Locate the PromptSubmitted log
      const agentIface = aiAgent.interface;
      const promptSubmittedTopic = agentIface.getEvent("PromptSubmitted").topicHash;
      const log = receipt.logs.find((l) => l.topics[0] === promptSubmittedTopic);
      expect(log, "PromptSubmitted log not found in receipt").to.not.be.undefined;

      const parsed = agentIface.parseLog(log);

      // Param index 0 (indexed): user address
      expect(parsed.args[0]).to.equal(user.address, "param[0] must be user address");

      // Param index 1 (indexed): conversationId
      expect(parsed.args[1]).to.equal(BigInt(conversationId), "param[1] must be conversationId");

      // Param index 2 (indexed): promptMessageId
      expect(parsed.args[2]).to.equal(BigInt(promptMessageId), "param[2] must be promptMessageId");

      // Param index 3 (non-indexed): answerMessageId — the universal linking key
      expect(parsed.args[3]).to.equal(BigInt(answerMessageId), "param[3] must be answerMessageId");

      // Param index 4 (non-indexed): encryptedPayload
      expect(parsed.args[4]).to.equal(encryptedPayload, "param[4] must be encryptedPayload");

      // Param index 5 (non-indexed): roflEncryptedKey
      expect(parsed.args[5]).to.equal(roflEncryptedKey, "param[5] must be roflEncryptedKey");
    });

    it("should match the canonical ABI event definition exactly", async function () {
      const { aiAgent } = await loadFixture(deployFixture);
      const eventFragment = aiAgent.interface.getEvent("PromptSubmitted");

      expect(eventFragment.name).to.equal("PromptSubmitted");

      const inputs = eventFragment.inputs;
      expect(inputs).to.have.length(6);

      expect(inputs[0].name).to.equal("user");
      expect(inputs[0].type).to.equal("address");
      expect(inputs[0].indexed).to.be.true;

      expect(inputs[1].name).to.equal("conversationId");
      expect(inputs[1].type).to.equal("uint256");
      expect(inputs[1].indexed).to.be.true;

      expect(inputs[2].name).to.equal("promptMessageId");
      expect(inputs[2].type).to.equal("uint256");
      expect(inputs[2].indexed).to.be.true;

      expect(inputs[3].name).to.equal("answerMessageId");
      expect(inputs[3].type).to.equal("uint256");
      expect(inputs[3].indexed).to.be.false;

      expect(inputs[4].name).to.equal("encryptedPayload");
      expect(inputs[4].type).to.equal("bytes");
      expect(inputs[4].indexed).to.be.false;

      expect(inputs[5].name).to.equal("roflEncryptedKey");
      expect(inputs[5].type).to.equal("bytes");
      expect(inputs[5].indexed).to.be.false;
    });
  });

  describe("ABI sync: compiled artifact vs dApp ABI vs subgraph ABI", function () {
    before(function () {
      const sentinel = path.resolve(
        __dirname,
        "../../../../../sense-ai-dapp/src/lib/abi/EVMAIAgent.json",
      );
      if (!fs.existsSync(sentinel)) {
        this.skip(); // sibling repos not checked out (CI single-repo environment)
      }
    });

    function loadExternalAbi(relPath) {
      const abs = path.resolve(__dirname, "../../../../../", relPath);
      const raw = JSON.parse(fs.readFileSync(abs, "utf8"));
      return Array.isArray(raw) ? raw : raw.abi;
    }

    function extractEventFragment(abi, eventName) {
      return abi.find((f) => f.type === "event" && f.name === eventName);
    }

    function normalisedInputs(fragment) {
      return fragment.inputs.map((i) => ({
        name: i.name,
        type: i.type,
        indexed: i.indexed,
      }));
    }

    it("dApp ABI PromptSubmitted matches compiled ABI", async function () {
      const { aiAgent } = await loadFixture(deployFixture);
      const compiledFragment = aiAgent.interface.getEvent("PromptSubmitted");
      const compiledInputs = normalisedInputs(compiledFragment);

      const dappAbi = loadExternalAbi("sense-ai-dapp/src/lib/abi/EVMAIAgent.json");
      const dappFragment = extractEventFragment(dappAbi, "PromptSubmitted");
      expect(dappFragment, "dApp ABI missing PromptSubmitted event").to.not.be.undefined;

      const dappInputs = normalisedInputs(dappFragment);
      expect(dappInputs).to.deep.equal(compiledInputs);
    });

    it("subgraph ABI PromptSubmitted matches compiled ABI", async function () {
      const { aiAgent } = await loadFixture(deployFixture);
      const compiledFragment = aiAgent.interface.getEvent("PromptSubmitted");
      const compiledInputs = normalisedInputs(compiledFragment);

      const subgraphAbi = loadExternalAbi("sense-ai-subgraph/abis/EVMAIAgent.json");
      const subgraphFragment = extractEventFragment(subgraphAbi, "PromptSubmitted");
      expect(subgraphFragment, "Subgraph ABI missing PromptSubmitted event").to.not.be.undefined;

      const subgraphInputs = normalisedInputs(subgraphFragment);
      expect(subgraphInputs).to.deep.equal(compiledInputs);
    });

    it("answerMessageId is param[3] (non-indexed) in all three ABIs", async function () {
      const { aiAgent } = await loadFixture(deployFixture);

      const dappAbi = loadExternalAbi("sense-ai-dapp/src/lib/abi/EVMAIAgent.json");
      const subgraphAbi = loadExternalAbi("sense-ai-subgraph/abis/EVMAIAgent.json");

      for (const [label, abi] of [
        ["compiled", aiAgent.interface.fragments],
        ["dApp", dappAbi],
        ["subgraph", subgraphAbi],
      ]) {
        let fragment;
        if (Array.isArray(abi)) {
          // compiled interface fragments
          fragment = abi.find((f) => f.name === "PromptSubmitted");
        } else {
          fragment = extractEventFragment(abi, "PromptSubmitted");
        }
        expect(fragment, `${label}: PromptSubmitted not found`).to.not.be.undefined;

        const inputs = Array.isArray(abi) ? fragment.inputs : fragment.inputs;
        expect(inputs[3].name).to.equal(
          "answerMessageId",
          `${label}: param[3] must be answerMessageId`,
        );
        expect(inputs[3].indexed).to.equal(false, `${label}: answerMessageId must be non-indexed`);
      }
    });
  });
});
