const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("SapphireChatBot", function () {
  // --- Test Suite Setup ---
  let SapphireChatBot, chatBot;
  let deployer, user, oracle, unauthorizedUser;

  const domain = "example.com";
  const roflAppID = ethers.zeroPadBytes("0x", 21);

  // Deploy a fresh contract before each test.
  beforeEach(async function () {
    [deployer, user, oracle, unauthorizedUser] = await ethers.getSigners();
    SapphireChatBot = await ethers.getContractFactory("SapphireChatBot");
    chatBot = await SapphireChatBot.deploy(domain, roflAppID, oracle.address);
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
    it("should allow a user to append a prompt", async function () {
      const chatBotWithUser = chatBot.connect(user);
      await chatBotWithUser.appendPrompt("Hello");

      const prompts = await chatBotWithUser.getPrompts("0x", user.address);
      expect(prompts.length).to.equal(1);
      expect(prompts[0]).to.equal("Hello");
    });

    it("should allow a user to clear their prompts and answers", async function () {
      const chatBotWithUser = chatBot.connect(user);
      await chatBotWithUser.appendPrompt("Hello");
      await chatBotWithUser.clearPrompt();

      const prompts = await chatBotWithUser.getPrompts("0x", user.address);
      const answers = await chatBotWithUser.getAnswers("0x", user.address);
      expect(prompts.length).to.equal(0);
      expect(answers.length).to.equal(0);
    });
  });

  describe("Answers", function () {
    beforeEach(async function () {
      // A prompt needs to exist before an answer can be submitted.
      await chatBot.connect(user).appendPrompt("Hello");
    });

    context("When called by the authorized oracle", function () {
      it("should successfully submit an answer", async function () {
        const chatBotWithOracle = chatBot.connect(oracle);
        await chatBotWithOracle.submitAnswer("Test answer", 0, user.address);

        const answers = await chatBot.connect(user).getAnswers("0x", user.address);
        expect(answers.length).to.equal(1);
        expect(answers[0].answer).to.equal("Test answer");
        expect(answers[0].promptId).to.equal(0);
      });

      it("should revert if the promptId has already been answered", async function () {
        const chatBotWithOracle = chatBot.connect(oracle);
        await chatBotWithOracle.submitAnswer("First answer", 0, user.address);

        await expect(
          chatBotWithOracle.submitAnswer("Second answer", 0, user.address),
        ).to.be.revertedWithCustomError(chatBot, "PromptAlreadyAnswered");
      });

      it("should revert if the promptId is invalid (out of bounds)", async function () {
        const chatBotWithOracle = chatBot.connect(oracle);
        await expect(
          chatBotWithOracle.submitAnswer("Answer to non-existent prompt", 1, user.address),
        ).to.be.revertedWithCustomError(chatBot, "InvalidPromptId");
      });
    });

    context("When called by an unauthorized user", function () {
      it("should revert", async function () {
        const chatBotWithUnauthorized = chatBot.connect(unauthorizedUser);
        await expect(
          chatBotWithUnauthorized.submitAnswer("Unauthorized answer", 0, user.address),
        ).to.be.revertedWithCustomError(chatBot, "UnauthorizedOracle");
      });
    });
  });

  describe("View Functions (Access Control)", function () {
    beforeEach(async function () {
      await chatBot.connect(user).appendPrompt("Prompt 1");
    });

    context("When called by the prompt owner", function () {
      it("should return the correct data", async function () {
        const prompts = await chatBot.connect(user).getPrompts("0x", user.address);
        expect(prompts.length).to.equal(1);
        expect(prompts[0]).to.equal("Prompt 1");

        const count = await chatBot.connect(user).getPromptsCount("0x", user.address);
        expect(count).to.equal(1);
      });
    });

    context("When called by the oracle", function () {
      it("should return the correct data", async function () {
        const prompts = await chatBot.connect(oracle).getPrompts("0x", user.address);
        expect(prompts.length).to.equal(1);
      });
    });

    context("When called by an unauthorized user", function () {
      it("should revert", async function () {
        await expect(
          chatBot.connect(unauthorizedUser).getPrompts("0x", user.address),
        ).to.be.revertedWithCustomError(chatBot, "UnauthorizedUserOrOracle");
      });
    });
  });

  describe("Admin Functions", function () {
    it("should revert when a non-TEE address tries to call setOracle", async function () {
      await expect(chatBot.connect(user).setOracle(user.address)).to.be.reverted;
    });
  });
});
