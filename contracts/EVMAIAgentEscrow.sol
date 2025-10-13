// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IEVMAIAgent } from "./interfaces/IEVMAIAgent.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/**
 * @title EVM AI Agent Escrow Contract
 * @dev This contract manages ERC20 token payments, fees, and refunds for the EVM AI Agent.
 *      It is upgradeable using the UUPS proxy pattern.
 */
contract EVMAIAgentEscrow is Initializable, OwnableUpgradeable, UUPSUpgradeable {
  // --- Constants ---

  /// @notice The time after which a user can cancel their own pending prompt to prevent mis-clicks.
  uint256 public constant CANCELLATION_TIMEOUT = 3 seconds;
  /// @notice The time after which a keeper can refund any timed-out pending prompt.
  uint256 public constant REFUND_TIMEOUT = 1 hours;

  // --- State Variables ---

  /// @notice The ERC20 token used for payments.
  IERC20 public ableToken;
  /// @notice The AI Agent contract this escrow serves.
  IEVMAIAgent public evmAIAgent;

  /// @notice The address where collected fees are sent.
  address public treasury;
  /// @notice The address of the authorized off-chain oracle.
  address public oracle;

  /// @notice The fee in the token's smallest unit required for one AI prompt.
  uint256 public promptFee;
  /// @notice The fee charged to a user for cancelling a pending prompt.
  uint256 public cancellationFee;
  /// @notice The fee charged to a user for updating conversation metadata.
  uint256 public metadataUpdateFee;
  /// @notice The fee charged to a user for branching a conversation.
  uint256 public branchFee;

  /// @notice Represents a user's usage allowance details.
  struct Subscription {
    uint256 allowance; // The total amount the user has authorized via ERC20 approve.
    uint256 spentAmount; // The amount spent so far within this subscription.
    uint256 expiresAt; // The unix timestamp when the subscription expires.
  }

  /// @notice Tracks each user's allowance details.
  mapping(address => Subscription) public subscriptions;
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

  /// @notice Maps a message ID or trigger ID to its escrow details.
  mapping(uint256 => Escrow) public escrows;

  // --- Events ---

  /// @notice Emitted when the treasury address is updated.
  event TreasuryUpdated(address newTreasury);
  /// @notice Emitted when the oracle address is updated.
  event OracleUpdated(address newOracle);
  /// @notice Emitted when the prompt fee is updated.
  event PromptFeeUpdated(uint256 newFee);
  /// @notice Emitted when the cancellation fee is updated.
  event CancellationFeeUpdated(uint256 newFee);
  /// @notice Emitted when the metadata update fee is updated.
  event MetadataUpdateFeeUpdated(uint256 newFee);
  /// @notice Emitted when the conversation branch fee is updated.
  event BranchFeeUpdated(uint256 newFee);
  /// @notice Emitted when a user sets or updates their allowance.
  event SubscriptionSet(address indexed user, uint256 allowance, uint256 expiresAt);
  /// @notice Emitted when a user cancels their allowance.
  event SubscriptionCancelled(address indexed user);
  /// @notice Emitted when a user's payment is successfully placed in escrow.
  event PaymentEscrowed(uint256 indexed answerMessageId, address indexed user, uint256 amount);
  /// @notice Emitted when an escrowed payment is finalized and sent to the treasury.
  event PaymentFinalized(uint256 indexed answerMessageId);
  /// @notice Emitted when a timed-out escrowed payment is refunded to the user's wallet.
  event PaymentRefunded(uint256 indexed answerMessageId);
  /// @notice Emitted when a user cancels their own pending prompt.
  event PromptCancelled(uint256 indexed answerMessageId, address indexed user);

  // --- Errors ---

  /// @notice Reverts if an escrow record is not found for a given ID.
  error EscrowNotFound();
  /// @notice Reverts if an action is attempted on an escrow that is not in the PENDING state.
  error EscrowNotPending();
  /// @notice Reverts if a user tries to submit a prompt without an active allowance term.
  error NoActiveSubscription();
  /// @notice Reverts if a user tries to submit a prompt with an expired allowance term.
  error SubscriptionExpired();
  /// @notice Reverts if a user's remaining allowance is insufficient to cover a fee.
  error InsufficientSubscriptionAllowance();
  /// @notice Reverts if a function is called by an address other than the linked AI Agent contract.
  error NotEVMAIAgent();
  /// @notice Reverts if a function is called by an address that is not the authorized oracle.
  error NotOracle();
  /// @notice Reverts if an address parameter is the zero address.
  error ZeroAddress();
  /// @notice Reverts if a user tries to manage a subscription while having pending prompts.
  error HasPendingPrompts();
  /// @notice Reverts if a user tries to cancel a prompt before the cancellation timeout has passed.
  error PromptNotCancellableYet();
  /// @notice Reverts if a keeper tries to refund a prompt before the refund timeout has passed.
  error PromptNotRefundableYet();
  /// @notice Reverts if a user tries to cancel a prompt they do not own.
  error NotPromptOwner();

  // --- Initialization ---

  /**
   * @notice Sets up the escrow smart contract.
   * @param _tokenAddress The address of the ERC20 token contract.
   * @param _agentAddress The address of the EVMAIAgent contract to interact with.
   * @param _treasuryAddress The initial address where collected fees will be sent.
   * @param _oracleAddress The initial address of the authorized oracle.
   * @param _initialOwner The address that will have ownership of this contract's proxy.
   * @param _initialPromptFee The initial fee for a single AI prompt.
   * @param _initialCancellationFee The initial fee for cancelling a prompt.
   * @param _initialMetadataUpdateFee The initial fee for updating metadata.
   * @param _initialBranchFee The initial fee for branching a conversation.
   */
  function initialize(
    address _tokenAddress,
    address _agentAddress,
    address _treasuryAddress,
    address _oracleAddress,
    address _initialOwner,
    uint256 _initialPromptFee,
    uint256 _initialCancellationFee,
    uint256 _initialMetadataUpdateFee,
    uint256 _initialBranchFee
  ) public initializer {
    __Ownable_init(_initialOwner);
    __UUPSUpgradeable_init();
    if (
      _tokenAddress == address(0) ||
      _agentAddress == address(0) ||
      _treasuryAddress == address(0) ||
      _oracleAddress == address(0)
    ) {
      revert ZeroAddress();
    }
    ableToken = IERC20(_tokenAddress);
    evmAIAgent = IEVMAIAgent(_agentAddress);
    treasury = _treasuryAddress;
    oracle = _oracleAddress;
    promptFee = _initialPromptFee;
    cancellationFee = _initialCancellationFee;
    metadataUpdateFee = _initialMetadataUpdateFee;
    branchFee = _initialBranchFee;
  }

  // --- Modifiers ---

  /**
   * @notice Checks that the caller is the registered EVMAIAgent contract.
   */
  modifier onlyEVMAIAgent() {
    if (msg.sender != address(evmAIAgent)) {
      revert NotEVMAIAgent();
    }
    _;
  }

  /**
   * @notice Checks that the caller is the authorized oracle.
   */
  modifier onlyOracle() {
    if (msg.sender != oracle) {
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
   * @notice Updates the oracle address.
   * @dev Only the contract owner can call this function.
   * @param _newOracle The new oracle address.
   */
  function setOracle(address _newOracle) external onlyOwner {
    if (_newOracle == address(0)) {
      revert ZeroAddress();
    }
    oracle = _newOracle;
    emit OracleUpdated(_newOracle);
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

  // --- Subscription Management ---

  /**
   * @notice Sets or updates a user's usage allowance.
   * @dev To ensure state integrity, a user can only set a new allowance when they
   *      have no prompts in the PENDING state. This resets their spending for a new period.
   * @param _allowance The total amount of tokens authorized for the allowance period.
   * @param _expiresAt The unix timestamp when this allowance becomes invalid.
   */
  function setSubscription(uint256 _allowance, uint256 _expiresAt) external {
    if (pendingEscrowCount[msg.sender] > 0) {
      revert HasPendingPrompts();
    }
    subscriptions[msg.sender] = Subscription({
      allowance: _allowance,
      spentAmount: 0,
      expiresAt: _expiresAt
    });
    emit SubscriptionSet(msg.sender, _allowance, _expiresAt);
  }

  /**
   * @notice Cancels a user's usage allowance term.
   * @dev This function can only be called if the user has no prompts currently
   *      in the PENDING state to prevent orphaning funds.
   */
  function cancelSubscription() external {
    if (pendingEscrowCount[msg.sender] > 0) {
      revert HasPendingPrompts();
    }
    delete subscriptions[msg.sender];
    emit SubscriptionCancelled(msg.sender);
  }

  // --- Core User and Agent Functions ---

  /**
   * @notice Initiates a new prompt request from a user.
   * @dev This is the main entry point for all user prompts. It handles payment escrow
   *      and triggers the AI Agent contract to log the prompt.
   * @param _conversationId The ID of the conversation. Pass 0 to start a new conversation.
   * @param _encryptedPayload The encrypted user prompt intended for the TEE.
   * @param _roflEncryptedKey The session key, encrypted for the ROFL worker.
   */
  function initiatePrompt(
    uint256 _conversationId,
    bytes calldata _encryptedPayload,
    bytes calldata _roflEncryptedKey
  ) external {
    Subscription storage sub = subscriptions[msg.sender];

    if (sub.expiresAt == 0) {
      revert NoActiveSubscription();
    }
    if (block.timestamp >= sub.expiresAt) {
      revert SubscriptionExpired();
    }
    if (sub.spentAmount + promptFee > sub.allowance) {
      revert InsufficientSubscriptionAllowance();
    }

    sub.spentAmount += promptFee;
    pendingEscrowCount[msg.sender]++;
    ableToken.transferFrom(msg.sender, address(this), promptFee);

    uint256 promptMessageId = evmAIAgent.reserveMessageId();
    uint256 answerMessageId = evmAIAgent.reserveMessageId();
    escrows[answerMessageId] = Escrow({
      user: msg.sender,
      amount: promptFee,
      createdAt: block.timestamp,
      status: EscrowStatus.PENDING
    });

    emit PaymentEscrowed(answerMessageId, msg.sender, promptFee);
    evmAIAgent.submitPrompt(
      promptMessageId,
      answerMessageId,
      _conversationId,
      msg.sender,
      _encryptedPayload,
      _roflEncryptedKey
    );
  }

  /**
   * @notice Initiates a new regeneration request for a previous answer.
   * @dev This function escrows the standard prompt fee and triggers the AI Agent contract
   *      to log the regeneration request for the TEE.
   * @param _promptMessageId The ID of the user's prompt that is being regenerated.
   * @param _previousAnswerMessageId The ID of the specific AI answer the user wants to regenerate from.
   * @param _encryptedPayload The encrypted instructions for the TEE (e.g., "make it more concise").
   * @param _roflEncryptedKey The session key, encrypted for the ROFL worker.
   */
  function initiateRegeneration(
    uint256 _promptMessageId,
    uint256 _previousAnswerMessageId,
    bytes calldata _encryptedPayload,
    bytes calldata _roflEncryptedKey
  ) external {
    Subscription storage sub = subscriptions[msg.sender];

    if (sub.expiresAt == 0) {
      revert NoActiveSubscription();
    }
    if (block.timestamp >= sub.expiresAt) {
      revert SubscriptionExpired();
    }
    if (sub.spentAmount + promptFee > sub.allowance) {
      revert InsufficientSubscriptionAllowance();
    }

    sub.spentAmount += promptFee;
    pendingEscrowCount[msg.sender]++;
    ableToken.transferFrom(msg.sender, address(this), promptFee);

    uint256 answerMessageId = evmAIAgent.reserveMessageId();

    escrows[answerMessageId] = Escrow({
      user: msg.sender,
      amount: promptFee,
      createdAt: block.timestamp,
      status: EscrowStatus.PENDING
    });

    emit PaymentEscrowed(answerMessageId, msg.sender, promptFee);

    evmAIAgent.submitRegenerationRequest(
      msg.sender,
      _promptMessageId,
      _previousAnswerMessageId,
      answerMessageId,
      _encryptedPayload,
      _roflEncryptedKey
    );
  }

  /**
   * @notice Initiates a new autonomous agent job on behalf of a user.
   * @dev Called by the oracle for event- or schedule-triggered jobs.
   * @param _user The address of the user for whom the job is being run.
   * @param _jobId The ID of the parent job. Pass 0 to start a new job.
   * @param _encryptedPayload The encrypted prompt data for the TEE.
   * @param _roflEncryptedKey The session key, encrypted for the ROFL worker.
   */
  function initiateAgentJob(
    address _user,
    uint256 _jobId,
    bytes calldata _encryptedPayload,
    bytes calldata _roflEncryptedKey
  ) external onlyOracle {
    Subscription storage sub = subscriptions[_user];

    if (sub.expiresAt == 0) {
      revert NoActiveSubscription();
    }
    if (block.timestamp >= sub.expiresAt) {
      revert SubscriptionExpired();
    }
    if (sub.spentAmount + promptFee > sub.allowance) {
      revert InsufficientSubscriptionAllowance();
    }

    sub.spentAmount += promptFee;
    pendingEscrowCount[_user]++;
    ableToken.transferFrom(_user, address(this), promptFee);

    uint256 triggerId = evmAIAgent.reserveTriggerId();
    escrows[triggerId] = Escrow({
      user: _user,
      amount: promptFee,
      createdAt: block.timestamp,
      status: EscrowStatus.PENDING
    });

    emit PaymentEscrowed(triggerId, _user, promptFee);
    evmAIAgent.submitAgentJob(triggerId, _jobId, _user, _encryptedPayload, _roflEncryptedKey);
  }

  /**
   * @notice Allows a user to initiate the process of branching a conversation.
   * @dev Charges a fixed `branchFee` and emits an event for the TEE to process the request.
   * @param _originalConversationId The ID of the conversation being branched from.
   * @param _branchPointMessageId The ID of the message where the branch occurs.
   */
  function initiateBranch(uint256 _originalConversationId, uint256 _branchPointMessageId) external {
    Subscription storage sub = subscriptions[msg.sender];
    if (sub.expiresAt == 0) {
      revert NoActiveSubscription();
    }
    if (block.timestamp >= sub.expiresAt) {
      revert SubscriptionExpired();
    }
    if (sub.spentAmount + branchFee > sub.allowance) {
      revert InsufficientSubscriptionAllowance();
    }

    sub.spentAmount += branchFee;
    sub.allowance -= branchFee;
    ableToken.transferFrom(msg.sender, treasury, branchFee);

    evmAIAgent.submitBranchRequest(msg.sender, _originalConversationId, _branchPointMessageId);
  }

  /**
   * @notice Allows a user to cancel their own pending prompt.
   * @dev Charges a fixed `cancellationFee` and refunds the original `promptFee`.
   * @param _answerMessageId The ID of the answer message to cancel.
   */
  function cancelPrompt(uint256 _answerMessageId) external {
    Escrow storage escrow = escrows[_answerMessageId];
    Subscription storage sub = subscriptions[msg.sender];

    if (escrow.user != msg.sender) {
      revert NotPromptOwner();
    }
    if (escrow.status != EscrowStatus.PENDING) {
      revert EscrowNotPending();
    }
    if (block.timestamp < escrow.createdAt + CANCELLATION_TIMEOUT) {
      revert PromptNotCancellableYet();
    }

    sub.spentAmount -= escrow.amount;
    sub.allowance -= escrow.amount;

    if (sub.allowance < sub.spentAmount + cancellationFee) {
      revert InsufficientSubscriptionAllowance();
    }

    sub.spentAmount += cancellationFee;
    sub.allowance -= cancellationFee;
    ableToken.transferFrom(msg.sender, treasury, cancellationFee);

    pendingEscrowCount[msg.sender]--;
    escrow.status = EscrowStatus.REFUNDED;

    evmAIAgent.recordCancellation(_answerMessageId, msg.sender);
    ableToken.transfer(escrow.user, escrow.amount);
    emit PromptCancelled(_answerMessageId, msg.sender);
  }

  /**
   * @notice Allows a user to request an update to a conversation's metadata, such as its title.
   * @dev Charges a fixed `metadataUpdateFee` from the user's subscription allowance.
   * @param _conversationId The ID of the conversation to update.
   * @param _encryptedPayload The encrypted ABI-encoded update instructions for the TEE.
   * @param _roflEncryptedKey The session key, encrypted for the ROFL worker.
   */
  function initiateMetadataUpdate(
    uint256 _conversationId,
    bytes calldata _encryptedPayload,
    bytes calldata _roflEncryptedKey
  ) external {
    Subscription storage sub = subscriptions[msg.sender];

    if (sub.expiresAt == 0) {
      revert NoActiveSubscription();
    }
    if (block.timestamp >= sub.expiresAt) {
      revert SubscriptionExpired();
    }
    if (sub.spentAmount + metadataUpdateFee > sub.allowance) {
      revert InsufficientSubscriptionAllowance();
    }

    sub.spentAmount += metadataUpdateFee;
    sub.allowance -= metadataUpdateFee;

    ableToken.transferFrom(msg.sender, treasury, metadataUpdateFee);
    evmAIAgent.submitMetadataUpdate(
      _conversationId,
      msg.sender,
      _encryptedPayload,
      _roflEncryptedKey
    );
  }

  // --- Core System Functions ---

  /**
   * @notice Releases the escrowed payment to the treasury upon successful completion.
   * @dev Called by the EVMAIAgent contract.
   * @param _answerMessageId The unique identifier of the prompt to finalize.
   */
  function finalizePayment(uint256 _answerMessageId) external onlyEVMAIAgent {
    Escrow storage escrow = escrows[_answerMessageId];

    if (escrow.user == address(0)) {
      revert EscrowNotFound();
    }
    if (escrow.status != EscrowStatus.PENDING) {
      revert EscrowNotPending();
    }

    pendingEscrowCount[escrow.user]--;
    escrow.status = EscrowStatus.COMPLETE;
    emit PaymentFinalized(_answerMessageId);
    ableToken.transfer(treasury, escrow.amount);
  }

  /**
   * @notice Refunds any pending escrows that have passed the timeout period.
   * @dev Called by a keeper service to prevent funds from being stuck.
   * @param _answerMessageId The message ID to check for a potential refund.
   */
  function processRefund(uint256 _answerMessageId) external {
    Escrow storage escrow = escrows[_answerMessageId];

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

    subscriptions[escrow.user].spentAmount -= escrow.amount;
    subscriptions[escrow.user].allowance -= escrow.amount;

    emit PaymentRefunded(_answerMessageId);
    ableToken.transfer(escrow.user, escrow.amount);
  }

  // --- Upgradability ---

  /**
   * @dev Authorizes an upgrade to a new implementation contract.
   *      This internal function is part of the UUPS upgrade mechanism and is restricted to the owner.
   * @param _newImplementation The address of the new implementation contract.
   */
  function _authorizeUpgrade(address _newImplementation) internal override onlyOwner {
    // solhint-disable-previous-line no-empty-blocks
    // Intentionally left blank. The onlyOwner modifier provides the necessary access control.
  }

  uint256[36] private __gap;
}
