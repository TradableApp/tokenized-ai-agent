const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("Sapphire System Integration Test", function () {
  // --- Test Suite Setup ---
  let aiAgent, agentEscrow, deployer, user, oracle, treasury;

  const PROMPT_FEE = ethers.parseEther("1");
  const INITIAL_DEPOSIT = ethers.parseEther("10");
  const PROMPT_TEXT = "What is the nature of a confidential smart contract?";
  const ANSWER_TEXT = "It allows for computation on encrypted data without revealing the inputs.";

  // Before each test, deploy the entire system of linked contracts.
  beforeEach(async function () {
    [deployer, user, oracle, treasury] = await ethers.getSigners();

    // 1. Deploy the SapphireAIAgent contract (not upgradable)
    const SapphireAIAgent = await ethers.getContractFactory("SapphireAIAgent");
    aiAgent = await SapphireAIAgent.deploy(
      "example.com",
      ethers.zeroPadBytes("0x", 21),
      oracle.address,
      deployer.address, // owner
    );
    await aiAgent.waitForDeployment();

    // 2. Deploy the SapphireAIAgentEscrow, linking it to the AI Agent
    const SapphireAIAgentEscrow = await ethers.getContractFactory("SapphireAIAgentEscrow");
    agentEscrow = await SapphireAIAgentEscrow.deploy(
      await aiAgent.getAddress(),
      treasury.address,
      oracle.address,
      deployer.address, // owner
    );
    await agentEscrow.waitForDeployment();

    // 3. Complete the two-step link by setting the escrow address on the agent
    await aiAgent.connect(deployer).setAgentEscrow(await agentEscrow.getAddress());

    // 4. User deposits native funds into the escrow contract for usage
    await agentEscrow.connect(user).deposit({ value: INITIAL_DEPOSIT });
  });

  // --- Test Cases ---

  describe("Full User Workflow (Happy Path)", function () {
    it("should process a user prompt from initiation to payment finalization", async function () {
      // Step 1: User sets a subscription
      const expiresAt = (await time.latest()) + 3600;
      await agentEscrow.connect(user).setSubscription(expiresAt);

      // Step 2: User initiates a prompt
      const promptId = await aiAgent.promptIdCounter();
      await expect(agentEscrow.connect(user).initiatePrompt(PROMPT_TEXT))
        .to.emit(aiAgent, "PromptSubmitted")
        .withArgs(user.address, promptId);

      // Verify that the fee was deducted from the user's internal deposit
      expect(await agentEscrow.deposits(user.address)).to.equal(INITIAL_DEPOSIT - PROMPT_FEE);

      // Step 3: Oracle submits an answer
      const initialTreasuryBalance = await ethers.provider.getBalance(treasury.address);
      await aiAgent.connect(oracle).submitAnswer(ANSWER_TEXT, promptId, user.address);

      // Verify that the payment was finalized and sent to the treasury
      expect(await ethers.provider.getBalance(treasury.address)).to.equal(
        initialTreasuryBalance + PROMPT_FEE,
      );

      // Verify the escrow record is marked as complete
      const escrowRecord = await agentEscrow.escrows(promptId);
      expect(escrowRecord.status).to.equal(1); // 1 is Enum.COMPLETE
    });
  });

  describe("Refund Workflow", function () {
    it("should allow a timed-out prompt to be refunded to the user's deposit", async function () {
      const expiresAt = (await time.latest()) + 7200;
      await agentEscrow.connect(user).setSubscription(expiresAt);

      const promptId = await aiAgent.promptIdCounter();
      await agentEscrow.connect(user).initiatePrompt(PROMPT_TEXT);

      // The prompt is now pending. Check initial deposit state.
      const depositAfterPrompt = await agentEscrow.deposits(user.address);
      expect(depositAfterPrompt).to.equal(INITIAL_DEPOSIT - PROMPT_FEE);

      // Fast-forward time past the refund timeout
      await time.increase(3601);

      // Anyone can call the keeper function to process refunds
      await agentEscrow.connect(deployer).processRefund(promptId);

      // Verify the funds were returned to the user's internal deposit balance
      expect(await agentEscrow.deposits(user.address)).to.equal(INITIAL_DEPOSIT);

      // Verify the escrow record is marked as refunded
      const escrowRecord = await agentEscrow.escrows(promptId);
      expect(escrowRecord.status).to.equal(2); // 2 is Enum.REFUNDED
    });
  });
});
