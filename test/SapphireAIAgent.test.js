const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("SapphireAIAgent", function () {
  // --- Test Suite Setup ---
  const domain = "example.com";
  const roflAppID = ethers.zeroPadBytes("0x", 21);
  const mockAuthToken = "0x"; // Mock authToken for view calls
  const PROMPT_TEXT = "What is the nature of consciousness?";
  const ANSWER_TEXT = "That is a complex philosophical question with no single answer.";

  // Deploys contracts and sets up the test environment.
  // This fixture is used by `loadFixture` to speed up tests.
  async function deployAgentFixture() {
    const [deployer, user, oracle, unauthorizedUser] = await ethers.getSigners();
    const SapphireAIAgent = await ethers.getContractFactory("SapphireAIAgent");
    const MockEscrowFactory = await ethers.getContractFactory("MockSapphireAIAgentEscrow");

    // Deploy the SapphireAIAgent, which is not upgradable.
    const aiAgent = await SapphireAIAgent.deploy(
      domain,
      roflAppID,
      oracle.address,
      deployer.address, // owner is deployer
    );
    await aiAgent.waitForDeployment();

    // Deploy the mock escrow with the real agent address
    const mockEscrow = await MockEscrowFactory.deploy(await aiAgent.getAddress());
    await mockEscrow.waitForDeployment();

    // Link the agent to the mock escrow.
    await aiAgent.connect(deployer).setAgentEscrow(await mockEscrow.getAddress());

    return { aiAgent, mockEscrow, deployer, user, oracle, unauthorizedUser, SapphireAIAgent };
  }

  // --- Test Cases ---

  describe("Constructor", function () {
    it("should set the correct initial state on deployment", async function () {
      const { aiAgent, mockEscrow, oracle, deployer } = await loadFixture(deployAgentFixture);
      expect(await aiAgent.oracle()).to.equal(oracle.address);
      expect(await aiAgent.domain()).to.equal(domain);
      expect(await aiAgent.roflAppID()).to.equal(roflAppID);
      expect(await aiAgent.owner()).to.equal(deployer.address);
      expect(await aiAgent.agentEscrow()).to.equal(await mockEscrow.getAddress());
    });

    it("should revert if deployed with a zero address for the owner", async function () {
      const { SapphireAIAgent, oracle } = await loadFixture(deployAgentFixture);
      await expect(
        SapphireAIAgent.deploy(domain, roflAppID, oracle.address, ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(SapphireAIAgent, "OwnableInvalidOwner");
    });

    it("should revert if deployed with a zero address for the oracle", async function () {
      const { SapphireAIAgent, deployer } = await loadFixture(deployAgentFixture);
      await expect(
        SapphireAIAgent.deploy(domain, roflAppID, ethers.ZeroAddress, deployer.address),
      ).to.be.revertedWithCustomError(SapphireAIAgent, "ZeroAddress");
    });
  });

  describe("Prompts", function () {
    it("should allow the AgentEscrow contract to submit a prompt", async function () {
      const { aiAgent, mockEscrow, deployer, user } = await loadFixture(deployAgentFixture);
      const promptId = await aiAgent.promptIdCounter();
      // The mock escrow (called by deployer) submits a prompt on behalf of the user.
      await expect(
        mockEscrow.connect(deployer).callSubmitPrompt(promptId, user.address, PROMPT_TEXT),
      )
        .to.emit(aiAgent, "PromptSubmitted")
        .withArgs(user.address, promptId);

      // The user can then retrieve their prompt.
      const prompts = await aiAgent.connect(user).getPrompts(mockAuthToken, user.address);
      expect(prompts.length).to.equal(1);
      expect(prompts[0].promptId).to.equal(promptId);
      expect(prompts[0].prompt).to.equal(PROMPT_TEXT);
    });

    it("should revert if called by an address other than the AgentEscrow contract", async function () {
      const { aiAgent, user } = await loadFixture(deployAgentFixture);
      const promptId = await aiAgent.promptIdCounter();
      // A random user tries to call submitPrompt directly. This must fail.
      await expect(
        aiAgent.connect(user).submitPrompt(promptId, user.address, PROMPT_TEXT),
      ).to.be.revertedWithCustomError(aiAgent, "NotAIAgentEscrow");
    });

    it("should revert if the provided promptId does not match the counter", async function () {
      const { aiAgent, mockEscrow, deployer, user } = await loadFixture(deployAgentFixture);
      const wrongPromptId = (await aiAgent.promptIdCounter()) + 1n; // Intentionally incorrect ID
      await expect(
        mockEscrow.connect(deployer).callSubmitPrompt(wrongPromptId, user.address, PROMPT_TEXT),
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
      // The mock escrow calls submitPrompt for the user.
      await mockEscrow.connect(deployer).callSubmitPrompt(promptId, user.address, "Test Prompt");
    });

    it("should allow the escrow contract to store a cancellation", async function () {
      const { aiAgent, mockEscrow, deployer, user } = await loadFixture(deployAgentFixture);
      const promptId = 0;
      await mockEscrow.connect(deployer).callSubmitPrompt(promptId, user.address, "Test Prompt");

      // Simulate the escrow contract calling storeCancellation.
      await mockEscrow.connect(deployer).callStoreCancellation(promptId, user.address);

      // Verify state changes
      expect(await aiAgent.isPromptAnswered(promptId)).to.be.true;

      const answers = await aiAgent.connect(user).getAnswers("0x", user.address);
      expect(answers.length).to.equal(1);
      expect(answers[0].promptId).to.equal(promptId);
      expect(answers[0].answer).to.equal("Prompt cancelled by user.");
    });

    it("should revert if an address other than the escrow contract calls storeCancellation", async function () {
      const { aiAgent, user } = await loadFixture(deployAgentFixture);
      await expect(
        aiAgent.connect(user).storeCancellation(0, user.address),
      ).to.be.revertedWithCustomError(aiAgent, "NotAIAgentEscrow");
    });

    it("should revert if trying to cancel a prompt that is already answered", async function () {
      const { aiAgent, mockEscrow, deployer, user, oracle } = await loadFixture(deployAgentFixture);
      const promptId = 0;
      await mockEscrow.connect(deployer).callSubmitPrompt(promptId, user.address, "Test Prompt");

      // First, the oracle submits a real answer for the correct user.
      await aiAgent.connect(oracle).submitAnswer("A real answer.", promptId, user.address);

      // Now, the escrow contract tries to store a cancellation for the same prompt.
      await expect(
        mockEscrow.connect(deployer).callStoreCancellation(promptId, user.address),
      ).to.be.revertedWithCustomError(aiAgent, "PromptAlreadyAnswered");
    });
  });

  describe("Answers", function () {
    let aiAgent, mockEscrow, user, oracle, unauthorizedUser;

    beforeEach(async function () {
      const fixtures = await loadFixture(deployAgentFixture);
      aiAgent = fixtures.aiAgent;
      mockEscrow = fixtures.mockEscrow;
      user = fixtures.user;
      oracle = fixtures.oracle;
      unauthorizedUser = fixtures.unauthorizedUser;

      // Setup a prompt for the user that can be answered.
      const promptId = await aiAgent.promptIdCounter();
      await fixtures.mockEscrow
        .connect(fixtures.deployer)
        .callSubmitPrompt(promptId, user.address, PROMPT_TEXT);
    });

    context("When called by the authorized oracle", function () {
      it("should successfully submit an answer and call the escrow contract", async function () {
        const aiAgentWithOracle = aiAgent.connect(oracle);
        const promptId = 0;

        await expect(aiAgentWithOracle.submitAnswer(ANSWER_TEXT, promptId, user.address)).to.not.be
          .reverted;

        const answers = await aiAgent.connect(user).getAnswers(mockAuthToken, user.address);
        expect(answers.length).to.equal(1);
        expect(answers[0].promptId).to.equal(promptId);
        expect(answers[0].answer).to.equal(ANSWER_TEXT);

        // Assert that the mock escrow was called correctly.
        expect(await mockEscrow.finalizePaymentCallCount()).to.equal(1);
        expect(await mockEscrow.lastFinalizedPromptId()).to.equal(promptId);
      });

      it("should revert if the promptId has already been answered", async function () {
        const aiAgentWithOracle = aiAgent.connect(oracle);
        await aiAgentWithOracle.submitAnswer(ANSWER_TEXT, 0, user.address);

        await expect(
          aiAgentWithOracle.submitAnswer("Second answer", 0, user.address),
        ).to.be.revertedWithCustomError(aiAgent, "PromptAlreadyAnswered");
      });

      it("should revert if the promptId is invalid (does not exist)", async function () {
        const aiAgentWithOracle = aiAgent.connect(oracle);
        const invalidPromptId = 99;
        await expect(
          aiAgentWithOracle.submitAnswer(
            "Answer to non-existent prompt",
            invalidPromptId,
            user.address,
          ),
        ).to.be.revertedWithCustomError(aiAgent, "InvalidPromptId");
      });
    });

    context("When called by an unauthorized user", function () {
      it("should revert", async function () {
        const aiAgentWithUnauthorized = aiAgent.connect(unauthorizedUser);
        await expect(
          aiAgentWithUnauthorized.submitAnswer(ANSWER_TEXT, 0, user.address),
        ).to.be.revertedWithCustomError(aiAgent, "UnauthorizedOracle");
      });
    });
  });

  describe("Clear prompts and answers", function () {
    it("should allow a user to clear their own prompts and answers", async function () {
      const { aiAgent, mockEscrow, deployer, user } = await loadFixture(deployAgentFixture);
      const promptId = await aiAgent.promptIdCounter();
      await mockEscrow.connect(deployer).callSubmitPrompt(promptId, user.address, PROMPT_TEXT);

      // The user clears their own data using their auth token.
      await aiAgent.connect(user).clearPrompt(mockAuthToken, user.address);

      const prompts = await aiAgent.connect(user).getPrompts(mockAuthToken, user.address);
      expect(prompts.length).to.equal(0);
    });

    it("should prevent a user from clearing another user's data", async function () {
      const { aiAgent, mockEscrow, deployer, user, unauthorizedUser } =
        await loadFixture(deployAgentFixture);
      await mockEscrow.connect(deployer).callSubmitPrompt(0, user.address, PROMPT_TEXT);

      // An unauthorized user tries to clear the data of the original user.
      await expect(
        aiAgent.connect(unauthorizedUser).clearPrompt(mockAuthToken, user.address),
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
      // Setup: Create a prompt for the user to view.
      await fixtures.mockEscrow
        .connect(fixtures.deployer)
        .callSubmitPrompt(0, user.address, PROMPT_TEXT);
    });

    context("When called by the prompt owner", function () {
      it("should return the correct data", async function () {
        const prompts = await aiAgent.connect(user).getPrompts(mockAuthToken, user.address);
        expect(prompts.length).to.equal(1);
        expect(prompts[0].prompt).to.equal(PROMPT_TEXT);

        const count = await aiAgent.connect(user).getPromptsCount(mockAuthToken, user.address);
        expect(count).to.equal(1);
      });
    });

    context("When called by the oracle", function () {
      it("should return the correct data", async function () {
        const prompts = await aiAgent.connect(oracle).getPrompts(mockAuthToken, user.address);
        expect(prompts.length).to.equal(1);
        expect(prompts[0].prompt).to.equal(PROMPT_TEXT);
      });
    });

    context("When called by an unauthorized user", function () {
      it("should revert", async function () {
        await expect(
          aiAgent.connect(unauthorizedUser).getPrompts(mockAuthToken, user.address),
        ).to.be.revertedWithCustomError(aiAgent, "UnauthorizedUserOrOracle");

        await expect(
          aiAgent.connect(unauthorizedUser).getAnswers(mockAuthToken, user.address),
        ).to.be.revertedWithCustomError(aiAgent, "UnauthorizedUserOrOracle");
      });
    });
  });

  describe("Admin Functions", function () {
    it("should revert if owner tries to set agent escrow a second time", async function () {
      const { aiAgent, deployer, mockEscrow } = await loadFixture(deployAgentFixture);
      // The escrow is already set in the fixture, so calling it again should fail.
      await expect(
        aiAgent.connect(deployer).setAgentEscrow(await mockEscrow.getAddress()),
      ).to.be.revertedWithCustomError(aiAgent, "AgentEscrowAlreadySet");
    });

    it("should revert if owner tries to set agent escrow to the zero address", async function () {
      const { SapphireAIAgent, deployer, oracle } = await loadFixture(deployAgentFixture);
      // Deploy a new agent instance that is not linked yet.
      const newAgent = await SapphireAIAgent.deploy(
        domain,
        roflAppID,
        oracle.address,
        deployer.address,
      );
      await newAgent.waitForDeployment();

      await expect(
        newAgent.connect(deployer).setAgentEscrow(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(newAgent, "ZeroAddress");
    });

    it("should revert when a non-TEE address tries to call setOracle", async function () {
      const { aiAgent, user } = await loadFixture(deployAgentFixture);
      // On a real Sapphire network, this would fail the `onlyTEE` check.
      // Hardhat simulates this by reverting. This test confirms the modifier is active.
      await expect(aiAgent.connect(user).setOracle(user.address)).to.be.reverted;
    });
  });
});
