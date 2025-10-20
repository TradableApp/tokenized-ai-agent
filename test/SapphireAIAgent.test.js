const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("SapphireAIAgent", function () {
  // --- Test Suite Setup ---
  const domain = "example.com";
  const roflAppID = ethers.zeroPadBytes("0x1234", 21);
  const MOCK_CID = "QmXg9j4f8zYf8t7f8zYf8t7f8zYf8t7f8zYf8t7f8zYf8t7";
  const MOCK_PAYLOAD = "This is a confidential payload.";

  // Deploys contracts and sets up the test environment.
  async function deployAgentFixture() {
    const [deployer, user, oracle, unauthorizedUser] = await ethers.getSigners();
    const SapphireAIAgent = await ethers.getContractFactory("SapphireAIAgent");
    const MockEscrowFactory = await ethers.getContractFactory("MockSapphireAIAgentEscrow");

    const aiAgent = await SapphireAIAgent.deploy(
      domain,
      roflAppID,
      oracle.address,
      deployer.address,
    );
    await aiAgent.waitForDeployment();

    const mockEscrow = await MockEscrowFactory.deploy(await aiAgent.getAddress());
    await mockEscrow.waitForDeployment();

    await aiAgent.connect(deployer).setAgentEscrow(await mockEscrow.getAddress());

    return { aiAgent, mockEscrow, deployer, user, oracle, unauthorizedUser, SapphireAIAgent };
  }

  describe("Initialization and Admin", function () {
    it("should set the correct initial state on deployment", async function () {
      const { aiAgent, mockEscrow, oracle, deployer } = await loadFixture(deployAgentFixture);
      expect(await aiAgent.oracle()).to.equal(oracle.address);
      expect(await aiAgent.domain()).to.equal(domain);
      expect(await aiAgent.roflAppID()).to.equal(roflAppID);
      expect(await aiAgent.aiAgentEscrow()).to.equal(await mockEscrow.getAddress());
      expect(await aiAgent.owner()).to.equal(deployer.address);
      expect(await aiAgent.conversationIdCounter()).to.equal(1);
      expect(await aiAgent.jobIdCounter()).to.equal(1);
    });

    context("Administrative Functions", function () {
      it("should revert if constructor is called with a zero address for oracle", async function () {
        const { deployer, SapphireAIAgent } = await loadFixture(deployAgentFixture);
        await expect(
          SapphireAIAgent.deploy(domain, roflAppID, ethers.ZeroAddress, deployer.address),
        ).to.be.revertedWithCustomError(SapphireAIAgent, "ZeroAddress");
      });

      it("should prevent a non-owner from setting the escrow address", async function () {
        const { aiAgent, unauthorizedUser, mockEscrow } = await loadFixture(deployAgentFixture);
        await expect(
          aiAgent.connect(unauthorizedUser).setAgentEscrow(await mockEscrow.getAddress()),
        ).to.be.revertedWithCustomError(aiAgent, "OwnableUnauthorizedAccount");
      });

      it("should revert if setting the escrow address to the zero address", async function () {
        const { deployer, oracle, SapphireAIAgent } = await loadFixture(deployAgentFixture);
        const freshAgent = await SapphireAIAgent.deploy(
          domain,
          roflAppID,
          oracle.address,
          deployer.address,
        );
        await expect(
          freshAgent.connect(deployer).setAgentEscrow(ethers.ZeroAddress),
        ).to.be.revertedWithCustomError(freshAgent, "ZeroAddress");
      });

      it("should revert if the escrow address is already set", async function () {
        const { aiAgent, deployer, mockEscrow } = await loadFixture(deployAgentFixture);
        await expect(
          aiAgent.connect(deployer).setAgentEscrow(await mockEscrow.getAddress()),
        ).to.be.revertedWithCustomError(aiAgent, "AgentEscrowAlreadySet");
      });

      it("should revert when a non-TEE address tries to call setOracle", async function () {
        const { aiAgent, unauthorizedUser } = await loadFixture(deployAgentFixture);
        await expect(aiAgent.connect(unauthorizedUser).setOracle(unauthorizedUser.address)).to.be
          .reverted;
      });
    });
  });

  describe("ID Reservation", function () {
    it("should allow the escrow contract to reserve message and trigger IDs", async function () {
      const { mockEscrow } = await loadFixture(deployAgentFixture);
      expect(await mockEscrow.callReserveMessageId.staticCall()).to.equal(0);
      await mockEscrow.callReserveMessageId();
      expect(await mockEscrow.callReserveMessageId.staticCall()).to.equal(1);

      expect(await mockEscrow.callReserveTriggerId.staticCall()).to.equal(0);
      await mockEscrow.callReserveTriggerId();
      expect(await mockEscrow.callReserveTriggerId.staticCall()).to.equal(1);
    });

    it("should revert if a non-escrow address tries to reserve an ID", async function () {
      const { aiAgent, user } = await loadFixture(deployAgentFixture);
      await expect(aiAgent.connect(user).reserveMessageId()).to.be.revertedWithCustomError(
        aiAgent,
        "NotAIAgentEscrow",
      );
      await expect(aiAgent.connect(user).reserveTriggerId()).to.be.revertedWithCustomError(
        aiAgent,
        "NotAIAgentEscrow",
      );
    });
  });

  describe("Prompt Submission and Ownership", function () {
    it("should create a new conversation when conversationId is 0", async function () {
      const { aiAgent, mockEscrow, user } = await loadFixture(deployAgentFixture);
      const promptMessageId = 0;
      const answerMessageId = 1;
      const conversationId = 1;
      await expect(
        mockEscrow
          .connect(user)
          .callSubmitPrompt(promptMessageId, answerMessageId, 0, user.address, MOCK_PAYLOAD),
      )
        .to.emit(aiAgent, "PromptSubmitted")
        .withArgs(user.address, promptMessageId, answerMessageId, conversationId, MOCK_PAYLOAD);

      expect(await aiAgent.conversationToOwner(conversationId)).to.equal(user.address);
      expect(await aiAgent.messageToConversation(promptMessageId)).to.equal(conversationId);
    });

    it("should revert if an unauthorized user tries to use an existing conversation", async function () {
      const { aiAgent, mockEscrow, user, unauthorizedUser } = await loadFixture(deployAgentFixture);
      await mockEscrow.callSubmitPrompt(0, 1, 0, user.address, MOCK_PAYLOAD);
      const conversationId = 1;
      await expect(
        mockEscrow
          .connect(unauthorizedUser)
          .callSubmitPrompt(2, 3, conversationId, unauthorizedUser.address, MOCK_PAYLOAD),
      ).to.be.revertedWithCustomError(aiAgent, "Unauthorized");
    });

    it("should create a new job when jobId is 0", async function () {
      const { aiAgent, mockEscrow, user } = await loadFixture(deployAgentFixture);
      const triggerId = 0;
      const jobId = 1;
      await expect(
        mockEscrow.connect(user).callSubmitAgentJob(triggerId, 0, user.address, MOCK_PAYLOAD),
      )
        .to.emit(aiAgent, "AgentJobSubmitted")
        .withArgs(user.address, triggerId, jobId, MOCK_PAYLOAD);

      expect(await aiAgent.jobToOwner(jobId)).to.equal(user.address);
      expect(await aiAgent.triggerToJob(triggerId)).to.equal(jobId);
    });

    it("should revert if an unauthorized user tries to use an existing agent job", async function () {
      const { aiAgent, mockEscrow, user, unauthorizedUser } = await loadFixture(deployAgentFixture);
      await mockEscrow.connect(user).callSubmitAgentJob(0, 0, user.address, MOCK_PAYLOAD);
      const jobId = 1;
      await expect(
        mockEscrow
          .connect(unauthorizedUser)
          .callSubmitAgentJob(1, jobId, unauthorizedUser.address, MOCK_PAYLOAD),
      ).to.be.revertedWithCustomError(aiAgent, "Unauthorized");
    });
  });

  describe("Answer and Regeneration Workflow", function () {
    context("Happy Paths", function () {
      it("should submit a full answer for a new prompt in a new conversation", async function () {
        const { aiAgent, mockEscrow, user, oracle } = await loadFixture(deployAgentFixture);
        const promptMessageId = 0;
        const answerMessageId = 1;
        await mockEscrow.callSubmitPrompt(
          promptMessageId,
          answerMessageId,
          0,
          user.address,
          MOCK_PAYLOAD,
        );
        const conversationId = 1;

        const cidBundle = {
          conversationCID: MOCK_CID,
          metadataCID: MOCK_CID,
          promptMessageCID: MOCK_CID,
          answerMessageCID: MOCK_CID,
          searchDeltaCID: MOCK_CID,
        };

        await expect(
          aiAgent.connect(oracle).submitAnswer(promptMessageId, answerMessageId, cidBundle),
        )
          .to.emit(aiAgent, "ConversationAdded")
          .and.to.emit(aiAgent, "PromptMessageAdded")
          .and.to.emit(aiAgent, "AnswerMessageAdded");

        expect(await aiAgent.isJobFinalized(answerMessageId)).to.be.true;
        expect(await mockEscrow.lastFinalizedEscrowId()).to.equal(answerMessageId);
      });

      it("should submit an answer for a prompt in an existing conversation", async function () {
        const { aiAgent, mockEscrow, user, oracle } = await loadFixture(deployAgentFixture);
        await mockEscrow.callSubmitPrompt(0, 1, 0, user.address, MOCK_PAYLOAD);
        const conversationId = 1;
        const firstCidBundle = {
          conversationCID: MOCK_CID,
          metadataCID: MOCK_CID,
          promptMessageCID: MOCK_CID,
          answerMessageCID: MOCK_CID,
          searchDeltaCID: MOCK_CID,
        };
        await aiAgent.connect(oracle).submitAnswer(0, 1, firstCidBundle);

        const promptMessageId = 2;
        const answerMessageId = 3;
        await mockEscrow.callSubmitPrompt(
          promptMessageId,
          answerMessageId,
          conversationId,
          user.address,
          MOCK_PAYLOAD,
        );
        const subsequentCidBundle = {
          conversationCID: "",
          metadataCID: "",
          promptMessageCID: MOCK_CID,
          answerMessageCID: MOCK_CID,
          searchDeltaCID: MOCK_CID,
        };

        const tx = aiAgent
          .connect(oracle)
          .submitAnswer(promptMessageId, answerMessageId, subsequentCidBundle);
        await expect(tx)
          .to.emit(aiAgent, "PromptMessageAdded")
          .and.to.not.emit(aiAgent, "ConversationAdded");
      });

      it("should submit an answer for a regeneration", async function () {
        const { aiAgent, mockEscrow, user, oracle } = await loadFixture(deployAgentFixture);
        const promptMessageId = 0;
        const originalAnswerMessageId = 1;
        await mockEscrow.callSubmitPrompt(
          promptMessageId,
          originalAnswerMessageId,
          0,
          user.address,
          MOCK_PAYLOAD,
        );
        const firstCidBundle = {
          conversationCID: MOCK_CID,
          metadataCID: MOCK_CID,
          promptMessageCID: MOCK_CID,
          answerMessageCID: MOCK_CID,
          searchDeltaCID: MOCK_CID,
        };
        await aiAgent
          .connect(oracle)
          .submitAnswer(promptMessageId, originalAnswerMessageId, firstCidBundle);

        const newAnswerMessageId = 2;
        await mockEscrow.callSubmitRegenerationRequest(
          user.address,
          promptMessageId,
          originalAnswerMessageId,
          newAnswerMessageId,
          MOCK_PAYLOAD,
        );
        expect(await aiAgent.isRegenerationPending(promptMessageId)).to.be.true;

        const regenerationCidBundle = {
          conversationCID: "",
          metadataCID: "",
          promptMessageCID: "",
          answerMessageCID: MOCK_CID,
          searchDeltaCID: "",
        };
        const tx = aiAgent
          .connect(oracle)
          .submitAnswer(promptMessageId, newAnswerMessageId, regenerationCidBundle);

        await expect(tx)
          .to.emit(aiAgent, "AnswerMessageAdded")
          .and.to.not.emit(aiAgent, "PromptMessageAdded");
        expect(await aiAgent.isRegenerationPending(promptMessageId)).to.be.false;
      });
    });

    context("Failure Paths and State Guards", function () {
      it("should revert if a non-oracle calls submitAnswer", async function () {
        const { aiAgent, unauthorizedUser } = await loadFixture(deployAgentFixture);
        const dummyCidBundle = {
          conversationCID: "",
          metadataCID: "",
          promptMessageCID: "",
          answerMessageCID: MOCK_CID,
          searchDeltaCID: "",
        };
        await expect(
          aiAgent.connect(unauthorizedUser).submitAnswer(0, 1, dummyCidBundle),
        ).to.be.revertedWithCustomError(aiAgent, "UnauthorizedOracle");
      });

      it("should revert if submitAnswer is called with an empty answer CID", async function () {
        const { aiAgent, mockEscrow, user, oracle } = await loadFixture(deployAgentFixture);
        await mockEscrow.callSubmitPrompt(0, 1, 0, user.address, MOCK_PAYLOAD);
        const cidBundle = {
          conversationCID: MOCK_CID,
          metadataCID: MOCK_CID,
          promptMessageCID: MOCK_CID,
          answerMessageCID: "",
          searchDeltaCID: MOCK_CID,
        };
        await expect(
          aiAgent.connect(oracle).submitAnswer(0, 1, cidBundle),
        ).to.be.revertedWithCustomError(aiAgent, "AnswerCIDRequired");
      });

      it("should revert if submitAnswer is for an invalid promptMessageId", async function () {
        const { aiAgent, oracle } = await loadFixture(deployAgentFixture);
        const dummyCidBundle = {
          conversationCID: "",
          metadataCID: "",
          promptMessageCID: "",
          answerMessageCID: MOCK_CID,
          searchDeltaCID: "",
        };
        await expect(
          aiAgent.connect(oracle).submitAnswer(999, 1, dummyCidBundle),
        ).to.be.revertedWithCustomError(aiAgent, "InvalidPromptMessageId");
      });

      it("should revert if submitAnswer is for a finalized job", async function () {
        const { aiAgent, mockEscrow, user, oracle } = await loadFixture(deployAgentFixture);
        await mockEscrow.callSubmitPrompt(0, 1, 0, user.address, MOCK_PAYLOAD);
        const cidBundle = {
          conversationCID: MOCK_CID,
          metadataCID: MOCK_CID,
          promptMessageCID: MOCK_CID,
          answerMessageCID: MOCK_CID,
          searchDeltaCID: MOCK_CID,
        };
        await aiAgent.connect(oracle).submitAnswer(0, 1, cidBundle);

        await expect(
          aiAgent.connect(oracle).submitAnswer(0, 1, cidBundle),
        ).to.be.revertedWithCustomError(aiAgent, "JobAlreadyFinalized");
      });

      it("should revert if a regeneration is requested for a pending prompt", async function () {
        const { aiAgent, mockEscrow, user } = await loadFixture(deployAgentFixture);
        await mockEscrow.callSubmitRegenerationRequest(user.address, 0, 1, 2, MOCK_PAYLOAD);
        await expect(
          mockEscrow.callSubmitRegenerationRequest(user.address, 0, 1, 3, MOCK_PAYLOAD),
        ).to.be.revertedWithCustomError(aiAgent, "RegenerationAlreadyPending");
      });
    });
  });

  describe("Branching and Metadata Workflow", function () {
    let aiAgent, mockEscrow, user, oracle, unauthorizedUser;

    beforeEach(async function () {
      const fixtures = await loadFixture(deployAgentFixture);
      ({ aiAgent, mockEscrow, user, oracle, unauthorizedUser } = fixtures);
      await mockEscrow.callSubmitPrompt(0, 1, 0, user.address, MOCK_PAYLOAD);
    });

    it("should handle a branch request and submission by the owner", async function () {
      const originalConversationId = 1;
      const branchPointMessageId = 1;
      await mockEscrow.callSubmitBranchRequest(
        user.address,
        originalConversationId,
        branchPointMessageId,
      );
      await expect(
        aiAgent
          .connect(oracle)
          .submitBranch(
            user.address,
            originalConversationId,
            branchPointMessageId,
            MOCK_CID,
            MOCK_CID,
          ),
      ).to.emit(aiAgent, "ConversationBranched");
    });

    it("should handle a metadata update request and submission by the owner", async function () {
      const conversationId = 1;
      await mockEscrow.callSubmitMetadataUpdate(conversationId, user.address, MOCK_PAYLOAD);
      await expect(
        aiAgent.connect(oracle).submitConversationMetadata(conversationId, MOCK_CID),
      ).to.emit(aiAgent, "ConversationMetadataUpdated");
    });

    it("should revert if a non-owner tries to branch or update metadata", async function () {
      const conversationId = 1;
      await expect(
        mockEscrow.callSubmitBranchRequest(unauthorizedUser.address, conversationId, 1),
      ).to.be.revertedWithCustomError(aiAgent, "Unauthorized");
      await expect(
        mockEscrow.callSubmitMetadataUpdate(conversationId, unauthorizedUser.address, MOCK_PAYLOAD),
      ).to.be.revertedWithCustomError(aiAgent, "Unauthorized");
    });

    it("should revert if oracle calls submitBranch with a mismatched user", async function () {
      const originalConversationId = 1;
      const branchPointMessageId = 1;
      await expect(
        aiAgent
          .connect(oracle)
          .submitBranch(
            unauthorizedUser.address,
            originalConversationId,
            branchPointMessageId,
            MOCK_CID,
            MOCK_CID,
          ),
      ).to.be.revertedWithCustomError(aiAgent, "Unauthorized");
    });
  });

  describe("Cancellation", function () {
    it("should allow the escrow contract to record a cancellation", async function () {
      const { aiAgent, mockEscrow, user } = await loadFixture(deployAgentFixture);
      const answerMessageId = 1;
      await expect(mockEscrow.callRecordCancellation(answerMessageId, user.address))
        .to.emit(aiAgent, "PromptCancelled")
        .withArgs(user.address, answerMessageId);
      expect(await aiAgent.isJobFinalized(answerMessageId)).to.be.true;
    });

    it("should revert if recording a cancellation for a finalized job", async function () {
      const { aiAgent, mockEscrow, user } = await loadFixture(deployAgentFixture);
      await mockEscrow.callRecordCancellation(1, user.address);
      await expect(
        mockEscrow.callRecordCancellation(1, user.address),
      ).to.be.revertedWithCustomError(aiAgent, "JobAlreadyFinalized");
    });
  });
});
