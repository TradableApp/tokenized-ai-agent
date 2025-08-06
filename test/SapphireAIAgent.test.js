const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("SapphireAIAgent", function () {
  // --- Test Suite Setup ---
  let SapphireAIAgent, aiAgent;
  let deployer, user, oracle, unauthorizedUser;

  const domain = "example.com";
  const roflAppID = ethers.zeroPadBytes("0x", 21);

  // Deploy a fresh contract before each test.
  beforeEach(async function () {
    [deployer, user, oracle, unauthorizedUser] = await ethers.getSigners();
    SapphireAIAgent = await ethers.getContractFactory("SapphireAIAgent");
    aiAgent = await SapphireAIAgent.deploy(domain, roflAppID, oracle.address);
    await aiAgent.waitForDeployment();
  });

  // --- Test Cases ---

  describe("Constructor", function () {
    it("should set the correct initial state on deployment", async function () {
      expect(await aiAgent.oracle()).to.equal(oracle.address);
      expect(await aiAgent.domain()).to.equal(domain);
      expect(await aiAgent.roflAppID()).to.equal(roflAppID);
    });
  });

  describe("Prompts", function () {
    it("should allow a user to append a prompt and emit an event with the correct promptId", async function () {
      const aiAgentWithUser = aiAgent.connect(user);
      await expect(aiAgentWithUser.appendPrompt("Hello"))
        .to.emit(aiAgent, "PromptSubmitted")
        .withArgs(user.address, 0);

      const prompts = await aiAgentWithUser.getPrompts("0x", user.address);
      expect(prompts.length).to.equal(1);
      expect(prompts[0].promptId).to.equal(0);
      expect(prompts[0].prompt).to.equal("Hello");
    });

    it("should allow a user to clear their prompts and answers", async function () {
      const aiAgentWithUser = aiAgent.connect(user);
      await aiAgentWithUser.appendPrompt("Hello");
      await aiAgentWithUser.clearPrompt();

      const prompts = await aiAgentWithUser.getPrompts("0x", user.address);
      const answers = await aiAgentWithUser.getAnswers("0x", user.address);
      expect(prompts.length).to.equal(0);
      expect(answers.length).to.equal(0);
    });
  });

  describe("Answers", function () {
    beforeEach(async function () {
      // Create prompt with ID 0.
      await aiAgent.connect(user).appendPrompt("Hello");
    });

    context("When called by the authorized oracle", function () {
      it("should successfully submit an answer and emit an event", async function () {
        const aiAgentWithOracle = aiAgent.connect(oracle);
        await expect(aiAgentWithOracle.submitAnswer("Test answer", 0, user.address))
          .to.emit(aiAgent, "AnswerSubmitted")
          .withArgs(user.address, 0);

        const answers = await aiAgent.connect(user).getAnswers("0x", user.address);
        expect(answers.length).to.equal(1);
        expect(answers[0].answer).to.equal("Test answer");
        expect(answers[0].promptId).to.equal(0);
      });

      it("should revert if the promptId has already been answered", async function () {
        const aiAgentWithOracle = aiAgent.connect(oracle);
        await aiAgentWithOracle.submitAnswer("First answer", 0, user.address);

        await expect(
          aiAgentWithOracle.submitAnswer("Second answer", 0, user.address),
        ).to.be.revertedWithCustomError(aiAgent, "PromptAlreadyAnswered");
      });

      it("should revert if the promptId is invalid (does not exist)", async function () {
        const aiAgentWithOracle = aiAgent.connect(oracle);
        await expect(
          aiAgentWithOracle.submitAnswer("Answer to non-existent prompt", 1, user.address),
        ).to.be.revertedWithCustomError(aiAgent, "InvalidPromptId");
      });
    });

    context("When called by an unauthorized user", function () {
      it("should revert", async function () {
        const aiAgentWithUnauthorized = aiAgent.connect(unauthorizedUser);
        await expect(
          aiAgentWithUnauthorized.submitAnswer("Unauthorized answer", 0, user.address),
        ).to.be.revertedWithCustomError(aiAgent, "UnauthorizedOracle");
      });
    });
  });

  describe("View Functions (Access Control)", function () {
    beforeEach(async function () {
      await aiAgent.connect(user).appendPrompt("Prompt 1");
    });

    context("When called by the prompt owner", function () {
      it("should return the correct data", async function () {
        const prompts = await aiAgent.connect(user).getPrompts("0x", user.address);
        expect(prompts.length).to.equal(1);
        expect(prompts[0].prompt).to.equal("Prompt 1");

        const count = await aiAgent.connect(user).getPromptsCount("0x", user.address);
        expect(count).to.equal(1);
      });
    });

    context("When called by the oracle", function () {
      it("should return the correct data", async function () {
        const prompts = await aiAgent.connect(oracle).getPrompts("0x", user.address);
        expect(prompts.length).to.equal(1);
        expect(prompts[0].prompt).to.equal("Prompt 1");
      });
    });

    context("When called by an unauthorized user", function () {
      it("should revert", async function () {
        await expect(
          aiAgent.connect(unauthorizedUser).getPrompts("0x", user.address),
        ).to.be.revertedWithCustomError(aiAgent, "UnauthorizedUserOrOracle");
      });
    });
  });

  describe("Admin Functions", function () {
    it("should revert when a non-TEE address tries to call setOracle", async function () {
      await expect(aiAgent.connect(user).setOracle(user.address)).to.be.reverted;
    });
  });
});
