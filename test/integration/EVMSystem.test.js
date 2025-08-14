const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("EVM System Integration Test", function () {
  // --- Test Suite Setup ---
  let aiAgent, agentEscrow, mockToken, deployer, user, oracle, treasury;

  const PROMPT_FEE = ethers.parseEther("1");
  const MOCK_ENCRYPTED_DATA = "0x";

  // Before each test, deploy the entire system of linked contracts.
  beforeEach(async function () {
    [deployer, user, oracle, treasury] = await ethers.getSigners();

    // 1. Deploy Mock ERC20 Token
    const MockTokenFactory = await ethers.getContractFactory("MockAbleToken");
    mockToken = await MockTokenFactory.deploy();
    await mockToken.waitForDeployment();
    await mockToken.mint(user.address, ethers.parseEther("100"));

    // 2. Deploy the EVMAIAgent Proxy
    const EVMAIAgent = await ethers.getContractFactory("EVMAIAgent");
    aiAgent = await upgrades.deployProxy(
      EVMAIAgent,
      ["example.com", ethers.zeroPadBytes("0x", 21), oracle.address, deployer.address],
      { initializer: "initialize", kind: "uups" },
    );
    await aiAgent.waitForDeployment();

    // 3. Deploy the EVMAIAgentEscrow Proxy, linking it to the AI Agent
    const EVMAIAgentEscrow = await ethers.getContractFactory("EVMAIAgentEscrow");
    agentEscrow = await upgrades.deployProxy(
      EVMAIAgentEscrow,
      [
        await mockToken.getAddress(),
        await aiAgent.getAddress(),
        treasury.address,
        oracle.address,
        deployer.address,
      ],
      { initializer: "initialize", kind: "uups" },
    );
    await agentEscrow.waitForDeployment();

    // 4. Complete the two-step link by setting the escrow address on the agent
    await aiAgent.connect(deployer).setAgentEscrow(await agentEscrow.getAddress());

    // 5. User approves the escrow contract to spend their tokens
    await mockToken.connect(user).approve(await agentEscrow.getAddress(), ethers.parseEther("100"));
  });

  // --- Test Cases ---

  describe("Full User Workflow (Happy Path)", function () {
    it("should process a user prompt from initiation to payment finalization", async function () {
      // Step 1: User sets a subscription
      const expiresAt = (await time.latest()) + 3600;
      await agentEscrow.connect(user).setSubscription(ethers.parseEther("10"), expiresAt);

      // Step 2: User initiates a prompt
      const promptId = await aiAgent.promptIdCounter();
      await expect(
        agentEscrow
          .connect(user)
          .initiatePrompt(MOCK_ENCRYPTED_DATA, MOCK_ENCRYPTED_DATA, MOCK_ENCRYPTED_DATA),
      )
        .to.emit(aiAgent, "PromptSubmitted")
        .withArgs(user.address, promptId);

      // Verify that the fee was escrowed
      expect(await mockToken.balanceOf(await agentEscrow.getAddress())).to.equal(PROMPT_FEE);
      expect(await mockToken.balanceOf(user.address)).to.equal(ethers.parseEther("99"));

      // Step 3: Oracle submits an answer
      await aiAgent
        .connect(oracle)
        .submitAnswer(
          MOCK_ENCRYPTED_DATA,
          MOCK_ENCRYPTED_DATA,
          MOCK_ENCRYPTED_DATA,
          promptId,
          user.address,
        );

      // Verify that the payment was finalized
      expect(await mockToken.balanceOf(await agentEscrow.getAddress())).to.equal(0);
      expect(await mockToken.balanceOf(treasury.address)).to.equal(PROMPT_FEE);

      // Verify the escrow record is marked as complete
      const escrowRecord = await agentEscrow.escrows(promptId);
      expect(escrowRecord.status).to.equal(1); // 1 is Enum.COMPLETE
    });
  });

  describe("Refund Workflow", function () {
    it("should allow a timed-out prompt to be refunded to the user", async function () {
      const expiresAt = (await time.latest()) + 7200;
      await agentEscrow.connect(user).setSubscription(ethers.parseEther("10"), expiresAt);

      const promptId = await aiAgent.promptIdCounter();
      await agentEscrow
        .connect(user)
        .initiatePrompt(MOCK_ENCRYPTED_DATA, MOCK_ENCRYPTED_DATA, MOCK_ENCRYPTED_DATA);

      // The prompt is now pending. Check initial state.
      expect(await mockToken.balanceOf(await agentEscrow.getAddress())).to.equal(PROMPT_FEE);
      const initialSub = await agentEscrow.subscriptions(user.address);
      expect(initialSub.spentAmount).to.equal(PROMPT_FEE);

      // Fast-forward time past the refund timeout
      await time.increase(3601);

      // Anyone can call the keeper function to process refunds
      // FIX: Use the correct singular function name 'processRefund' instead of 'processRefunds'.
      await agentEscrow.connect(deployer).processRefund(promptId);

      // Verify the funds were returned to the user
      expect(await mockToken.balanceOf(await agentEscrow.getAddress())).to.equal(0);
      expect(await mockToken.balanceOf(user.address)).to.equal(ethers.parseEther("100"));

      // Verify the user's subscription allowance was refunded
      const finalSub = await agentEscrow.subscriptions(user.address);
      expect(finalSub.spentAmount).to.equal(0);

      // Verify the escrow record is marked as refunded
      const escrowRecord = await agentEscrow.escrows(promptId);
      expect(escrowRecord.status).to.equal(2); // 2 is Enum.REFUNDED
    });
  });
});
