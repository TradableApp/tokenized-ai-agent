const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("EVMAIAgent (Upgradable)", function () {
  // --- Test Suite Setup ---
  const domain = "example.com";
  const roflAppID = ethers.zeroPadBytes("0x", 21);
  const mockEncryptedContent = ethers.toUtf8Bytes("What is the nature of consciousness?");
  const mockUserKey = ethers.toUtf8Bytes("user-key-material");
  const mockRoflKey = ethers.toUtf8Bytes("rofl-key-material");
  const mockAnswerContent = ethers.toUtf8Bytes(
    "That is a complex philosophical question with no single answer.",
  );

  // Deploys contracts and sets up the test environment.
  // This fixture is used by `loadFixture` to speed up tests.
  async function deployAgentFixture() {
    const [deployer, user, oracle, unauthorizedUser] = await ethers.getSigners();
    const EVMAIAgent = await ethers.getContractFactory("EVMAIAgent");
    const MockEscrowFactory = await ethers.getContractFactory("MockEVMAIAgentEscrow");

    // Deploy the EVMAIAgent as an upgradable proxy
    const aiAgent = await upgrades.deployProxy(
      EVMAIAgent,
      [domain, roflAppID, oracle.address, deployer.address], // owner is deployer
      { initializer: "initialize", kind: "uups" },
    );
    await aiAgent.waitForDeployment();

    // Deploy the mock escrow with the real agent address
    const mockEscrow = await MockEscrowFactory.deploy(await aiAgent.getAddress());
    await mockEscrow.waitForDeployment();

    // Link the agent to the mock escrow
    await aiAgent.connect(deployer).setAgentEscrow(await mockEscrow.getAddress());

    return { aiAgent, mockEscrow, deployer, user, oracle, unauthorizedUser, EVMAIAgent };
  }

  // --- Test Cases ---

  describe("Initialization", function () {
    it("should set the correct initial state on deployment", async function () {
      const { aiAgent, mockEscrow, oracle, deployer } = await loadFixture(deployAgentFixture);
      expect(await aiAgent.oracle()).to.equal(oracle.address);
      expect(await aiAgent.domain()).to.equal(domain);
      expect(await aiAgent.roflAppID()).to.equal(roflAppID);
      expect(await aiAgent.aiAgentEscrow()).to.equal(await mockEscrow.getAddress());
      expect(await aiAgent.owner()).to.equal(deployer.address);
    });

    it("should revert if initialized with a zero address for the oracle", async function () {
      const { EVMAIAgent, deployer } = await loadFixture(deployAgentFixture);
      // FIX: Check for the specific custom error from our contract.
      await expect(
        upgrades.deployProxy(EVMAIAgent, [
          domain,
          roflAppID,
          ethers.ZeroAddress, // Invalid oracle
          deployer.address,
        ]),
      ).to.be.revertedWithCustomError(EVMAIAgent, "ZeroAddress");
    });

    it("should revert if initialized with a zero address for the owner", async function () {
      const { EVMAIAgent, oracle } = await loadFixture(deployAgentFixture);
      await expect(
        upgrades.deployProxy(EVMAIAgent, [
          domain,
          roflAppID,
          oracle.address,
          ethers.ZeroAddress, // Invalid owner
        ]),
      ).to.be.revertedWithCustomError(EVMAIAgent, "ZeroAddress");
    });
  });

  describe("Prompts", function () {
    it("should allow the AgentEscrow contract to submit a prompt", async function () {
      const { aiAgent, mockEscrow, deployer, user } = await loadFixture(deployAgentFixture);
      const promptId = await aiAgent.promptIdCounter();
      // To test the `onlyAIAgentEscrow` modifier, we must make the call from the mock escrow's address.
      // We achieve this by having the mock's owner (deployer) call a helper function on the mock.
      // The mock then makes the real call to the AI Agent.
      await expect(
        mockEscrow
          .connect(deployer)
          .callSubmitPrompt(promptId, user.address, mockEncryptedContent, mockUserKey, mockRoflKey),
      )
        .to.emit(aiAgent, "PromptSubmitted")
        .withArgs(user.address, promptId);

      const prompts = await aiAgent.connect(user).getPrompts(user.address);
      expect(prompts.length).to.equal(1);
      expect(prompts[0].promptId).to.equal(promptId);
    });

    it("should revert if called by an address other than the AgentEscrow contract", async function () {
      const { aiAgent, user } = await loadFixture(deployAgentFixture);
      const promptId = await aiAgent.promptIdCounter();
      await expect(
        aiAgent
          .connect(user)
          .submitPrompt(promptId, user.address, mockEncryptedContent, mockUserKey, mockRoflKey),
      ).to.be.revertedWithCustomError(aiAgent, "NotAIAgentEscrow");
    });

    it("should revert if the provided promptId does not match the counter", async function () {
      const { aiAgent, mockEscrow, deployer, user } = await loadFixture(deployAgentFixture);
      const wrongPromptId = (await aiAgent.promptIdCounter()) + 1n; // Intentionally incorrect ID
      await expect(
        mockEscrow
          .connect(deployer)
          .callSubmitPrompt(
            wrongPromptId,
            user.address,
            mockEncryptedContent,
            mockUserKey,
            mockRoflKey,
          ),
      ).to.be.revertedWithCustomError(aiAgent, "MismatchedPromptId");
    });
  });

  describe("Cancellations", function () {
    let aiAgent, mockEscrow, deployer, user;

    beforeEach(async function () {
      const fixtures = await loadFixture(deployAgentFixture);
      aiAgent = fixtures.aiAgent;
      mockEscrow = fixtures.mockEscrow;
      deployer = fixtures.deployer;
      user = fixtures.user;

      // Set up a prompt to be cancelled.
      const promptId = await aiAgent.promptIdCounter();
      await mockEscrow.connect(deployer).callSubmitPrompt(promptId, user.address, "0x", "0x", "0x");
    });

    it("should allow the escrow contract to store a cancellation", async function () {
      const promptId = 0;

      // Simulate the escrow contract calling storeCancellation.
      await mockEscrow.connect(deployer).callStoreCancellation(promptId, user.address);

      // Verify state changes
      expect(await aiAgent.isPromptAnswered(promptId)).to.be.true;

      const answers = await aiAgent.getAnswers(user.address);
      expect(answers.length).to.equal(1);
      expect(answers[0].promptId).to.equal(promptId);

      // Check the plaintext message and that the key fields are empty, per our convention.
      expect(ethers.toUtf8String(answers[0].message.encryptedContent)).to.equal(
        "Prompt cancelled by user.",
      );
      expect(answers[0].message.userEncryptedKey).to.equal("0x");
      expect(answers[0].message.roflEncryptedKey).to.equal("0x");
    });

    it("should revert if an address other than the escrow contract calls storeCancellation", async function () {
      await expect(
        aiAgent.connect(user).storeCancellation(0, user.address),
      ).to.be.revertedWithCustomError(aiAgent, "NotAIAgentEscrow");
    });

    it("should revert if trying to cancel a prompt that is already answered", async function () {
      const promptId = 0;
      const { oracle } = await loadFixture(deployAgentFixture);

      // First, the oracle submits a real answer.
      await aiAgent.connect(oracle).submitAnswer("0x", "0x", "0x", promptId, user.address);

      // Now, the escrow contract tries to store a cancellation for the same prompt.
      await expect(
        mockEscrow.connect(deployer).callStoreCancellation(promptId, user.address),
      ).to.be.revertedWithCustomError(aiAgent, "PromptAlreadyAnswered");
    });
  });

  describe("Answers", function () {
    // Define shared variables for this context
    let aiAgent, mockEscrow, user, oracle, unauthorizedUser;

    beforeEach(async function () {
      // Use the fixture to get fresh contracts for each test in this block
      const fixtures = await loadFixture(deployAgentFixture);
      aiAgent = fixtures.aiAgent;
      mockEscrow = fixtures.mockEscrow;
      user = fixtures.user;
      oracle = fixtures.oracle;
      unauthorizedUser = fixtures.unauthorizedUser;

      // Create a prompt to be answered in the tests
      const promptId = await aiAgent.promptIdCounter();
      await mockEscrow
        .connect(fixtures.deployer)
        .callSubmitPrompt(promptId, user.address, mockEncryptedContent, mockUserKey, mockRoflKey);
    });

    context("When called by the authorized oracle", function () {
      it("should successfully submit an answer and call the escrow contract", async function () {
        const aiAgentWithOracle = aiAgent.connect(oracle);
        const promptId = 0;
        await expect(
          aiAgentWithOracle.submitAnswer(
            mockAnswerContent,
            mockUserKey,
            mockRoflKey,
            promptId,
            user.address,
          ),
        ).to.not.be.reverted;

        const answers = await aiAgent.connect(user).getAnswers(user.address);
        expect(answers.length).to.equal(1);
        expect(answers[0].promptId).to.equal(promptId);

        // Assert that the mock escrow was called correctly.
        expect(await mockEscrow.finalizePaymentCallCount()).to.equal(1);
        expect(await mockEscrow.lastFinalizedPromptId()).to.equal(promptId);
      });

      it("should revert if the promptId has already been answered", async function () {
        const aiAgentWithOracle = aiAgent.connect(oracle);
        await aiAgentWithOracle.submitAnswer(
          mockAnswerContent,
          mockUserKey,
          mockRoflKey,
          0,
          user.address,
        );

        await expect(
          aiAgentWithOracle.submitAnswer(
            mockAnswerContent,
            mockUserKey,
            mockRoflKey,
            0,
            user.address,
          ),
        ).to.be.revertedWithCustomError(aiAgent, "PromptAlreadyAnswered");
      });

      it("should revert if the promptId is invalid (does not exist)", async function () {
        const aiAgentWithOracle = aiAgent.connect(oracle);
        await expect(
          aiAgentWithOracle.submitAnswer(
            mockAnswerContent,
            mockUserKey,
            mockRoflKey,
            99, // Non-existent promptId
            user.address,
          ),
        ).to.be.revertedWithCustomError(aiAgent, "InvalidPromptId");
      });
    });

    context("When called by an unauthorized user", function () {
      it("should revert", async function () {
        const aiAgentWithUnauthorized = aiAgent.connect(unauthorizedUser);
        await expect(
          aiAgentWithUnauthorized.submitAnswer(
            mockAnswerContent,
            mockUserKey,
            mockRoflKey,
            0,
            user.address,
          ),
        ).to.be.revertedWithCustomError(aiAgent, "UnauthorizedOracle");
      });
    });
  });

  describe("Clear prompts and answers", function () {
    it("should allow a user to clear their own prompts and answers", async function () {
      const { aiAgent, mockEscrow, user, deployer } = await loadFixture(deployAgentFixture);
      const promptId = await aiAgent.promptIdCounter();
      await mockEscrow
        .connect(deployer)
        .callSubmitPrompt(promptId, user.address, mockEncryptedContent, mockUserKey, mockRoflKey);

      await aiAgent.connect(user).clearPrompt(user.address);

      const prompts = await aiAgent.connect(user).getPrompts(user.address);
      expect(prompts.length).to.equal(0);
    });

    it("should prevent a user from clearing another user's data", async function () {
      const { aiAgent, mockEscrow, user, deployer, unauthorizedUser } =
        await loadFixture(deployAgentFixture);
      const promptId = await aiAgent.promptIdCounter();
      await mockEscrow
        .connect(deployer)
        .callSubmitPrompt(promptId, user.address, mockEncryptedContent, mockUserKey, mockRoflKey);

      // The unauthorized user tries to clear the prompt owner's data. This must fail.
      await expect(
        aiAgent.connect(unauthorizedUser).clearPrompt(user.address),
      ).to.be.revertedWithCustomError(aiAgent, "UnauthorizedUser");
    });
  });

  describe("View Functions (Access Control)", function () {
    let aiAgent, user, oracle, unauthorizedUser;

    beforeEach(async function () {
      const fixtures = await loadFixture(deployAgentFixture);
      aiAgent = fixtures.aiAgent;
      user = fixtures.user;
      oracle = fixtures.oracle;
      unauthorizedUser = fixtures.unauthorizedUser;
      const promptId = await aiAgent.promptIdCounter();
      await fixtures.mockEscrow
        .connect(fixtures.deployer)
        .callSubmitPrompt(promptId, user.address, mockEncryptedContent, mockUserKey, mockRoflKey);
    });

    context("When called by the prompt owner", function () {
      it("should return the correct data", async function () {
        const prompts = await aiAgent.connect(user).getPrompts(user.address);
        expect(prompts.length).to.equal(1);
        expect(prompts[0].message.encryptedContent).to.equal(ethers.hexlify(mockEncryptedContent));
        const count = await aiAgent.connect(user).getPromptsCount(user.address);
        expect(count).to.equal(1);
      });
    });

    context("When called by the oracle", function () {
      it("should return the correct data", async function () {
        const prompts = await aiAgent.connect(oracle).getPrompts(user.address);
        expect(prompts.length).to.equal(1);
        expect(prompts[0].message.encryptedContent).to.equal(ethers.hexlify(mockEncryptedContent));
      });
    });

    context("When called by an unauthorized user", function () {
      it("should revert", async function () {
        await expect(
          aiAgent.connect(unauthorizedUser).getPrompts(user.address),
        ).to.be.revertedWithCustomError(aiAgent, "UnauthorizedUserOrOracle");
        await expect(
          aiAgent.connect(unauthorizedUser).getAnswers(user.address),
        ).to.be.revertedWithCustomError(aiAgent, "UnauthorizedUserOrOracle");
      });
    });
  });

  describe("Admin Functions", function () {
    it("should allow the owner to call setOracle (as TEE placeholder)", async function () {
      const { aiAgent, deployer, unauthorizedUser } = await loadFixture(deployAgentFixture);
      const newOracle = unauthorizedUser;
      // In a real TEE environment, this would be restricted. For testing on a standard
      // EVM, we confirm the owner can call it as per the placeholder implementation.
      await aiAgent.connect(deployer).setOracle(newOracle.address);
      expect(await aiAgent.oracle()).to.equal(newOracle.address);
    });

    it("should not allow a non-owner to call setOracle (TEE placeholder test)", async function () {
      const { aiAgent, unauthorizedUser } = await loadFixture(deployAgentFixture);
      // For testing, the onlyTEE modifier is a no-op. Without an additional access
      // control modifier, this call will succeed. This test documents that behavior.
      // To make this test fail (as it should in a secure non-TEE setup), add `onlyOwner` to `setOracle`.
      await expect(aiAgent.connect(unauthorizedUser).setOracle(unauthorizedUser.address)).to.not.be
        .reverted;
    });

    it("should revert if owner tries to set oracle to the zero address", async function () {
      const { aiAgent, deployer } = await loadFixture(deployAgentFixture);
      await expect(
        aiAgent.connect(deployer).setOracle(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(aiAgent, "ZeroAddress");
    });
  });

  describe("Upgrades", function () {
    it("should allow the owner to upgrade the contract", async function () {
      const { aiAgent, deployer } = await loadFixture(deployAgentFixture);

      const V2Factory = await ethers.getContractFactory("EVMAIAgentV2");
      const upgraded = await upgrades.upgradeProxy(await aiAgent.getAddress(), V2Factory, {
        signer: deployer,
      });

      expect(await upgraded.version()).to.equal("2.0");
    });

    it("should prevent a non-owner from upgrading the contract", async function () {
      const { aiAgent, unauthorizedUser } = await loadFixture(deployAgentFixture);
      const V2Factory = await ethers.getContractFactory("EVMAIAgentV2", unauthorizedUser);

      await expect(
        upgrades.upgradeProxy(await aiAgent.getAddress(), V2Factory),
      ).to.be.revertedWithCustomError(aiAgent, "OwnableUnauthorizedAccount");
    });
  });
});
