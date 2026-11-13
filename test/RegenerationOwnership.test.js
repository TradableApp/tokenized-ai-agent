const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

/**
 * Who may own a conversation id, whose prompt a regeneration may name, and which conversation
 * its answer belongs to.
 *
 * `submitRegenerationRequest` checked that the caller owned the conversation they named, but not
 * the prompt. Since message ids are shared by all conversations, a caller could name anyone's
 * prompt: that locked the owner out of regenerating it, and — because the answer was filed under
 * the PROMPT's conversation — put an answer the owner cannot decrypt into the owner's history.
 *
 * The same "filed under the prompt's conversation" rule misplaced a legitimate case. A branch
 * reuses the original conversation's message ids, so regenerating an inherited message inside a
 * branch names (branch, original prompt); the answer then landed in the original conversation
 * and never reached the branch the user was looking at.
 */
describe("Conversations and regenerations — who owns what, and where an answer goes", function () {
  const ALLOWANCE = ethers.parseEther("100");
  const PROMPT_FEE = ethers.parseEther("10");
  const CANCELLATION_FEE = ethers.parseEther("1");
  const METADATA_FEE = ethers.parseEther("0.5");
  const BRANCH_FEE = ethers.parseEther("2");
  const MOCK_CID = "QmXg9j4f8zYf8t7f8zYf8t7f8zYf8t7f8zYf8t7f8zYf8t7";
  const CID_BUNDLE = {
    conversationCID: MOCK_CID,
    metadataCID: MOCK_CID,
    promptMessageCID: MOCK_CID,
    answerMessageCID: MOCK_CID,
    searchDeltaCID: MOCK_CID,
  };
  // A regeneration answer carries no prompt CID; that is how the agent tells the two apart.
  const REGENERATION_BUNDLE = { ...CID_BUNDLE, conversationCID: "", promptMessageCID: "" };

  const parseEvent = (receipt, contract, name) => {
    const topic = contract.interface.getEvent(name).topicHash;
    const log = receipt.logs.find((l) => l.topics[0] === topic);
    if (!log) throw new Error(`${name} not found in the receipt — recompile?`);
    return contract.interface.parseLog(log);
  };

  // Each chain supplies deploy, funding and the calls whose signatures differ; the cases are shared.
  const chains = {
    EVM: {
      async deploy() {
        const [deployer, user, oracle, treasury, attacker] = await ethers.getSigners();
        const token = await (await ethers.getContractFactory("MockAbleToken")).deploy();
        await token.waitForDeployment();
        const aiAgent = await upgrades.deployProxy(
          await ethers.getContractFactory("EVMAIAgent"),
          ["example.com", oracle.address, deployer.address],
          { initializer: "initialize", kind: "uups" },
        );
        await aiAgent.waitForDeployment();
        const escrow = await upgrades.deployProxy(
          await ethers.getContractFactory("EVMAIAgentEscrow"),
          [
            await token.getAddress(),
            await aiAgent.getAddress(),
            treasury.address,
            deployer.address,
            PROMPT_FEE,
            CANCELLATION_FEE,
            METADATA_FEE,
            BRANCH_FEE,
          ],
          { initializer: "initialize", kind: "uups" },
        );
        await escrow.waitForDeployment();
        await aiAgent.connect(deployer).setAgentEscrow(await escrow.getAddress());
        for (const account of [user, attacker]) {
          await token.mint(account.address, ALLOWANCE);
          await token.connect(account).approve(await escrow.getAddress(), ALLOWANCE);
          await escrow.connect(account).setSpendingLimit(ALLOWANCE, (await time.latest()) + 100000);
        }
        return { aiAgent, escrow, user, oracle, attacker };
      },
      prompt: (escrow, account, conversationId = 0) =>
        escrow.connect(account).initiatePrompt(conversationId, "0x", "0x"),
      regenerate: (escrow, account, conversationId, promptId, answerId) =>
        escrow
          .connect(account)
          .initiateRegeneration(conversationId, promptId, answerId, "0x", "0x"),
      branch: (escrow, account, conversationId, branchPointId) =>
        escrow.connect(account).initiateBranch(conversationId, branchPointId, "0x", "0x"),
      promptPayloadMatchers: ["0x", "0x"],
      async deployAgent(deployer, oracle) {
        const aiAgent = await upgrades.deployProxy(
          await ethers.getContractFactory("EVMAIAgent"),
          ["example.com", oracle.address, deployer.address],
          { initializer: "initialize", kind: "uups" },
        );
        await aiAgent.waitForDeployment();
        return aiAgent;
      },
      // The agent's own entry points, called as the escrow would call them.
      promptRequest: (aiAgent, userAddress, conversationId, promptId, answerId) =>
        aiAgent.submitPrompt(userAddress, conversationId, promptId, answerId, "0x", "0x"),
      branchRequest: (aiAgent, userAddress, conversationId, branchPointId, newConversationId) =>
        aiAgent.submitBranchRequest(
          userAddress,
          conversationId,
          branchPointId,
          newConversationId,
          "0x",
          "0x",
        ),
    },
    Sapphire: {
      async deploy() {
        const [deployer, user, oracle, treasury, attacker] = await ethers.getSigners();
        const aiAgent = await (
          await ethers.getContractFactory("SapphireAIAgent")
        ).deploy("example.com", ethers.zeroPadBytes("0x00", 21), oracle.address, deployer.address);
        await aiAgent.waitForDeployment();
        const escrow = await (
          await ethers.getContractFactory("SapphireAIAgentEscrow")
        ).deploy(
          await aiAgent.getAddress(),
          treasury.address,
          deployer.address,
          PROMPT_FEE,
          CANCELLATION_FEE,
          METADATA_FEE,
          BRANCH_FEE,
        );
        await escrow.waitForDeployment();
        await aiAgent.connect(deployer).setAgentEscrow(await escrow.getAddress());
        for (const account of [user, attacker]) {
          await escrow.connect(account).deposit({ value: ALLOWANCE });
          await escrow.connect(account).setSpendingLimit((await time.latest()) + 100000);
        }
        return { aiAgent, escrow, user, oracle, attacker };
      },
      prompt: (escrow, account, conversationId = 0) =>
        escrow.connect(account).initiatePrompt(conversationId, "payload"),
      regenerate: (escrow, account, conversationId, promptId, answerId) =>
        escrow.connect(account).initiateRegeneration(conversationId, promptId, answerId, "payload"),
      branch: (escrow, account, conversationId, branchPointId) =>
        escrow.connect(account).initiateBranch(conversationId, branchPointId, "payload"),
      promptPayloadMatchers: ["payload"],
      async deployAgent(deployer, oracle) {
        const aiAgent = await (
          await ethers.getContractFactory("SapphireAIAgent")
        ).deploy("example.com", ethers.zeroPadBytes("0x00", 21), oracle.address, deployer.address);
        await aiAgent.waitForDeployment();
        return aiAgent;
      },
      promptRequest: (aiAgent, userAddress, conversationId, promptId, answerId) =>
        aiAgent.submitPrompt(userAddress, conversationId, promptId, answerId, "payload"),
      branchRequest: (aiAgent, userAddress, conversationId, branchPointId, newConversationId) =>
        aiAgent.submitBranchRequest(
          userAddress,
          conversationId,
          branchPointId,
          newConversationId,
          "payload",
        ),
    },
  };

  for (const [chainName, chain] of Object.entries(chains)) {
    describe(chainName, function () {
      // One answered prompt for an account, in a new conversation.
      async function answeredPrompt({ aiAgent, escrow, oracle }, account) {
        const receipt = await (await chain.prompt(escrow, account)).wait();
        const { conversationId, promptMessageId, answerMessageId } = parseEvent(
          receipt,
          aiAgent,
          "PromptSubmitted",
        ).args;
        await aiAgent.connect(oracle).submitAnswer(promptMessageId, answerMessageId, CID_BUNDLE);
        return { conversationId, promptMessageId, answerMessageId };
      }

      // The victim and the attacker each own one conversation with one answered prompt.
      async function twoUsersFixture() {
        const deployed = await chain.deploy();
        const victim = await answeredPrompt(deployed, deployed.user);
        const own = await answeredPrompt(deployed, deployed.attacker);
        return { ...deployed, victim, own };
      }

      // A user with an answered prompt, and a branch of that conversation taken at its answer.
      async function branchFixture() {
        const deployed = await chain.deploy();
        const { aiAgent, escrow, user } = deployed;
        const original = await answeredPrompt(deployed, user);
        const receipt = await (
          await chain.branch(escrow, user, original.conversationId, original.answerMessageId)
        ).wait();
        const branchConversationId = parseEvent(receipt, aiAgent, "BranchRequested").args
          .newConversationId;
        return { ...deployed, original, branchConversationId };
      }

      describe("another user's prompt", function () {
        it("refuses a regeneration that names a prompt the caller does not own", async function () {
          const { aiAgent, escrow, attacker, victim, own } = await loadFixture(twoUsersFixture);

          await expect(
            chain.regenerate(
              escrow,
              attacker,
              own.conversationId,
              victim.promptMessageId,
              victim.answerMessageId,
            ),
          ).to.be.revertedWithCustomError(aiAgent, "Unauthorized");
        });

        it("leaves the owner free to regenerate their prompt after such an attempt", async function () {
          const { aiAgent, escrow, user, attacker, victim, own } =
            await loadFixture(twoUsersFixture);
          await chain
            .regenerate(
              escrow,
              attacker,
              own.conversationId,
              victim.promptMessageId,
              victim.answerMessageId,
            )
            .catch(() => {});

          expect(await aiAgent.isRegenerationPending(victim.promptMessageId)).to.equal(false);
          await expect(
            chain.regenerate(
              escrow,
              user,
              victim.conversationId,
              victim.promptMessageId,
              victim.answerMessageId,
            ),
          ).to.not.be.reverted;
        });

        it("takes no fee for the refused regeneration", async function () {
          const { escrow, attacker, victim, own } = await loadFixture(twoUsersFixture);
          const before = await escrow.pendingEscrowCount(attacker.address);

          await chain
            .regenerate(
              escrow,
              attacker,
              own.conversationId,
              victim.promptMessageId,
              victim.answerMessageId,
            )
            .catch(() => {});

          expect(await escrow.pendingEscrowCount(attacker.address)).to.equal(before);
        });

        it("refuses a regeneration that names a message id nobody has used", async function () {
          const { aiAgent, escrow, attacker, own } = await loadFixture(twoUsersFixture);

          await expect(
            chain.regenerate(escrow, attacker, own.conversationId, 999999, own.answerMessageId),
          ).to.be.revertedWithCustomError(aiAgent, "Unauthorized");
        });

        it("still refuses a conversation the caller does not own", async function () {
          const { aiAgent, escrow, attacker, victim } = await loadFixture(twoUsersFixture);

          await expect(
            chain.regenerate(
              escrow,
              attacker,
              victim.conversationId,
              victim.promptMessageId,
              victim.answerMessageId,
            ),
          ).to.be.revertedWithCustomError(aiAgent, "Unauthorized");
        });
      });

      describe("who may own a conversation id", function () {
        // A conversation id is handed out by the agent's counter. Naming one that has not been
        // handed out yet must not make the caller its owner: the next new conversation is given
        // that same id, finds it owned by someone else and reverts — for every user, for good.
        it("refuses a prompt that names a conversation id not handed out yet", async function () {
          const { aiAgent, escrow, attacker } = await loadFixture(twoUsersFixture);
          const next = await aiAgent.conversationIdCounter();

          await expect(chain.prompt(escrow, attacker, next)).to.be.revertedWithCustomError(
            aiAgent,
            "Unauthorized",
          );
          await expect(chain.prompt(escrow, attacker, next + 100n)).to.be.revertedWithCustomError(
            aiAgent,
            "Unauthorized",
          );
        });

        it("keeps new conversations working for everyone after such an attempt", async function () {
          const { aiAgent, escrow, user, attacker } = await loadFixture(twoUsersFixture);
          const next = await aiAgent.conversationIdCounter();
          await chain.prompt(escrow, attacker, next).catch(() => {});

          await expect(chain.prompt(escrow, user))
            .to.emit(aiAgent, "PromptSubmitted")
            .withArgs(user.address, next, anyValue, anyValue, ...chain.promptPayloadMatchers);
          expect(await aiAgent.conversationToOwner(next)).to.equal(user.address);
        });

        it("still lets an owner prompt again in their own conversation", async function () {
          const { escrow, user, victim } = await loadFixture(twoUsersFixture);

          await expect(chain.prompt(escrow, user, victim.conversationId)).to.not.be.reverted;
        });

        it("still refuses a prompt in someone else's conversation", async function () {
          const { aiAgent, escrow, attacker, victim } = await loadFixture(twoUsersFixture);

          await expect(
            chain.prompt(escrow, attacker, victim.conversationId),
          ).to.be.revertedWithCustomError(aiAgent, "Unauthorized");
        });

        it("never hands a branch a conversation id that already has an owner", async function () {
          // Cannot be reached through the escrow once ids are only claimed by reservation, but a
          // proxy upgraded from before that rule may hold ids claimed ahead of the counter. The
          // agent must refuse to overwrite their owner rather than rely on the escrow. So this
          // drives the agent directly, with a signer standing in for the escrow.
          const [deployer, user, oracle, , attacker] = await ethers.getSigners();
          const aiAgent = await chain.deployAgent(deployer, oracle);
          await aiAgent.connect(deployer).setAgentEscrow(deployer.address);
          const asEscrow = aiAgent.connect(deployer);
          // Hand out ids 1 and 2, as the escrow does before each new conversation.
          await asEscrow.reserveConversationId();
          await asEscrow.reserveConversationId();
          await chain.promptRequest(asEscrow, user.address, 1, 0, 1);
          await chain.promptRequest(asEscrow, attacker.address, 2, 2, 3);

          await expect(
            chain.branchRequest(asEscrow, user.address, 1, 0, 2),
          ).to.be.revertedWithCustomError(aiAgent, "Unauthorized");
          expect(await aiAgent.conversationToOwner(2)).to.equal(attacker.address);
        });
      });

      describe("where a regeneration's answer is filed", function () {
        it("files an ordinary regeneration under the prompt's own conversation", async function () {
          const { aiAgent, escrow, user, oracle, original } = await loadFixture(branchFixture);
          const receipt = await (
            await chain.regenerate(
              escrow,
              user,
              original.conversationId,
              original.promptMessageId,
              original.answerMessageId,
            )
          ).wait();
          const regenAnswerId = parseEvent(receipt, escrow, "PaymentEscrowed").args[0];

          await expect(
            aiAgent
              .connect(oracle)
              .submitAnswer(original.promptMessageId, regenAnswerId, REGENERATION_BUNDLE),
          )
            .to.emit(aiAgent, "AnswerMessageAdded")
            .withArgs(original.conversationId, regenAnswerId, MOCK_CID);
        });

        it("allows regenerating an inherited prompt from inside a branch", async function () {
          const { escrow, user, original, branchConversationId } = await loadFixture(branchFixture);

          await expect(
            chain.regenerate(
              escrow,
              user,
              branchConversationId,
              original.promptMessageId,
              original.answerMessageId,
            ),
          ).to.not.be.reverted;
        });

        it("files a regeneration made inside a branch under the branch", async function () {
          const { aiAgent, escrow, user, oracle, original, branchConversationId } =
            await loadFixture(branchFixture);
          const receipt = await (
            await chain.regenerate(
              escrow,
              user,
              branchConversationId,
              original.promptMessageId,
              original.answerMessageId,
            )
          ).wait();
          const regenAnswerId = parseEvent(receipt, escrow, "PaymentEscrowed").args[0];

          await expect(
            aiAgent
              .connect(oracle)
              .submitAnswer(original.promptMessageId, regenAnswerId, REGENERATION_BUNDLE),
          )
            .to.emit(aiAgent, "AnswerMessageAdded")
            .withArgs(branchConversationId, regenAnswerId, MOCK_CID);
          expect(await aiAgent.messageToConversation(regenAnswerId)).to.equal(branchConversationId);
        });

        it("releases the prompt's lock when the branch regeneration is answered", async function () {
          const { aiAgent, escrow, user, oracle, original, branchConversationId } =
            await loadFixture(branchFixture);
          const receipt = await (
            await chain.regenerate(
              escrow,
              user,
              branchConversationId,
              original.promptMessageId,
              original.answerMessageId,
            )
          ).wait();
          const regenAnswerId = parseEvent(receipt, escrow, "PaymentEscrowed").args[0];

          await aiAgent
            .connect(oracle)
            .submitAnswer(original.promptMessageId, regenAnswerId, REGENERATION_BUNDLE);

          expect(await aiAgent.isRegenerationPending(original.promptMessageId)).to.equal(false);
        });

        it("lets a regenerated answer inside a branch be regenerated again there", async function () {
          const { aiAgent, escrow, user, oracle, original, branchConversationId } =
            await loadFixture(branchFixture);
          const first = await (
            await chain.regenerate(
              escrow,
              user,
              branchConversationId,
              original.promptMessageId,
              original.answerMessageId,
            )
          ).wait();
          const firstAnswerId = parseEvent(first, escrow, "PaymentEscrowed").args[0];
          await aiAgent
            .connect(oracle)
            .submitAnswer(original.promptMessageId, firstAnswerId, REGENERATION_BUNDLE);

          await expect(
            chain.regenerate(
              escrow,
              user,
              branchConversationId,
              original.promptMessageId,
              firstAnswerId,
            ),
          ).to.not.be.reverted;
        });

        it("still files a first answer under the conversation of its prompt", async function () {
          const { aiAgent, escrow, user, oracle, branchConversationId } =
            await loadFixture(branchFixture);
          const receipt = await (await chain.prompt(escrow, user, branchConversationId)).wait();
          const { promptMessageId, answerMessageId } = parseEvent(
            receipt,
            aiAgent,
            "PromptSubmitted",
          ).args;

          await expect(
            aiAgent.connect(oracle).submitAnswer(promptMessageId, answerMessageId, CID_BUNDLE),
          )
            .to.emit(aiAgent, "AnswerMessageAdded")
            .withArgs(branchConversationId, answerMessageId, MOCK_CID);
        });
      });
    });
  }
});
