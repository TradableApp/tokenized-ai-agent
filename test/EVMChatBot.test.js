// test/EVMChatBot.test.js
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("EVMChatBot", function () {
  // --- Test Suite Setup ---
  let EVMChatBot, chatBot;
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
    EVMChatBot = await ethers.getContractFactory("EVMChatBot");
    chatBot = await EVMChatBot.deploy(domain, roflAppID, oracle.address);
    await chatBot.waitForDeployment();
  });

  // --- Test Cases ---

  describe("Constructor", function () {
    it("should set the correct initial state on deployment", async function () {
      expect(await chatBot.oracle()).to.equal(oracle.address);
      expect(await chatBot.domain()).to.equal(domain);
      expect(await chatBot.roflAppID()).to.equal(roflAppID);
    });
  });

  describe("Prompts", function () {
    it("should allow a user to append a prompt with encrypted data", async function () {
      const chatBotWithUser = chatBot.connect(user);
      await chatBotWithUser.appendPrompt(mockEncryptedContent, mockUserKey, mockRoflKey);

      const prompts = await chatBotWithUser.getPrompts(user.address);
      expect(prompts.length).to.equal(1);
      expect(prompts[0].encryptedContent).to.equal(ethers.hexlify(mockEncryptedContent));
    });

    it("should allow a user to clear their prompts and answers", async function () {
      const chatBotWithUser = chatBot.connect(user);
      await chatBotWithUser.appendPrompt(mockEncryptedContent, mockUserKey, mockRoflKey);
      await chatBotWithUser.clearPrompt();

      const prompts = await chatBotWithUser.getPrompts(user.address);
      const answers = await chatBotWithUser.getAnswers(user.address);
      expect(prompts.length).to.equal(0);
      expect(answers.length).to.equal(0);
    });
  });

  describe("Answers", function () {
    beforeEach(async function () {
      // A prompt needs to exist before an answer can be submitted.
      await chatBot.connect(user).appendPrompt(mockEncryptedContent, mockUserKey, mockRoflKey);
    });

    context("When called by the authorized oracle", function () {
      it("should successfully submit an answer", async function () {
        const chatBotWithOracle = chatBot.connect(oracle);
        await chatBotWithOracle.submitAnswer(
          mockAnswerContent,
          mockUserKey,
          mockRoflKey,
          0,
          user.address,
        );
        const answers = await chatBot.connect(user).getAnswers(user.address);
        expect(answers.length).to.equal(1);
        expect(answers[0].promptId).to.equal(0);
        expect(answers[0].message.encryptedContent).to.equal(ethers.hexlify(mockAnswerContent));
      });

      it("should revert if the promptId has already been answered", async function () {
        const chatBotWithOracle = chatBot.connect(oracle);
        await chatBotWithOracle.submitAnswer(
          mockAnswerContent,
          mockUserKey,
          mockRoflKey,
          0,
          user.address,
        );
        await expect(
          chatBotWithOracle.submitAnswer(
            mockAnswerContent,
            mockUserKey,
            mockRoflKey,
            0,
            user.address,
          ),
        ).to.be.revertedWithCustomError(chatBot, "PromptAlreadyAnswered");
      });

      it("should revert if the promptId is invalid (out of bounds)", async function () {
        const chatBotWithOracle = chatBot.connect(oracle);
        await expect(
          chatBotWithOracle.submitAnswer(
            mockAnswerContent,
            mockUserKey,
            mockRoflKey,
            1,
            user.address,
          ),
        ).to.be.revertedWithCustomError(chatBot, "InvalidPromptId");
      });
    });

    context("When called by an unauthorized user", function () {
      it("should revert", async function () {
        const chatBotWithUnauthorized = chatBot.connect(unauthorizedUser);
        await expect(
          chatBotWithUnauthorized.submitAnswer(
            mockAnswerContent,
            mockUserKey,
            mockRoflKey,
            0,
            user.address,
          ),
        ).to.be.revertedWithCustomError(chatBot, "UnauthorizedOracle");
      });
    });
  });

  describe("View Functions (Access Control)", function () {
    beforeEach(async function () {
      await chatBot.connect(user).appendPrompt(mockEncryptedContent, mockUserKey, mockRoflKey);
    });

    context("When called by the prompt owner", function () {
      it("should return the correct data", async function () {
        const prompts = await chatBot.connect(user).getPrompts(user.address);
        expect(prompts.length).to.equal(1);
        const count = await chatBot.connect(user).getPromptsCount(user.address);
        expect(count).to.equal(1);
      });
    });

    context("When called by the oracle", function () {
      it("should return the correct data", async function () {
        const prompts = await chatBot.connect(oracle).getPrompts(user.address);
        expect(prompts.length).to.equal(1);
      });
    });

    context("When called by an unauthorized user", function () {
      it("should revert", async function () {
        await expect(
          chatBot.connect(unauthorizedUser).getPrompts(user.address),
        ).to.be.revertedWithCustomError(chatBot, "UnauthorizedUserOrOracle");
        await expect(
          chatBot.connect(unauthorizedUser).getAnswers(user.address),
        ).to.be.revertedWithCustomError(chatBot, "UnauthorizedUserOrOracle");
      });
    });
  });

  describe("Admin Functions", function () {
    it("should allow the owner to call setOracle (as TEE placeholder)", async function () {
      const newOracle = unauthorizedUser;
      // The `onlyTEE` modifier is a placeholder; for now we test that the owner can call it.
      await chatBot.connect(deployer).setOracle(newOracle.address);
      expect(await chatBot.oracle()).to.equal(newOracle.address);
    });
  });
});
