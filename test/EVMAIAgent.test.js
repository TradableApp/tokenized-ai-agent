const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("EVMAIAgent (Upgradable)", function () {
  // --- Test Suite Setup ---
  const domain = "example.com";
  const MOCK_CID = "QmXg9j4f8zYf8t7f8zYf8t7f8zYf8t7f8zYf8t7f8zYf8t7";

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
    });

    // Test admin function access control and error handling
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
    it("should allow the escrow contract to reserve message and trigger IDs", async function () {
      const { mockEscrow } = await loadFixture(deployAgentFixture);
      // Use staticCall to get return values from non-view functions without sending a transaction
      expect(await mockEscrow.callReserveMessageId.staticCall()).to.equal(0);
      // Send the actual transaction to update the state
      await mockEscrow.callReserveMessageId();
      // Verify the next call would return the incremented ID
      expect(await mockEscrow.callReserveMessageId.staticCall()).to.equal(1);

      // Repeat for trigger IDs
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
      const conversationId = 1; // First conversation should have ID 1
      await expect(
        mockEscrow
          .connect(user)
          .callSubmitPrompt(promptMessageId, answerMessageId, 0, user.address, "0x", "0x"),
      )
        .to.emit(aiAgent, "PromptSubmitted")
        .withArgs(user.address, promptMessageId, answerMessageId, conversationId, "0x", "0x");

      expect(await aiAgent.conversationToOwner(conversationId)).to.equal(user.address);
      expect(await aiAgent.messageToConversation(promptMessageId)).to.equal(conversationId);
    });

    it("should revert if an unauthorized user tries to use an existing conversation", async function () {
      const { aiAgent, mockEscrow, user, unauthorizedUser } = await loadFixture(deployAgentFixture);
      await mockEscrow.connect(user).callSubmitPrompt(0, 1, 0, user.address, "0x", "0x");
      const conversationId = 1; // First conversation should have ID 1
      await expect(
        mockEscrow
          .connect(unauthorizedUser)
          .callSubmitPrompt(2, 3, conversationId, unauthorizedUser.address, "0x", "0x"),
      ).to.be.revertedWithCustomError(aiAgent, "Unauthorized");
    });

    // Test ownership for agent jobs
    it("should create a new job when jobId is 0", async function () {
      const { aiAgent, mockEscrow, user } = await loadFixture(deployAgentFixture);
      const triggerId = 0;
      const jobId = 1; // First job should have ID 1
      await expect(
        mockEscrow.connect(user).callSubmitAgentJob(triggerId, 0, user.address, "0x", "0x"),
      )
        .to.emit(aiAgent, "AgentJobSubmitted")
        .withArgs(user.address, triggerId, jobId, "0x", "0x");

      expect(await aiAgent.jobToOwner(jobId)).to.equal(user.address);
      expect(await aiAgent.triggerToJob(triggerId)).to.equal(jobId);
    });

    it("should revert if an unauthorized user tries to use an existing agent job", async function () {
      const { aiAgent, mockEscrow, user, unauthorizedUser } = await loadFixture(deployAgentFixture);
      await mockEscrow.connect(user).callSubmitAgentJob(0, 0, user.address, "0x", "0x");
      const jobId = 1; // First job should have ID 1
      await expect(
        mockEscrow
          .connect(unauthorizedUser)
          .callSubmitAgentJob(1, jobId, unauthorizedUser.address, "0x", "0x"),
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
          0, // New conversation
          user.address,
          "0x",
          "0x",
        );
        const conversationId = 1; // First conversation should have ID 1

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

        // Create and finalize the first prompt to establish the conversation
        await mockEscrow.callSubmitPrompt(
          0,
          1,
          0, // New conversation
          user.address,
          "0x",
          "0x",
        );
        const conversationId = 1; // First conversation should have ID 1
        const firstCidBundle = {
          conversationCID: MOCK_CID,
          metadataCID: MOCK_CID,
          promptMessageCID: MOCK_CID,
          answerMessageCID: MOCK_CID,
          searchDeltaCID: MOCK_CID,
        };
        await aiAgent.connect(oracle).submitAnswer(0, 1, firstCidBundle);

        // User submits a second prompt in the same conversation
        const promptMessageId = 2;
        const answerMessageId = 3;
        await mockEscrow.callSubmitPrompt(
          promptMessageId,
          answerMessageId,
          conversationId,
          user.address,
          "0x",
          "0x",
        );

        // Oracle submits the answer for the second prompt
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
          .withArgs(conversationId, promptMessageId, MOCK_CID)
          .and.to.emit(aiAgent, "SearchIndexDeltaAdded")
          .withArgs(promptMessageId, MOCK_CID)
          .and.to.emit(aiAgent, "AnswerMessageAdded")
          .withArgs(conversationId, answerMessageId, MOCK_CID)
          .and.to.not.emit(aiAgent, "ConversationAdded");
      });

      it("should submit an answer for a regeneration", async function () {
        const { aiAgent, mockEscrow, user, oracle } = await loadFixture(deployAgentFixture);
        const promptMessageId = 0;
        const originalAnswerMessageId = 1;

        // Create and finalize the original prompt and answer
        await mockEscrow.callSubmitPrompt(
          promptMessageId,
          originalAnswerMessageId,
          0, // New conversation
          user.address,
          "0x",
          "0x",
        );
        const conversationId = 1; // First conversation should have ID 1
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

        // User requests regeneration
        const newAnswerMessageId = 2;
        await mockEscrow.callSubmitRegenerationRequest(
          user.address,
          promptMessageId,
          originalAnswerMessageId,
          newAnswerMessageId,
          "0x",
          "0x",
        );
        expect(await aiAgent.isRegenerationPending(promptMessageId)).to.be.true;

        // Oracle submits the regenerated answer
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
        const conversationId = 1;
        const answerMessageId = 1;
        const dummyCidBundle = {
          conversationCID: "",
          metadataCID: "",
          promptMessageCID: "",
          answerMessageCID: MOCK_CID,
          searchDeltaCID: "",
        };
        await expect(
          aiAgent
            .connect(unauthorizedUser)
            .submitAnswer(conversationId, answerMessageId, dummyCidBundle),
        ).to.be.revertedWithCustomError(aiAgent, "UnauthorizedOracle");
      });

      it("should revert if submitAnswer is called with an empty answer CID", async function () {
        const { aiAgent, mockEscrow, user, oracle } = await loadFixture(deployAgentFixture);
        const promptMessageId = 0;
        const answerMessageId = 1;
        await mockEscrow.callSubmitPrompt(
          promptMessageId,
          answerMessageId,
          0,
          user.address,
          "0x",
          "0x",
        );
        const conversationId = 1; // First conversation should have ID 1

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
        const answerMessageId = 1;
        const dummyCidBundle = {
          conversationCID: "",
          metadataCID: "",
          promptMessageCID: "",
          answerMessageCID: MOCK_CID,
          searchDeltaCID: "",
        };
        await expect(
          aiAgent.connect(oracle).submitAnswer(999, answerMessageId, dummyCidBundle),
        ).to.be.revertedWithCustomError(aiAgent, "InvalidPromptMessageId");
      });

      it("should revert if submitAnswer is called for a finalized job", async function () {
        const { aiAgent, mockEscrow, user, oracle } = await loadFixture(deployAgentFixture);
        const promptMessageId = 0;
        const answerMessageId = 1;
        await mockEscrow.callSubmitPrompt(
          promptMessageId,
          answerMessageId,
          0,
          user.address,
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
        const conversationId = 1; // First conversation should have ID 1
        await aiAgent.connect(oracle).submitAnswer(promptMessageId, answerMessageId, cidBundle);

        await expect(
          aiAgent.connect(oracle).submitAnswer(promptMessageId, answerMessageId, cidBundle),
        ).to.be.revertedWithCustomError(aiAgent, "JobAlreadyFinalized");
      });

      it("should revert if a regeneration is requested for a pending prompt", async function () {
        const { aiAgent, mockEscrow, user } = await loadFixture(deployAgentFixture);
        const promptMessageId = 0;
        const originalAnswerMessageId = 1;
        await mockEscrow.callSubmitRegenerationRequest(
          user.address,
          promptMessageId,
          originalAnswerMessageId,
          2,
          "0x",
          "0x",
        );

        await expect(
          mockEscrow.callSubmitRegenerationRequest(
            user.address,
            promptMessageId,
            originalAnswerMessageId,
            3,
            "0x",
            "0x",
          ),
        ).to.be.revertedWithCustomError(aiAgent, "RegenerationAlreadyPending");
      });
    });
  });

  describe("Branching and Metadata Workflow", function () {
    // Add unauthorizedUser to the fixture destructuring
    let aiAgent, mockEscrow, user, oracle, unauthorizedUser;

    beforeEach(async function () {
      const fixtures = await loadFixture(deployAgentFixture);
      ({ aiAgent, mockEscrow, user, oracle, unauthorizedUser } = fixtures);
      // Setup a conversation owned by `user`
      await mockEscrow.callSubmitPrompt(0, 1, 0, user.address, "0x", "0x");
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
      await mockEscrow.callSubmitMetadataUpdate(conversationId, user.address, "0x", "0x");
      await expect(
        aiAgent.connect(oracle).submitConversationMetadata(conversationId, MOCK_CID),
      ).to.emit(aiAgent, "ConversationMetadataUpdated");
    });

    // Test that a non-owner cannot initiate these actions
    it("should revert if a non-owner tries to branch or update metadata", async function () {
      const originalConversationId = 1;
      const branchPointMessageId = 1;

      await expect(
        mockEscrow.callSubmitBranchRequest(
          unauthorizedUser.address,
          originalConversationId,
          branchPointMessageId,
        ),
      ).to.be.revertedWithCustomError(aiAgent, "Unauthorized");
      await expect(
        mockEscrow.callSubmitMetadataUpdate(
          originalConversationId,
          unauthorizedUser.address,
          "0x",
          "0x",
        ),
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
      await expect(mockEscrow.callRecordCancellation(1, user.address))
        .to.emit(aiAgent, "PromptCancelled")
        .withArgs(user.address, 1);
      expect(await aiAgent.isJobFinalized(1)).to.be.true;
    });

    it("should revert if recording a cancellation for a finalized job", async function () {
      const { aiAgent, mockEscrow, user } = await loadFixture(deployAgentFixture);
      await mockEscrow.callRecordCancellation(1, user.address);
      await expect(
        mockEscrow.callRecordCancellation(1, user.address),
      ).to.be.revertedWithCustomError(aiAgent, "JobAlreadyFinalized");
    });
  });

  // Add full test block for upgradeability
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
