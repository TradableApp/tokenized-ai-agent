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
  /// @notice The immutable address of the AI Agent contract this escrow serves.
  ISapphireAIAgent public immutable SAPPHIRE_AI_AGENT;
  /// @notice The address where collected fees are sent upon successful prompt completion.
  address public treasury;
  /// @notice The address of the authorized off-chain oracle.
  address public oracle;

  /// @notice The fee in wei required for one AI prompt.
  uint256 public constant PROMPT_FEE = 1 * 1e18;
  /// @notice The time after which a user can cancel their own pending prompt.
  uint256 public constant CANCELLATION_TIMEOUT = 5 minutes;
  /// @notice The time after which a keeper can refund any timed-out pending prompt.
  uint256 public constant REFUND_TIMEOUT = 1 hours;

  /// @notice Represents a user's allowance term.
  struct Subscription {
    uint256 expiresAt; // The unix timestamp when the subscription expires.
  }

  /// @notice Tracks each user's deposited balance for paying prompt fees.
  mapping(address => uint256) public deposits;
  /// @notice Tracks each user's allowance term.
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
  /// @notice Emitted when a user sets or updates their allowance term.
  event SubscriptionSet(address indexed user, uint256 expiresAt);
  /// @notice Emitted when a user cancels their allowance.
  event SubscriptionCancelled(address indexed user);
  /// @notice Emitted when a user deposits funds.
  event DepositReceived(address indexed user, uint256 amount);
  /// @notice Emitted when a user withdraws funds or they are refunded on cancellation.
  event Withdrawal(address indexed user, uint256 amount);
  /// @notice Emitted when a user's payment is successfully placed in escrow.
  event PaymentEscrowed(uint256 indexed promptId, address indexed user, uint256 amount);
  /// @notice Emitted when an escrowed payment is finalized and sent to the treasury.
  event PaymentFinalized(uint256 indexed promptId);
  /// @notice Emitted when a timed-out escrowed payment is refunded to the user's deposit.
  event PaymentRefunded(uint256 indexed promptId);
  /// @notice Emitted when a user cancels their own pending prompt.
  event PromptCancelled(uint256 indexed promptId, address indexed user);

  /// @notice Reverts if an escrow record is not found for a given prompt ID.
  error EscrowNotFound();
  /// @notice Reverts if an action is attempted on an escrow that is not in the PENDING state.
  error EscrowNotPending();
  /// @notice Reverts if a function is called by an address other than the linked AI Agent contract.
  error NotSapphireAIAgent();
  /// @notice Reverts if a user tries to submit a prompt without an active allowance term.
  error NoActiveSubscription();
  /// @notice Reverts if a user tries to submit a prompt with an expired allowance term.
  error SubscriptionExpired();
  /// @notice Reverts if a user's deposit balance is insufficient to cover the prompt fee.
  error InsufficientDeposit();
  /// @notice Reverts if a function is called by an address that is not the authorized oracle.
  error NotOracle();
  /// @notice Reverts if an address parameter is the zero address.
  error ZeroAddress();
  /// @notice Reverts if a user attempts to withdraw more funds than they have deposited.
  error InsufficientBalanceForWithdrawal();
  /// @notice Reverts if a user tries to withdraw, cancel, or set a subscription while having pending prompts.
  error HasPendingPrompts();
  /// @notice Reverts if a user tries to cancel a prompt before the cancellation timeout has passed.
  error PromptNotCancellableYet();
  /// @notice Reverts if a keeper tries to refund a prompt before the refund timeout has passed.
  error PromptNotRefundableYet();
  /// @notice Reverts if a user tries to cancel a prompt they do not own.
  error NotPromptOwner();

  /**
   * @notice Sets up the escrow smart contract.
   * @param _agentAddress The address of the SapphireAIAgent contract to interact with.
   * @param _treasuryAddress The initial address where collected fees will be sent.
   * @param _oracleAddress The initial address of the authorized oracle.
   * @param _initialOwner The address that will have ownership of this contract.
   */
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

  /**
   * @notice Checks that the caller is the registered SapphireAIAgent contract.
   */
  modifier onlySapphireAIAgent() {
    if (msg.sender != address(SAPPHIRE_AI_AGENT)) {
      revert NotSapphireAIAgent();
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
   * @notice Sets or updates a user's allowance term.
   * @dev Can only be called if there are no pending prompts.
   * @param _expiresAt The unix timestamp when this allowance term becomes invalid.
   */
  function setSubscription(uint256 _expiresAt) external {
    if (pendingEscrowCount[msg.sender] > 0) {
      revert HasPendingPrompts();
    }
    subscriptions[msg.sender] = Subscription({ expiresAt: _expiresAt });
    emit SubscriptionSet(msg.sender, _expiresAt);
  }

  /**
   * @notice Cancels a user's usage allowance and refunds their entire deposit.
   * @dev This function can only be called if the user has no prompts currently
   *      in the PENDING state to prevent orphaning funds.
   */
  function cancelSubscription() external {
    if (pendingEscrowCount[msg.sender] > 0) {
      revert HasPendingPrompts();
    }
    uint256 depositAmount = deposits[msg.sender];
    delete subscriptions[msg.sender];
    delete deposits[msg.sender];
    emit SubscriptionCancelled(msg.sender);
    if (depositAmount > 0) {
      emit Withdrawal(msg.sender, depositAmount);
      payable(msg.sender).transfer(depositAmount);
    }
  }

  /**
   * @notice Allows a user to cancel their own pending prompt after a timeout.
   * @dev This refunds the user's deposit and records the cancellation on the AIAgent contract.
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
    deposits[msg.sender] += escrow.amount;
    emit PromptCancelled(_promptId, msg.sender);
    SAPPHIRE_AI_AGENT.storeCancellation(_promptId, msg.sender);
  }

  /**
   * @notice Initiates a new prompt request. Called by the user.
   * @param _prompt The plaintext prompt from the user.
   */
  function initiatePrompt(string calldata _prompt) external {
    _initiateJob(msg.sender, _prompt);
  }

  /**
   * @notice Initiates a new prompt request on behalf of a user.
   * @dev Called by the oracle for autonomous/scheduled jobs.
   * @param _user The address of the user for whom the job is being initiated.
   * @param _prompt The plaintext prompt for the user.
   */
  function initiateAgentJob(address _user, string calldata _prompt) external onlyOracle {
    _initiateJob(_user, _prompt);
  }

  /**
   * @dev Internal function to handle the core logic for any new job.
   */
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
    deposits[_user] -= PROMPT_FEE;
    pendingEscrowCount[_user]++;
    uint256 promptId = SAPPHIRE_AI_AGENT.promptIdCounter();
    escrows[promptId] = Escrow({
      user: _user,
      amount: PROMPT_FEE,
      createdAt: block.timestamp,
      status: EscrowStatus.PENDING
    });
    emit PaymentEscrowed(promptId, _user, PROMPT_FEE);
    SAPPHIRE_AI_AGENT.submitPrompt(promptId, _user, _prompt);
  }

  /**
   * @notice Releases the escrowed payment to the treasury upon successful completion.
   * @dev Called by the SapphireAIAgent contract.
   * @param _promptId The unique identifier of the prompt to finalize.
   */
  function finalizePayment(uint256 _promptId) external onlySapphireAIAgent {
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
    payable(treasury).transfer(escrow.amount);
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
    deposits[escrow.user] += escrow.amount;
    emit PaymentRefunded(_promptId);
  }
}
