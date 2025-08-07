// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import { ISapphireAIAgent } from "./interfaces/ISapphireAIAgent.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

contract SapphireAIAgentEscrow is Ownable {
  ISapphireAIAgent public immutable SAPPHIRE_AI_AGENT; // The AI Agent contract this escrow serves.
  address public treasury; // The address where fees are collected.
  address public oracle; // The oracle address, authorized to initiate agent jobs.

  uint256 public constant PROMPT_FEE = 1 * 1e18; // Fee in wei (e.g., 1 ROSE or 1 TEST).
  uint256 public constant REFUND_TIMEOUT = 1 hours; // The time after which a pending prompt can be refunded.

  struct Subscription {
    uint256 expiresAt; // The unix timestamp when the subscription expires.
  }

  mapping(address => uint256) public deposits; // Tracks each user's deposited balance.
  mapping(address => Subscription) public subscriptions;

  enum EscrowStatus {
    PENDING,
    COMPLETE,
    REFUNDED
  }

  struct Escrow {
    address user;
    uint256 amount;
    uint256 createdAt;
    EscrowStatus status;
  }

  mapping(uint256 => Escrow) public escrows;

  event TreasuryUpdated(address newTreasury);
  event OracleUpdated(address newOracle);
  event SubscriptionSet(address indexed user, uint256 expiresAt);
  event SubscriptionCancelled(address indexed user);
  event DepositReceived(address indexed user, uint256 amount);
  event Withdrawal(address indexed user, uint256 amount);
  event PaymentEscrowed(uint256 indexed promptId, address indexed user, uint256 amount);
  event PaymentFinalized(uint256 indexed promptId);
  event PaymentRefunded(uint256 indexed promptId);

  error EscrowNotFound();
  error EscrowNotPending();
  error NotSapphireAIAgent();
  error NoActiveSubscription();
  error SubscriptionExpired();
  error InsufficientDeposit();
  error NotOracle();
  error ZeroAddress();

  // Sets up the escrow smart contract.
  // @param _agentAddress The address of the SapphireAIAgent contract to interact with.
  // @param _treasuryAddress The initial address where collected fees will be sent.
  // @param _oracleAddress The initial address of the authorized oracle.
  // @param _initialOwner The address that will have ownership of this contract.
  constructor(
    address _agentAddress,
    address _treasuryAddress,
    address _oracleAddress,
    address _initialOwner
  ) Ownable(_initialOwner) {
    if (
      _agentAddress == address(0) || _treasuryAddress == address(0) || _oracleAddress == address(0)
    ) {
      revert ZeroAddress();
    }

    SAPPHIRE_AI_AGENT = ISapphireAIAgent(_agentAddress);
    treasury = _treasuryAddress;
    oracle = _oracleAddress;
  }

  // Checks that the caller is the registered SapphireAIAgent contract.
  modifier onlySapphireAIAgent() {
    if (msg.sender != address(SAPPHIRE_AI_AGENT)) {
      revert NotSapphireAIAgent();
    }
    _;
  }
  // Checks that the caller is the authorized oracle.
  modifier onlyOracle() {
    if (msg.sender != oracle) {
      revert NotOracle();
    }
    _;
  }

  // Updates the treasury address where collected fees will be sent.
  // Only the contract owner can call this function.
  // @param _newTreasury The new treasury address.
  function setTreasury(address _newTreasury) external onlyOwner {
    if (_newTreasury == address(0)) {
      revert ZeroAddress();
    }

    treasury = _newTreasury;
    emit TreasuryUpdated(_newTreasury);
  }

  // Updates the oracle address that can initiate agent jobs.
  // Only the contract owner can call this function.
  // @param _newOracle The new oracle address.
  function setOracle(address _newOracle) external onlyOwner {
    if (_newOracle == address(0)) {
      revert ZeroAddress();
    }

    oracle = _newOracle;
    emit OracleUpdated(_newOracle);
  }

  // Allows a user to deposit native tokens (ROSE/TEST) to fund their usage.
  function deposit() external payable {
    deposits[msg.sender] += msg.value;
    emit DepositReceived(msg.sender, msg.value);
  }

  // Allows a user to withdraw their unused deposited funds.
  // @param _amount The amount of native tokens to withdraw.
  function withdraw(uint256 _amount) external {
    require(deposits[msg.sender] >= _amount, "Insufficient balance for withdrawal");
    deposits[msg.sender] -= _amount;
    payable(msg.sender).transfer(_amount);
    emit Withdrawal(msg.sender, _amount);
  }

  // Sets or updates a user's subscription period.
  // @param _expiresAt The unix timestamp when this subscription becomes invalid.
  function setSubscription(uint256 _expiresAt) external {
    subscriptions[msg.sender] = Subscription({ expiresAt: _expiresAt });
    emit SubscriptionSet(msg.sender, _expiresAt);
  }

  // Cancels a user's subscription.
  function cancelSubscription() external {
    delete subscriptions[msg.sender];
    emit SubscriptionCancelled(msg.sender);
  }

  // Initiates a new prompt request.
  // Called by the user.
  // @param _prompt The plaintext prompt from the user.
  function initiatePrompt(string calldata _prompt) external {
    _initiateJob(msg.sender, _prompt);
  }

  // Initiates a new prompt request on behalf of a user.
  // Called by the oracle for autonomous/scheduled jobs.
  // @param _user The address of the user for whom the job is being initiated.
  // @param _prompt The plaintext prompt for the user.
  function initiateAgentJob(address _user, string calldata _prompt) external onlyOracle {
    _initiateJob(_user, _prompt);
  }

  // Internal function to handle the core logic for any new job.
  function _initiateJob(address _user, string calldata _prompt) private {
    Subscription storage sub = subscriptions[_user];
    if (sub.expiresAt == 0) {
      revert NoActiveSubscription();
    }

    if (block.timestamp >= sub.expiresAt) {
      revert SubscriptionExpired();
    }

    if (deposits[_user] < PROMPT_FEE) {
      revert InsufficientDeposit();
    }

    // Deduct from their deposited balance. The funds are now held by this contract.
    deposits[_user] -= PROMPT_FEE;

    uint256 promptId = SAPPHIRE_AI_AGENT.promptIdCounter();
    escrows[promptId] = Escrow({
      user: _user,
      amount: PROMPT_FEE,
      createdAt: block.timestamp,
      status: EscrowStatus.PENDING
    });
    emit PaymentEscrowed(promptId, _user, PROMPT_FEE);

    // Call the agent contract to store the prompt and signal the off-chain oracle.
    SAPPHIRE_AI_AGENT.submitPrompt(promptId, _prompt);
  }

  // Releases the escrowed payment to the treasury upon successful completion.
  // Called by the SapphireAIAgent contract.
  // @param _promptId The unique identifier of the prompt to finalize.
  function finalizePayment(uint256 _promptId) external onlySapphireAIAgent {
    Escrow storage escrow = escrows[_promptId];

    if (escrow.user == address(0)) revert EscrowNotFound();
    if (escrow.status != EscrowStatus.PENDING) revert EscrowNotPending();

    escrow.status = EscrowStatus.COMPLETE;
    payable(treasury).transfer(escrow.amount);
    emit PaymentFinalized(_promptId);
  }

  // Refunds any pending escrows that have passed the timeout period.
  // Called by a keeper service.
  // @param _promptIds An array of prompt IDs to check for potential refunds.
  function processRefunds(uint256[] calldata _promptIds) external {
    for (uint256 i = 0; i < _promptIds.length; i++) {
      uint256 promptId = _promptIds[i];
      Escrow storage escrow = escrows[promptId];

      if (
        escrow.status == EscrowStatus.PENDING && block.timestamp > escrow.createdAt + REFUND_TIMEOUT
      ) {
        escrow.status = EscrowStatus.REFUNDED;
        deposits[escrow.user] += escrow.amount;
        emit PaymentRefunded(promptId);
      }
    }
  }
}
