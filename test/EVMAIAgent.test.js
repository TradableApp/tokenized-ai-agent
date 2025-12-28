const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("EVMAIAgent (Upgradable)", function () {
  // --- Test Suite Setup ---
  const domain = "example.com";
  const MOCK_CID = "QmXg9j4f8zYf8t7f8zYf8t7f8zYf8t7f8zYf8t7f8zYf8t7";
  const MOCK_ENCRYPTED_PAYLOAD = "0x1234";
  const MOCK_ROFL_KEY = "0x5678";

  // Deploys contracts and sets up the test environment.
  async function deployAgentFixture() {
    const [deployer, user, oracle, unauthorizedUser] = await ethers.getSigners();
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

    return { aiAgent, mockEscrow, deployer, user, oracle, unauthorizedUser, EVMAIAgent };
  }

  // --- Test Cases ---

  describe("Initialization and Admin", function () {
    it("should set the correct initial state on deployment", async function () {
      const { aiAgent, mockEscrow, oracle, deployer } = await loadFixture(deployAgentFixture);
      expect(await aiAgent.oracle()).to.equal(oracle.address);
      expect(await aiAgent.domain()).to.equal(domain);
      expect(await aiAgent.aiAgentEscrow()).to.equal(await mockEscrow.getAddress());
      expect(await aiAgent.owner()).to.equal(deployer.address);
      expect(await aiAgent.conversationIdCounter()).to.equal(1);
      expect(await aiAgent.jobIdCounter()).to.equal(1);
    });

    context("Administrative Functions", function () {
      it("should prevent a non-owner from setting the escrow address", async function () {
        const { aiAgent, unauthorizedUser, mockEscrow } = await loadFixture(deployAgentFixture);
        await expect(
          aiAgent.connect(unauthorizedUser).setAgentEscrow(await mockEscrow.getAddress()),
        ).to.be.revertedWithCustomError(aiAgent, "OwnableUnauthorizedAccount");
      });

      it("should revert if setting the escrow address to the zero address", async function () {
        const { deployer, oracle, EVMAIAgent } = await loadFixture(deployAgentFixture);
        const freshAgent = await upgrades.deployProxy(EVMAIAgent, [
          domain,
          oracle.address,
          deployer.address,
        ]);
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

      it("should revert if initializing with a zero address for oracle", async function () {
        const { deployer, EVMAIAgent } = await loadFixture(deployAgentFixture);
        await expect(
          upgrades.deployProxy(EVMAIAgent, [domain, ethers.ZeroAddress, deployer.address]),
        ).to.be.revertedWithCustomError(EVMAIAgent, "ZeroAddress");
      });

      it("should allow the owner to set a new oracle and revert for non-owner or zero address", async function () {
        const { aiAgent, deployer, unauthorizedUser } = await loadFixture(deployAgentFixture);
        await expect(aiAgent.connect(deployer).setOracle(unauthorizedUser.address))
          .to.emit(aiAgent, "OracleUpdated")
          .withArgs(unauthorizedUser.address);
        expect(await aiAgent.oracle()).to.equal(unauthorizedUser.address);

        await expect(
          aiAgent.connect(unauthorizedUser).setOracle(deployer.address),
        ).to.be.revertedWithCustomError(aiAgent, "OwnableUnauthorizedAccount");

        await expect(
          aiAgent.connect(deployer).setOracle(ethers.ZeroAddress),
        ).to.be.revertedWithCustomError(aiAgent, "ZeroAddress");
      });
    });
  });

  describe("ID Reservation", function () {
    it("should allow the escrow contract to reserve all ID types", async function () {
      const { mockEscrow } = await loadFixture(deployAgentFixture);
      expect(await mockEscrow.callReserveConversationId.staticCall()).to.equal(1);
      await mockEscrow.callReserveConversationId();
      expect(await mockEscrow.callReserveConversationId.staticCall()).to.equal(2);

      expect(await mockEscrow.callReserveJobId.staticCall()).to.equal(1);
      await mockEscrow.callReserveJobId();
      expect(await mockEscrow.callReserveJobId.staticCall()).to.equal(2);

      expect(await mockEscrow.callReserveMessageId.staticCall()).to.equal(0);
      await mockEscrow.callReserveMessageId();
      expect(await mockEscrow.callReserveMessageId.staticCall()).to.equal(1);

      expect(await mockEscrow.callReserveTriggerId.staticCall()).to.equal(0);
      await mockEscrow.callReserveTriggerId();
      expect(await mockEscrow.callReserveTriggerId.staticCall()).to.equal(1);
    });

    it("should revert if a non-escrow address tries to reserve an ID", async function () {
      const { aiAgent, user } = await loadFixture(deployAgentFixture);
      await expect(aiAgent.connect(user).reserveConversationId()).to.be.revertedWithCustomError(
        aiAgent,
        "NotAIAgentEscrow",
      );
      await expect(aiAgent.connect(user).reserveJobId()).to.be.revertedWithCustomError(
        aiAgent,
        "NotAIAgentEscrow",
      );
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
    it("should assign ownership for a newly reserved conversationId", async function () {
      const { aiAgent, mockEscrow, user } = await loadFixture(deployAgentFixture);
      const conversationId = 1;
      const promptMessageId = 0;
      const answerMessageId = 1;

      await expect(
        mockEscrow
          .connect(user)
          .callSubmitPrompt(
            user.address,
            conversationId,
            promptMessageId,
            answerMessageId,
            "0x",
            "0x",
          ),
      )
        .to.emit(aiAgent, "PromptSubmitted")
        .withArgs(user.address, conversationId, promptMessageId, answerMessageId, "0x", "0x");

      expect(await aiAgent.conversationToOwner(conversationId)).to.equal(user.address);
      expect(await aiAgent.messageToConversation(promptMessageId)).to.equal(conversationId);
    });

    it("should revert if an unauthorized user tries to use an existing conversation", async function () {
      const { aiAgent, mockEscrow, user, unauthorizedUser } = await loadFixture(deployAgentFixture);
      const conversationId = 1;
      const promptMessageId1 = 0;
      const answerMessageId1 = 1;
      await mockEscrow
        .connect(user)
        .callSubmitPrompt(
          user.address,
          conversationId,
          promptMessageId1,
          answerMessageId1,
          "0x",
          "0x",
        );

      const promptMessageId2 = 2;
      const answerMessageId2 = 3;
      await expect(
        mockEscrow
          .connect(unauthorizedUser)
          .callSubmitPrompt(
            unauthorizedUser.address,
            conversationId,
            promptMessageId2,
            answerMessageId2,
            "0x",
            "0x",
          ),
      ).to.be.revertedWithCustomError(aiAgent, "Unauthorized");
    });

    it("should assign ownership for a newly reserved jobId", async function () {
      const { aiAgent, mockEscrow, user } = await loadFixture(deployAgentFixture);
      const jobId = 1;
      const triggerId = 0;
      await expect(
        mockEscrow.connect(user).callSubmitAgentJob(user.address, jobId, triggerId, "0x", "0x"),
      )
        .to.emit(aiAgent, "AgentJobSubmitted")
        .withArgs(user.address, jobId, triggerId, "0x", "0x");

      expect(await aiAgent.jobToOwner(jobId)).to.equal(user.address);
      expect(await aiAgent.triggerToJob(triggerId)).to.equal(jobId);
    });

    it("should revert if an unauthorized user tries to use an existing agent job", async function () {
      const { aiAgent, mockEscrow, user, unauthorizedUser } = await loadFixture(deployAgentFixture);
      const jobId = 1;
      const triggerId1 = 0;
      await mockEscrow
        .connect(user)
        .callSubmitAgentJob(user.address, jobId, triggerId1, "0x", "0x");

      const triggerId2 = 1;
      await expect(
        mockEscrow
          .connect(unauthorizedUser)
          .callSubmitAgentJob(unauthorizedUser.address, jobId, triggerId2, "0x", "0x"),
      ).to.be.revertedWithCustomError(aiAgent, "Unauthorized");
    });
  });

  describe("Answer and Regeneration Workflow", function () {
    context("Happy Paths", function () {
      it("should submit a full answer for a new prompt in a new conversation", async function () {
        const { aiAgent, mockEscrow, user, oracle } = await loadFixture(deployAgentFixture);
        const conversationId = 1;
        const promptMessageId = 0;
        const answerMessageId = 1;
        await mockEscrow.callSubmitPrompt(
          user.address,
          conversationId,
          promptMessageId,
          answerMessageId,
          "0x",
          "0x",
        );

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
          .withArgs(user.address, conversationId, MOCK_CID, MOCK_CID)
          .and.to.emit(aiAgent, "PromptMessageAdded")
          .withArgs(conversationId, promptMessageId, MOCK_CID)
          .and.to.emit(aiAgent, "SearchIndexDeltaAdded")
          .withArgs(promptMessageId, MOCK_CID)
          .and.to.emit(aiAgent, "AnswerMessageAdded")
          .withArgs(conversationId, answerMessageId, MOCK_CID);

        expect(await aiAgent.isJobFinalized(answerMessageId)).to.be.true;
        expect(await mockEscrow.lastFinalizedEscrowId()).to.equal(answerMessageId);
      });

      it("should submit an answer for a prompt in an existing conversation", async function () {
        const { aiAgent, mockEscrow, user, oracle } = await loadFixture(deployAgentFixture);
        const conversationId = 1;

        const promptMessageId1 = 0;
        const answerMessageId1 = 1;
        await mockEscrow.callSubmitPrompt(
          user.address,
          conversationId,
          promptMessageId1,
          answerMessageId1,
          "0x",
          "0x",
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
          .submitAnswer(promptMessageId1, answerMessageId1, firstCidBundle);

        const promptMessageId2 = 2;
        const answerMessageId2 = 3;
        await mockEscrow.callSubmitPrompt(
          user.address,
          conversationId,
          promptMessageId2,
          answerMessageId2,
          "0x",
          "0x",
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
          .submitAnswer(promptMessageId2, answerMessageId2, subsequentCidBundle);

        await expect(tx)
          .to.emit(aiAgent, "PromptMessageAdded")
          .withArgs(conversationId, promptMessageId2, MOCK_CID)
          .and.to.emit(aiAgent, "SearchIndexDeltaAdded")
          .withArgs(promptMessageId2, MOCK_CID)
          .and.to.emit(aiAgent, "AnswerMessageAdded")
          .withArgs(conversationId, answerMessageId2, MOCK_CID)
          .and.to.not.emit(aiAgent, "ConversationAdded");
      });

      it("should submit an answer for a regeneration", async function () {
        const { aiAgent, mockEscrow, user, oracle } = await loadFixture(deployAgentFixture);
        const conversationId = 1;
        const promptMessageId = 0;
        const originalAnswerMessageId = 1;

        await mockEscrow.callSubmitPrompt(
          user.address,
          conversationId,
          promptMessageId,
          originalAnswerMessageId,
          "0x",
          "0x",
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
          conversationId,
          promptMessageId,
          originalAnswerMessageId,
          newAnswerMessageId,
          "0x",
          "0x",
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
          .withArgs(conversationId, newAnswerMessageId, MOCK_CID)
          .and.to.not.emit(aiAgent, "ConversationAdded")
          .and.to.not.emit(aiAgent, "PromptMessageAdded")
          .and.to.not.emit(aiAgent, "SearchIndexDeltaAdded");

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
        const promptMessageId = 0;
        const answerMessageId = 1;
        await expect(
          aiAgent
            .connect(unauthorizedUser)
            .submitAnswer(promptMessageId, answerMessageId, dummyCidBundle),
        ).to.be.revertedWithCustomError(aiAgent, "UnauthorizedOracle");
      });

      it("should revert if submitAnswer is called with an empty answer CID", async function () {
        const { aiAgent, mockEscrow, user, oracle } = await loadFixture(deployAgentFixture);
        const conversationId = 1;
        const promptMessageId = 0;
        const answerMessageId = 1;
        await mockEscrow.callSubmitPrompt(
          user.address,
          conversationId,
          promptMessageId,
          answerMessageId,
          "0x",
          "0x",
        );

        const cidBundle = {
          conversationCID: MOCK_CID,
          metadataCID: MOCK_CID,
          promptMessageCID: MOCK_CID,
          answerMessageCID: "", // Intentionally empty
          searchDeltaCID: MOCK_CID,
        };

        await expect(
          aiAgent.connect(oracle).submitAnswer(promptMessageId, answerMessageId, cidBundle),
        ).to.be.revertedWithCustomError(aiAgent, "AnswerCIDRequired");
      });

      it("should revert if submitAnswer is for an invalid promptMessageId", async function () {
        const { aiAgent, oracle } = await loadFixture(deployAgentFixture);
        const invalidPromptId = 999;
        const answerMessageId = 1;
        const dummyCidBundle = {
          conversationCID: "",
          metadataCID: "",
          promptMessageCID: "",
          answerMessageCID: MOCK_CID,
          searchDeltaCID: "",
        };
        await expect(
          aiAgent.connect(oracle).submitAnswer(invalidPromptId, answerMessageId, dummyCidBundle),
        ).to.be.revertedWithCustomError(aiAgent, "InvalidPromptMessageId");
      });

      it("should revert if submitAnswer is called for a finalized job", async function () {
        const { aiAgent, mockEscrow, user, oracle } = await loadFixture(deployAgentFixture);
        const conversationId = 1;
        const promptMessageId = 0;
        const answerMessageId = 1;
        await mockEscrow.callSubmitPrompt(
          user.address,
          conversationId,
          promptMessageId,
          answerMessageId,
          "0x",
          "0x",
        );
        const cidBundle = {
          conversationCID: MOCK_CID,
          metadataCID: MOCK_CID,
          promptMessageCID: MOCK_CID,
          answerMessageCID: MOCK_CID,
          searchDeltaCID: MOCK_CID,
        };
        await aiAgent.connect(oracle).submitAnswer(promptMessageId, answerMessageId, cidBundle);

        await expect(
          aiAgent.connect(oracle).submitAnswer(promptMessageId, answerMessageId, cidBundle),
        ).to.be.revertedWithCustomError(aiAgent, "JobAlreadyFinalized");
      });

      it("should revert if a regeneration is requested for a pending prompt", async function () {
        const { aiAgent, mockEscrow, user, oracle } = await loadFixture(deployAgentFixture);
        const conversationId = 1;
        const promptMessageId = 0;
        const originalAnswerMessageId = 1;

        // SETUP: Create and finalize a conversation so we have something to regenerate.
        await mockEscrow.callSubmitPrompt(
          user.address,
          conversationId,
          promptMessageId,
          originalAnswerMessageId,
          "0x",
          "0x",
        );
        const cidBundle = {
          conversationCID: MOCK_CID,
          metadataCID: MOCK_CID,
          promptMessageCID: MOCK_CID,
          answerMessageCID: MOCK_CID,
          searchDeltaCID: MOCK_CID,
        };
        await aiAgent
          .connect(oracle)
          .submitAnswer(promptMessageId, originalAnswerMessageId, cidBundle);

        // ACTION 1: The user successfully requests a regeneration.
        const newAnswerMessageId1 = 2;
        await mockEscrow.callSubmitRegenerationRequest(
          user.address,
          conversationId,
          promptMessageId,
          originalAnswerMessageId,
          newAnswerMessageId1,
          "0x",
          "0x",
        );

        // ASSERTION: The test's main purpose. Attempting a second regeneration for the
        // same prompt while the first one is still pending should revert.
        const newAnswerMessageId2 = 3;
        await expect(
          mockEscrow.callSubmitRegenerationRequest(
            user.address,
            conversationId,
            promptMessageId,
            originalAnswerMessageId,
            newAnswerMessageId2,
            "0x",
            "0x",
          ),
        ).to.be.revertedWithCustomError(aiAgent, "RegenerationAlreadyPending");
      });
    });
  });

  describe("Branching and Metadata Workflow", function () {
    let aiAgent, mockEscrow, user, oracle, unauthorizedUser;
    const conversationId = 1;

    beforeEach(async function () {
      const fixtures = await loadFixture(deployAgentFixture);
      ({ aiAgent, mockEscrow, user, oracle, unauthorizedUser } = fixtures);
      const promptMessageId = 0;
      const answerMessageId = 1;
      await mockEscrow.callSubmitPrompt(
        user.address,
        conversationId,
        promptMessageId,
        answerMessageId,
        "0x",
        "0x",
      );
    });

    it("should handle a branch request and submission by the owner", async function () {
      const originalConversationId = 1;
      const branchPointMessageId = 1;
      const newConversationId = 2; // Next available conversation ID

      await expect(
        mockEscrow.callSubmitBranchRequest(
          user.address,
          originalConversationId,
          branchPointMessageId,
          newConversationId,
          MOCK_ENCRYPTED_PAYLOAD,
          MOCK_ROFL_KEY,
        ),
      ).to.emit(aiAgent, "BranchRequested");

      await expect(
        aiAgent
          .connect(oracle)
          .submitBranch(
            user.address,
            originalConversationId,
            branchPointMessageId,
            newConversationId,
            MOCK_CID,
            MOCK_CID,
          ),
      ).to.emit(aiAgent, "ConversationBranched");

      expect(await aiAgent.conversationToOwner(newConversationId)).to.equal(user.address);
    });

    it("should handle a metadata update request and submission by the owner", async function () {
      await expect(
        mockEscrow.callSubmitMetadataUpdate(
          user.address,
          conversationId,
          MOCK_ENCRYPTED_PAYLOAD,
          MOCK_ROFL_KEY,
        ),
      ).to.emit(aiAgent, "MetadataUpdateRequested");

      await expect(
        aiAgent.connect(oracle).submitConversationMetadata(conversationId, MOCK_CID),
      ).to.emit(aiAgent, "ConversationMetadataUpdated");
    });

    it("should revert if a non-owner tries to branch or update metadata", async function () {
      const originalConversationId = 1;
      const branchPointMessageId = 1;
      const newConversationId = 2;

      await expect(
        mockEscrow.callSubmitBranchRequest(
          unauthorizedUser.address,
          originalConversationId,
          branchPointMessageId,
          newConversationId,
          "0x",
          "0x",
        ),
      ).to.be.revertedWithCustomError(aiAgent, "Unauthorized");

      await expect(
        mockEscrow.callSubmitMetadataUpdate(
          unauthorizedUser.address,
          originalConversationId,
          "0x",
          "0x",
        ),
      ).to.be.revertedWithCustomError(aiAgent, "Unauthorized");
    });

    it("should revert if oracle calls submitBranch with a mismatched user", async function () {
      const originalConversationId = 1;
      const branchPointMessageId = 1;
      const newConversationId = 2;
      await mockEscrow.callSubmitBranchRequest(
        user.address,
        originalConversationId,
        branchPointMessageId,
        newConversationId,
        "0x",
        "0x",
      );
      await expect(
        aiAgent
          .connect(oracle)
          .submitBranch(
            unauthorizedUser.address,
            originalConversationId,
            branchPointMessageId,
            newConversationId,
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
      await expect(mockEscrow.callRecordCancellation(user.address, answerMessageId))
        .to.emit(aiAgent, "PromptCancelled")
        .withArgs(user.address, answerMessageId);
      expect(await aiAgent.isJobFinalized(answerMessageId)).to.be.true;
    });

    it("should revert if recording a cancellation for a finalized job", async function () {
      const { aiAgent, mockEscrow, user } = await loadFixture(deployAgentFixture);
      const answerMessageId = 1;
      await mockEscrow.callRecordCancellation(user.address, answerMessageId);
      await expect(
        mockEscrow.callRecordCancellation(user.address, answerMessageId),
      ).to.be.revertedWithCustomError(aiAgent, "JobAlreadyFinalized");
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
