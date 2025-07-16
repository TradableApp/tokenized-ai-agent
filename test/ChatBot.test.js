const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ChatBot", function () {
  let ChatBot, chatBot;
  let deployer, user, oracle;
  const domain = "example.com";
  const roflAppID = ethers.zeroPadValue("0x0", 21); // bytes21

  beforeEach(async function () {
    [deployer, user, oracle, unauthorizedUser] = await ethers.getSigners();
    ChatBot = await ethers.getContractFactory("ChatBot");
    chatBot = await ChatBot.deploy(domain, roflAppID, oracle.address);
    await chatBot.waitForDeployment();
  });

  it("should append a prompt", async function () {
    const chatBotWithUser = chatBot.connect(user);
    await chatBotWithUser.appendPrompt("Hello");

    const prompts = await chatBotWithUser.getPrompts("0x", user.address);
    expect(prompts.length).to.equal(1);
    expect(prompts[0]).to.equal("Hello");
  });

  it("should clear prompts and answers", async function () {
    const chatBotWithUser = chatBot.connect(user);
    await chatBotWithUser.appendPrompt("Hello");
    await chatBotWithUser.clearPrompt();

    const prompts = await chatBotWithUser.getPrompts("0x", user.address);
    const answers = await chatBotWithUser.getAnswers("0x", user.address);
    expect(prompts.length).to.equal(0);
    expect(answers.length).to.equal(0);
  });

  it("should submit an answer and reject duplicate answer", async function () {
    const chatBotWithUser = chatBot.connect(user);
    await chatBotWithUser.appendPrompt("Hello");

    const chatBotWithOracle = chatBot.connect(oracle);
    await chatBotWithOracle.submitAnswer("Test answer", 0, user.address);

    const answers = await chatBotWithUser.getAnswers("0x", user.address);
    expect(answers.length).to.equal(1);
    expect(answers[0].answer).to.equal("Test answer");
    expect(answers[0].promptId).to.equal(0);

    await expect(
      chatBotWithOracle.submitAnswer("Test answer too late", 0, user.address),
    ).to.be.revertedWithCustomError(chatBot, "PromptAlreadyAnswered");
  });

  it("should revert unauthorized prompt access", async function () {
    await expect(
      chatBot.connect(unauthorizedUser).getPrompts("0x", user.address),
    ).to.be.revertedWithCustomError(chatBot, "UnauthorizedUserOrOracle");
  });
});
