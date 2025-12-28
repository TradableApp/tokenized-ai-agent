// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import { ISapphireAIAgent } from "./interfaces/ISapphireAIAgent.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title Sapphire AI Agent Escrow Contract
 * @dev This contract manages native token (e.g., ROSE) deposits, payments, and refunds for the Sapphire AI Agent.
 *      It holds funds in escrow while a prompt is being processed by the off-chain oracle.
 */
contract SapphireAIAgentEscrow is Ownable {
  // --- Constants ---

  /// @notice The time after which a user can cancel their own pending prompt to prevent mis-clicks.
  uint256 public constant CANCELLATION_TIMEOUT = 3 seconds;
  /// @notice The time after which a keeper can refund any timed-out pending prompt.
  uint256 public constant REFUND_TIMEOUT = 1 hours;

  // --- State Variables ---

  /// @notice The AI Agent contract this escrow serves.
  ISapphireAIAgent public sapphireAIAgent;
  /// @notice The address where collected fees are sent.
  address public treasury;

  /// @notice The fee in the token's smallest unit required for one AI prompt.
  uint256 public promptFee;
  /// @notice The fee charged to a user for cancelling a pending prompt.
  uint256 public cancellationFee;
  /// @notice The fee charged to a user for updating conversation metadata.
  uint256 public metadataUpdateFee;
  /// @notice The fee charged to a user for branching a conversation.
  uint256 public branchFee;

  /// @notice Represents a user's usage allowance term.
  struct SpendingLimit {
    uint256 expiresAt; // The unix timestamp when the spending limit expires.
  }

  /// @notice Tracks each user's deposited balance for paying prompt fees.
  mapping(address => uint256) public deposits;
  /// @notice Tracks each user's allowance term.
  mapping(address => SpendingLimit) public spendingLimits;
  /// @notice Tracks the number of pending (unanswered) prompts for each user.
  mapping(address => uint256) public pendingEscrowCount;

  /// @notice Represents the possible states of a payment held in escrow.
  enum EscrowStatus {
    PENDING,
    COMPLETE,
    REFUNDED
  }

  /// @notice Stores the details of a single payment held in escrow.
  struct Escrow {
    address user;
    uint256 amount;
    uint256 createdAt;
    EscrowStatus status;
  }

  /// @notice Maps a unique escrow ID to its escrow details.
  mapping(uint256 => Escrow) public escrows;

  // --- Events ---

  /// @notice Emitted when the treasury address is updated.
  event TreasuryUpdated(address newTreasury);
  /// @notice Emitted when the prompt fee is updated.
  event PromptFeeUpdated(uint256 newFee);
  /// @notice Emitted when the cancellation fee is updated.
  event CancellationFeeUpdated(uint256 newFee);
  /// @notice Emitted when the metadata update fee is updated.
  event MetadataUpdateFeeUpdated(uint256 newFee);
  /// @notice Emitted when the conversation branch fee is updated.
  event BranchFeeUpdated(uint256 newFee);
  /// @notice Emitted when a user sets or updates their allowance term.
  event SpendingLimitSet(address indexed user, uint256 expiresAt);
  /// @notice Emitted when a user cancels their allowance.
  event SpendingLimitCancelled(address indexed user);
  /// @notice Emitted when a user deposits funds.
  event DepositReceived(address indexed user, uint256 amount);
  /// @notice Emitted when a user withdraws funds or they are refunded on cancellation.
  event Withdrawal(address indexed user, uint256 amount);
  /// @notice Emitted when a user's payment is successfully placed in escrow.
  event PaymentEscrowed(uint256 indexed escrowId, address indexed user, uint256 amount);
  /// @notice Emitted when an escrowed payment is finalized and sent to the treasury.
  event PaymentFinalized(uint256 indexed escrowId);
  /// @notice Emitted when a timed-out escrowed payment is refunded to the user's deposit.
  event PaymentRefunded(uint256 indexed escrowId);
  /// @notice Emitted when a user cancels their own pending prompt.
  event PromptCancelled(address indexed user, uint256 indexed answerMessageId);

  // --- Errors ---

  // Admin and Setup Errors
  /// @notice Reverts if an address parameter is the zero address.
  error ZeroAddress();

  // Access Control Errors
  /// @notice Reverts if a function is called by an address other than the linked AI Agent contract.
  error NotSapphireAIAgent();
  /// @notice Reverts if a function is called by an address that is not the authorized oracle.
  error NotOracle();
  /// @notice Reverts if a user tries to cancel a prompt they do not own.
  error NotPromptOwner();

  // Spending Limit Errors
  /// @notice Reverts if a user tries to submit a prompt without an active allowance term.
  error NoActiveSpendingLimit();
  /// @notice Reverts if a user tries to submit a prompt with an expired allowance term.
  error SpendingLimitExpired();
  /// @notice Reverts if a user's deposit balance is insufficient to cover a fee.
  error InsufficientDeposit();

  // State Machine Errors
  /// @notice Reverts if an escrow record is not found for a given ID.
  error EscrowNotFound();
  /// @notice Reverts if an action is attempted on an escrow that is not in the PENDING state.
  error EscrowNotPending();
  /// @notice Reverts if a user tries to manage a spending limit while having pending prompts.
  error HasPendingPrompts();
  /// @notice Reverts if a user attempts to withdraw more funds than they have deposited.
  error InsufficientBalanceForWithdrawal();

  // Timeout Errors
  /// @notice Reverts if a user tries to cancel a prompt before the cancellation timeout has passed.
  error PromptNotCancellableYet();
  /// @notice Reverts if a keeper tries to refund a prompt before the refund timeout has passed.
  error PromptNotRefundableYet();

  // --- Constructor ---

  /**
   * @notice Sets up the escrow smart contract.
   * @param _agentAddress The address of the SapphireAIAgent contract to interact with.
   * @param _treasuryAddress The initial address where collected fees will be sent.
   * @param _initialOwner The address that will have ownership of this contract.
   * @param _initialPromptFee The initial fee for a single AI prompt.
   * @param _initialCancellationFee The initial fee for cancelling a prompt.
   * @param _initialMetadataUpdateFee The initial fee for updating metadata.
   * @param _initialBranchFee The initial fee for branching a conversation.
   */
  constructor(
    address _agentAddress,
    address _treasuryAddress,
    address _initialOwner,
    uint256 _initialPromptFee,
    uint256 _initialCancellationFee,
    uint256 _initialMetadataUpdateFee,
    uint256 _initialBranchFee
  ) Ownable(_initialOwner) {
    if (_agentAddress == address(0) || _treasuryAddress == address(0)) {
      revert ZeroAddress();
    }
    sapphireAIAgent = ISapphireAIAgent(_agentAddress);
    treasury = _treasuryAddress;
    promptFee = _initialPromptFee;
    cancellationFee = _initialCancellationFee;
    metadataUpdateFee = _initialMetadataUpdateFee;
    branchFee = _initialBranchFee;
  }

  // --- Modifiers ---

  /**
   * @notice Checks that the caller is the registered SapphireAIAgent contract.
   */
  modifier onlySapphireAIAgent() {
    if (msg.sender != address(sapphireAIAgent)) {
      revert NotSapphireAIAgent();
    }
    _;
  }

  /**
   * @notice Checks that the caller is the authorized oracle.
   */
  modifier onlyOracle() {
    if (msg.sender != sapphireAIAgent.oracle()) {
      revert NotOracle();
    }
    _;
  }

  // --- Administrative Functions ---

  /**
   * @notice Updates the treasury address where collected fees will be sent.
   * @dev Only the contract owner can call this function.
   * @param _newTreasury The new treasury address.
   */
  function setTreasury(address _newTreasury) external onlyOwner {
    if (_newTreasury == address(0)) {
      revert ZeroAddress();
    }
    treasury = _newTreasury;
    emit TreasuryUpdated(_newTreasury);
  }

  /**
   * @notice Sets the fee required for one AI prompt.
   * @dev Only the contract owner can call this function.
   * @param _newFee The new prompt fee.
   */
  function setPromptFee(uint256 _newFee) external onlyOwner {
    promptFee = _newFee;
    emit PromptFeeUpdated(_newFee);
  }

  /**
   * @notice Sets the fee required for a user to cancel a pending prompt.
   * @dev Only the contract owner can call this function.
   * @param _newFee The new cancellation fee.
   */
  function setCancellationFee(uint256 _newFee) external onlyOwner {
    cancellationFee = _newFee;
    emit CancellationFeeUpdated(_newFee);
  }

  /**
   * @notice Sets the fee required for a user to update conversation metadata.
   * @dev Only the contract owner can call this function.
   * @param _newFee The new metadata update fee.
   */
  function setMetadataUpdateFee(uint256 _newFee) external onlyOwner {
    metadataUpdateFee = _newFee;
    emit MetadataUpdateFeeUpdated(_newFee);
  }

  /**
   * @notice Sets the fee required for a user to branch a conversation.
   * @dev Only the contract owner can call this function.
   * @param _newFee The new branch fee.
   */
  function setBranchFee(uint256 _newFee) external onlyOwner {
    branchFee = _newFee;
    emit BranchFeeUpdated(_newFee);
  }

  // --- Spending Limit and Deposit Management ---

  /**
   * @notice Allows a user to deposit native tokens (e.g., ROSE/TEST) to fund their usage.
   */
  function deposit() external payable {
    deposits[msg.sender] += msg.value;
    emit DepositReceived(msg.sender, msg.value);
  }

  /**
   * @notice Allows a user to withdraw their unused deposited funds.
   * @dev Can only be called if there are no pending prompts to ensure funds aren't orphaned.
   * @param _amount The amount of native tokens to withdraw.
   */
  function withdraw(uint256 _amount) external {
    if (pendingEscrowCount[msg.sender] > 0) {
      revert HasPendingPrompts();
    }
    if (deposits[msg.sender] < _amount) {
      revert InsufficientBalanceForWithdrawal();
    }
    deposits[msg.sender] -= _amount;
    emit Withdrawal(msg.sender, _amount);
    payable(msg.sender).transfer(_amount);
  }

  /**
   * @notice Sets or updates a user's usage allowance term.
   * @dev Can only be called if there are no pending prompts.
   * @param _expiresAt The unix timestamp when this allowance term becomes invalid.
   */
  function setSpendingLimit(uint256 _expiresAt) external {
    if (pendingEscrowCount[msg.sender] > 0) {
      revert HasPendingPrompts();
    }
    spendingLimits[msg.sender] = SpendingLimit({ expiresAt: _expiresAt });
    emit SpendingLimitSet(msg.sender, _expiresAt);
  }

  /**
   * @notice Cancels a user's usage allowance and refunds their entire deposit.
   * @dev This function can only be called if the user has no prompts currently
   *      in the PENDING state to prevent orphaning funds.
   */
  function cancelSpendingLimit() external {
    if (pendingEscrowCount[msg.sender] > 0) {
      revert HasPendingPrompts();
    }
    uint256 depositAmount = deposits[msg.sender];
    delete spendingLimits[msg.sender];
    delete deposits[msg.sender];
    emit SpendingLimitCancelled(msg.sender);
    if (depositAmount > 0) {
      emit Withdrawal(msg.sender, depositAmount);
      payable(msg.sender).transfer(depositAmount);
    }
  }

  // --- Core User and Agent Functions ---

  /**
   * @notice Initiates a new prompt request from a user.
   * @dev This is the main entry point for all user prompts. It handles payment escrow
   *      and triggers the AI Agent contract to log the prompt.
   * @dev If _conversationId is 0, it reserves a new conversation ID.
   * @param _conversationId The ID of the conversation. Pass 0 to start a new conversation.
   * @param _payload The plaintext user prompt intended for the TEE.
   */
  function initiatePrompt(uint256 _conversationId, string calldata _payload) external {
    _processEscrowPayment(msg.sender, promptFee);

    uint256 conversationId = _conversationId;
    if (conversationId == 0) {
      conversationId = sapphireAIAgent.reserveConversationId();
    }

    uint256 promptMessageId = sapphireAIAgent.reserveMessageId();
    uint256 answerMessageId = sapphireAIAgent.reserveMessageId();
    uint256 escrowId = answerMessageId;
    escrows[escrowId] = Escrow({
      user: msg.sender,
      amount: promptFee,
      createdAt: block.timestamp,
      status: EscrowStatus.PENDING
    });

    emit PaymentEscrowed(escrowId, msg.sender, promptFee);
    sapphireAIAgent.submitPrompt(
      msg.sender,
      conversationId,
      promptMessageId,
      answerMessageId,
      _payload
    );
  }

  /**
   * @notice Initiates a new regeneration request for a previous answer.
   * @dev This function escrows the standard prompt fee and triggers the AI Agent contract.
   * @param _conversationId The ID of the conversation this regeneration belongs to.
   * @param _promptMessageId The ID of the user's prompt that is being regenerated.
   * @param _previousAnswerMessageId The ID of the specific AI answer the user wants to regenerate from.
   * @param _payload The plaintext instructions for the TEE (e.g., "make it more concise").
   */
  function initiateRegeneration(
    uint256 _conversationId,
    uint256 _promptMessageId,
    uint256 _previousAnswerMessageId,
    string calldata _payload
  ) external {
    _processEscrowPayment(msg.sender, promptFee);

    uint256 answerMessageId = sapphireAIAgent.reserveMessageId();
    uint256 escrowId = answerMessageId;
    escrows[escrowId] = Escrow({
      user: msg.sender,
      amount: promptFee,
      createdAt: block.timestamp,
      status: EscrowStatus.PENDING
    });

    emit PaymentEscrowed(escrowId, msg.sender, promptFee);
    sapphireAIAgent.submitRegenerationRequest(
      msg.sender,
      _conversationId,
      _promptMessageId,
      _previousAnswerMessageId,
      answerMessageId,
      _payload
    );
  }

  /**
   * @notice Initiates a new autonomous agent job on behalf of a user.
   * @dev Called by the oracle. If _jobId is 0, it reserves a new job ID.
   * @param _user The address of the user for whom the job is being run.
   * @param _jobId The ID of the parent job. Pass 0 to start a new job.
   * @param _payload The plaintext prompt data for the TEE.
   */
  function initiateAgentJob(
    address _user,
    uint256 _jobId,
    string calldata _payload
  ) external onlyOracle {
    _processEscrowPayment(_user, promptFee);

    uint256 jobId = _jobId;
    if (jobId == 0) {
      jobId = sapphireAIAgent.reserveJobId();
    }

    uint256 triggerId = sapphireAIAgent.reserveTriggerId();
    uint256 escrowId = triggerId;
    escrows[escrowId] = Escrow({
      user: _user,
      amount: promptFee,
      createdAt: block.timestamp,
      status: EscrowStatus.PENDING
    });

    emit PaymentEscrowed(escrowId, _user, promptFee);
    sapphireAIAgent.submitAgentJob(_user, jobId, triggerId, _payload);
  }

  /**
   * @notice Allows a user to initiate the process of branching a conversation.
   * @dev Charges a fixed `branchFee`, reserves a new conversation ID, and emits an event for the TEE.
   * @param _originalConversationId The ID of the conversation being branched from.
   * @param _branchPointMessageId The ID of the message where the branch occurs.
   * @param _payload The plaintext context (e.g., original title) for the TEE.
   */
  function initiateBranch(
    uint256 _originalConversationId,
    uint256 _branchPointMessageId,
    string calldata _payload
  ) external {
    _processDirectPayment(msg.sender, branchFee);

    uint256 newConversationId = sapphireAIAgent.reserveConversationId();

    sapphireAIAgent.submitBranchRequest(
      msg.sender,
      _originalConversationId,
      _branchPointMessageId,
      newConversationId,
      _payload
    );
  }

  /**
   * @notice Allows a user to cancel their own pending prompt.
   * @dev Charges a fixed `cancellationFee` from the user's deposit and refunds the original `promptFee`.
   * @param _answerMessageId The ID of the answer message to cancel.
   */
  function cancelPrompt(uint256 _answerMessageId) external {
    uint256 escrowId = _answerMessageId;
    Escrow storage escrow = escrows[escrowId];

    if (escrow.user != msg.sender) {
      revert NotPromptOwner();
    }
    if (escrow.status != EscrowStatus.PENDING) {
      revert EscrowNotPending();
    }
    if (block.timestamp < escrow.createdAt + CANCELLATION_TIMEOUT) {
      revert PromptNotCancellableYet();
    }
    if (deposits[msg.sender] < cancellationFee) {
      revert InsufficientDeposit();
    }

    pendingEscrowCount[msg.sender]--;
    escrow.status = EscrowStatus.REFUNDED;
    // Charge cancellation fee and refund original prompt fee in one operation.
    deposits[msg.sender] = deposits[msg.sender] + escrow.amount - cancellationFee;

    payable(treasury).transfer(cancellationFee);
    sapphireAIAgent.recordCancellation(msg.sender, _answerMessageId);

    emit PromptCancelled(msg.sender, _answerMessageId);
  }

  /**
   * @notice Allows a user to request an update to a conversation's metadata, such as its title.
   * @dev Charges a fixed `metadataUpdateFee` from the user's deposit.
   * @param _conversationId The ID of the conversation to update.
   * @param _payload The plaintext ABI-encoded update instructions for the TEE.
   */
  function initiateMetadataUpdate(uint256 _conversationId, string calldata _payload) external {
    _processDirectPayment(msg.sender, metadataUpdateFee);

    sapphireAIAgent.submitMetadataUpdate(msg.sender, _conversationId, _payload);
  }

  // --- Core System Functions ---

  /**
   * @notice Releases the escrowed payment to the treasury upon successful completion.
   * @dev Called by the SapphireAIAgent contract.
   * @param _escrowId The unique identifier of the job to finalize.
   */
  function finalizePayment(uint256 _escrowId) external onlySapphireAIAgent {
    Escrow storage escrow = escrows[_escrowId];

    if (escrow.user == address(0)) {
      revert EscrowNotFound();
    }
    if (escrow.status != EscrowStatus.PENDING) {
      revert EscrowNotPending();
    }

    pendingEscrowCount[escrow.user]--;
    escrow.status = EscrowStatus.COMPLETE;
    emit PaymentFinalized(_escrowId);
    payable(treasury).transfer(escrow.amount);
  }

  /**
   * @notice Refunds any pending escrows that have passed the timeout period.
   * @dev Called by a keeper service to prevent funds from being stuck.
   * @param _answerMessageId The ID of the answer message to refund.
   */
  function processRefund(uint256 _answerMessageId) external {
    uint256 escrowId = _answerMessageId;
    Escrow storage escrow = escrows[escrowId];

    if (escrow.user == address(0)) {
      return; // Silently ignore if no escrow exists
    }
    if (escrow.status != EscrowStatus.PENDING) {
      revert EscrowNotPending();
    }
    if (block.timestamp < escrow.createdAt + REFUND_TIMEOUT) {
      revert PromptNotRefundableYet();
    }

    pendingEscrowCount[escrow.user]--;
    escrow.status = EscrowStatus.REFUNDED;
    // Refund the escrowed amount back to the user's internal deposit balance.
    deposits[escrow.user] += escrow.amount;

    emit PaymentRefunded(escrowId);
  }

  // --- Internal Helper Functions ---

  /**
   * @dev Internal function to handle the spending limit checks and state changes for an escrowed payment.
   * @param _user The user address initiating the action.
   * @param _fee The fee for the action.
   */
  function _processEscrowPayment(address _user, uint256 _fee) private {
    SpendingLimit storage sub = spendingLimits[_user];

    if (sub.expiresAt == 0) {
      revert NoActiveSpendingLimit();
    }
    if (block.timestamp >= sub.expiresAt) {
      revert SpendingLimitExpired();
    }
    if (deposits[_user] < _fee) {
      revert InsufficientDeposit();
    }

    deposits[_user] -= _fee;
    pendingEscrowCount[_user]++;
  }

  /**
   * @dev Internal function to handle the spending limit checks and state changes for a direct-to-treasury payment.
   * @param _user The user address initiating the action.
   * @param _fee The fee for the action.
   */
  function _processDirectPayment(address _user, uint256 _fee) private {
    SpendingLimit storage sub = spendingLimits[_user];

    if (sub.expiresAt == 0) {
      revert NoActiveSpendingLimit();
    }
    if (block.timestamp >= sub.expiresAt) {
      revert SpendingLimitExpired();
    }
    if (deposits[_user] < _fee) {
      revert InsufficientDeposit();
    }

    deposits[_user] -= _fee;
    payable(treasury).transfer(_fee);
  }
}
