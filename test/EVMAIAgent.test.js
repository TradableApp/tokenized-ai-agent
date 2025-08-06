const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("EVMAIAgent", function () {
  // --- Test Suite Setup ---
  let EVMAIAgent, aiAgent;
  let deployer, user, oracle, unauthorizedUser;

  const domain = "example.com";
  const roflAppID = ethers.zeroPadBytes("0x", 21);
  const mockEncryptedContent = ethers.toUtf8Bytes("encrypted-prompt-content");
  const mockUserKey = ethers.toUtf8Bytes("user-encrypted-key");
  const mockRoflKey = ethers.toUtf8Bytes("rofl-encrypted-key");
  const mockAnswerContent = ethers.toUtf8Bytes("encrypted-answer-content");

  // Deploy a fresh contract before each test.
  beforeEach(async function () {
    [deployer, user, oracle, unauthorizedUser] = await ethers.getSigners();
    EVMAIAgent = await ethers.getContractFactory("EVMAIAgent");
    aiAgent = await EVMAIAgent.deploy(domain, roflAppID, oracle.address);
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
      // The first prompt should have promptId 0.
      await expect(aiAgentWithUser.appendPrompt(mockEncryptedContent, mockUserKey, mockRoflKey))
        .to.emit(aiAgent, "PromptSubmitted")
        .withArgs(user.address, 0);

      const prompts = await aiAgentWithUser.getPrompts(user.address);
      expect(prompts.length).to.equal(1);
      expect(prompts[0].promptId).to.equal(0);
      expect(prompts[0].message.encryptedContent).to.equal(ethers.hexlify(mockEncryptedContent));
    });

    it("should allow a user to clear their prompts and answers", async function () {
      const aiAgentWithUser = aiAgent.connect(user);
      await aiAgentWithUser.appendPrompt(mockEncryptedContent, mockUserKey, mockRoflKey);
      await aiAgentWithUser.clearPrompt();

      const prompts = await aiAgentWithUser.getPrompts(user.address);
      const answers = await aiAgentWithUser.getAnswers(user.address);
      expect(prompts.length).to.equal(0);
      expect(answers.length).to.equal(0);
    });
  });

  describe("Answers", function () {
    beforeEach(async function () {
      // Create prompt with ID 0.
      await aiAgent.connect(user).appendPrompt(mockEncryptedContent, mockUserKey, mockRoflKey);
    });

    context("When called by the authorized oracle", function () {
      it("should successfully submit an answer and emit an event", async function () {
        const aiAgentWithOracle = aiAgent.connect(oracle);
        await expect(
          aiAgentWithOracle.submitAnswer(
            mockAnswerContent,
            mockUserKey,
            mockRoflKey,
            0,
            user.address,
          ),
        )
          .to.emit(aiAgent, "AnswerSubmitted")
          .withArgs(user.address, 0);

        const answers = await aiAgent.connect(user).getAnswers(user.address);
        expect(answers.length).to.equal(1);
        expect(answers[0].promptId).to.equal(0);
        expect(answers[0].message.encryptedContent).to.equal(ethers.hexlify(mockAnswerContent));
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
            1,
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

  describe("View Functions (Access Control)", function () {
    beforeEach(async function () {
      await aiAgent.connect(user).appendPrompt(mockEncryptedContent, mockUserKey, mockRoflKey);
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
      const newOracle = unauthorizedUser;
      // The `onlyTEE` modifier is a placeholder; for now we test that the owner can call it.
      await aiAgent.connect(deployer).setOracle(newOracle.address);
      expect(await aiAgent.oracle()).to.equal(newOracle.address);
    });
  });
});
