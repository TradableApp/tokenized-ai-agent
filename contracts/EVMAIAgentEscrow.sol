// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IEVMAIAgent } from "./interfaces/IEVMAIAgent.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/**
 * @title EVM AI Agent Escrow Contract
 * @dev This contract manages ERC20 token payments and refunds for the EVM AI Agent.
 *      It is upgradeable using the UUPS proxy pattern.
 */
contract EVMAIAgentEscrow is Initializable, OwnableUpgradeable, UUPSUpgradeable {
  /// @notice The ERC20 token used for payments.
  IERC20 public ableToken;
  /// @notice The AI Agent contract this escrow serves.
  IEVMAIAgent public evmAIAgent;

  /// @notice The address where collected fees are sent upon successful prompt completion.
  address public treasury;
  /// @notice The address of the authorized off-chain oracle.
  address public oracle;

  /// @notice The fee in the token's smallest unit required for one AI prompt.
  uint256 public constant PROMPT_FEE = 1 * 1e18;
  /// @notice The time after which a user can cancel their own pending prompt.
  uint256 public constant CANCELLATION_TIMEOUT = 5 minutes;
  /// @notice The time after which a keeper can refund any timed-out pending prompt.
  uint256 public constant REFUND_TIMEOUT = 1 hours;

  /// @notice Represents a user's usage allowance details.
  struct Subscription {
    uint256 allowance; // The total amount the user has authorized.
    uint256 spentAmount; // The amount spent so far.
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

  /// @notice Maps a prompt ID to its escrow details.
  mapping(uint256 => Escrow) public escrows;

  /// @notice Emitted when the treasury address is updated.
  event TreasuryUpdated(address newTreasury);
  /// @notice Emitted when the oracle address is updated.
  event OracleUpdated(address newOracle);
  /// @notice Emitted when a user sets or updates their allowance.
  event SubscriptionSet(address indexed user, uint256 allowance, uint256 expiresAt);
  /// @notice Emitted when a user cancels their allowance.
  event SubscriptionCancelled(address indexed user);
  /// @notice Emitted when a user's payment is successfully placed in escrow.
  event PaymentEscrowed(uint256 indexed promptId, address indexed user, uint256 amount);
  /// @notice Emitted when an escrowed payment is finalized and sent to the treasury.
  event PaymentFinalized(uint256 indexed promptId);
  /// @notice Emitted when a timed-out escrowed payment is refunded to the user's wallet.
  event PaymentRefunded(uint256 indexed promptId);
  /// @notice Emitted when a user cancels their own pending prompt.
  event PromptCancelled(uint256 indexed promptId, address indexed user);

  /// @notice Reverts if an escrow record is not found for a given prompt ID.
  error EscrowNotFound();
  /// @notice Reverts if an action is attempted on an escrow that is not in the PENDING state.
  error EscrowNotPending();
  /// @notice Reverts if a user tries to submit a prompt without an active allowance term.
  error NoActiveSubscription();
  /// @notice Reverts if a user tries to submit a prompt with an expired allowance term.
  error SubscriptionExpired();
  /// @notice Reverts if a user's remaining allowance is insufficient to cover the prompt fee.
  error InsufficientSubscriptionAllowance();
  /// @notice Reverts if a function is called by an address other than the linked AI Agent contract.
  error NotEVMAIAgent();
  /// @notice Reverts if a function is called by an address that is not the authorized oracle.
  error NotOracle();
  /// @notice Reverts if an address parameter is the zero address.
  error ZeroAddress();
  /// @notice Reverts if a user tries to cancel or set an allowance while having pending prompts.
  error HasPendingPrompts();
  /// @notice Reverts if a user tries to cancel a prompt before the cancellation timeout has passed.
  error PromptNotCancellableYet();
  /// @notice Reverts if a keeper tries to refund a prompt before the refund timeout has passed.
  error PromptNotRefundableYet();
  /// @notice Reverts if a user tries to cancel a prompt they do not own.
  error NotPromptOwner();

  /**
   * @notice Sets up the escrow smart contract.
   * @param _tokenAddress The address of the ERC20 token contract.
   * @param _agentAddress The address of the EVMAIAgent contract to interact with.
   * @param _treasuryAddress The initial address where collected fees will be sent.
   * @param _oracleAddress The initial address of the authorized oracle.
   * @param _initialOwner The address that will have ownership of this contract's proxy.
   */
  function initialize(
    address _tokenAddress,
    address _agentAddress,
    address _treasuryAddress,
    address _oracleAddress,
    address _initialOwner
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
  }

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
   * @notice Updates the oracle address that can initiate agent jobs.
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
      spentAmount: 0, // Reset spent amount for the new subscription period.
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

  /**
   * @notice Allows a user to cancel their own pending prompt after a timeout.
   * @dev This credits back the user's spent allowance and records the cancellation on the AIAgent contract.
   *      The timeout prevents griefing attacks against the oracle.
   * @param _promptId The ID of the prompt to cancel.
   */
  function cancelAndRefundPrompt(uint256 _promptId) external {
    Escrow storage escrow = escrows[_promptId];
    if (escrow.user != msg.sender) {
      revert NotPromptOwner();
    }
    if (escrow.status != EscrowStatus.PENDING) {
      revert EscrowNotPending();
    }
    if (block.timestamp < escrow.createdAt + CANCELLATION_TIMEOUT) {
      revert PromptNotCancellableYet();
    }
    pendingEscrowCount[msg.sender]--;
    escrow.status = EscrowStatus.REFUNDED;

    // Decrease both the spent amount AND the total allowance for this subscription period.
    // This keeps our internal accounting synchronized with the external ERC20 allowance.
    subscriptions[msg.sender].spentAmount -= escrow.amount;
    subscriptions[msg.sender].allowance -= escrow.amount;
    emit PromptCancelled(_promptId, msg.sender);
    evmAIAgent.storeCancellation(_promptId, msg.sender);
    ableToken.transfer(escrow.user, escrow.amount);
  }

  /**
   * @notice Initiates a new prompt request. Called by the user.
   * @param _encryptedContent The prompt, encrypted with a session key.
   * @param _userEncryptedKey The session key, encrypted for the user.
   * @param _roflEncryptedKey The session key, encrypted for the ROFL worker.
   */
  function initiatePrompt(
    bytes calldata _encryptedContent,
    bytes calldata _userEncryptedKey,
    bytes calldata _roflEncryptedKey
  ) external {
    _initiateJob(msg.sender, _encryptedContent, _userEncryptedKey, _roflEncryptedKey);
  }

  /**
   * @notice Initiates a new prompt request on behalf of a user.
   * @dev Called by the oracle for autonomous/scheduled jobs.
   * @param _user The address of the user for whom the job is being initiated.
   * @param _encryptedContent The prompt, encrypted with a session key.
   * @param _userEncryptedKey The session key, encrypted for the user.
   * @param _roflEncryptedKey The session key, encrypted for the ROFL worker.
   */
  function initiateAgentJob(
    address _user,
    bytes calldata _encryptedContent,
    bytes calldata _userEncryptedKey,
    bytes calldata _roflEncryptedKey
  ) external onlyOracle {
    _initiateJob(_user, _encryptedContent, _userEncryptedKey, _roflEncryptedKey);
  }

  /**
   * @dev Internal function to handle the core logic for any new job.
   */
  function _initiateJob(
    address _user,
    bytes calldata _encryptedContent,
    bytes calldata _userEncryptedKey,
    bytes calldata _roflEncryptedKey
  ) private {
    Subscription storage sub = subscriptions[_user];
    if (sub.expiresAt == 0) {
      revert NoActiveSubscription();
    }
    if (block.timestamp >= sub.expiresAt) {
      revert SubscriptionExpired();
    }
    if (sub.spentAmount + PROMPT_FEE > sub.allowance) {
      revert InsufficientSubscriptionAllowance();
    }
    sub.spentAmount += PROMPT_FEE;
    pendingEscrowCount[_user]++;
    ableToken.transferFrom(_user, address(this), PROMPT_FEE);
    uint256 promptId = evmAIAgent.promptIdCounter();
    escrows[promptId] = Escrow({
      user: _user,
      amount: PROMPT_FEE,
      createdAt: block.timestamp,
      status: EscrowStatus.PENDING
    });
    emit PaymentEscrowed(promptId, _user, PROMPT_FEE);
    evmAIAgent.submitPrompt(
      promptId,
      _user,
      _encryptedContent,
      _userEncryptedKey,
      _roflEncryptedKey
    );
  }

  /**
   * @notice Releases the escrowed payment to the treasury upon successful completion.
   * @dev Called by the EVMAIAgent contract.
   * @param _promptId The unique identifier of the prompt to finalize.
   */
  function finalizePayment(uint256 _promptId) external onlyEVMAIAgent {
    Escrow storage escrow = escrows[_promptId];
    if (escrow.user == address(0)) {
      revert EscrowNotFound();
    }
    if (escrow.status != EscrowStatus.PENDING) {
      revert EscrowNotPending();
    }
    pendingEscrowCount[escrow.user]--;
    escrow.status = EscrowStatus.COMPLETE;
    emit PaymentFinalized(_promptId);
    ableToken.transfer(treasury, escrow.amount);
  }

  /**
   * @notice Refunds any pending escrows that have passed the timeout period.
   * @dev Called by a keeper service.
   * @param _promptId The prompt ID to check for a potential refund.
   */
  function processRefund(uint256 _promptId) external {
    Escrow storage escrow = escrows[_promptId];
    if (escrow.user == address(0)) {
      return;
    }
    if (escrow.status != EscrowStatus.PENDING) {
      revert EscrowNotPending();
    }
    if (block.timestamp < escrow.createdAt + REFUND_TIMEOUT) {
      revert PromptNotRefundableYet();
    }
    pendingEscrowCount[escrow.user]--;
    escrow.status = EscrowStatus.REFUNDED;

    // Decrease both the spent amount AND the total allowance for this subscription period.
    // This keeps our internal accounting synchronized with the external ERC20 allowance.
    subscriptions[escrow.user].spentAmount -= escrow.amount;
    subscriptions[escrow.user].allowance -= escrow.amount;

    emit PaymentRefunded(_promptId);
    ableToken.transfer(escrow.user, escrow.amount);
  }

  /**
   * @dev Authorizes an upgrade to a new implementation contract.
   *      This internal function is part of the UUPS upgrade mechanism and is restricted to the owner.
   * @param _newImplementation The address of the new implementation contract.
   */
  function _authorizeUpgrade(address _newImplementation) internal override onlyOwner {
    // solhint-disable-previous-line no-empty-blocks
    // Intentionally left blank. The onlyOwner modifier provides the necessary access control.
  }

  uint256[49] private __gap;
}
