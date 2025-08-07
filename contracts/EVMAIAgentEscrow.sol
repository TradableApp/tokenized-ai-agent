// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IEVMAIAgent } from "./interfaces/IEVMAIAgent.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

contract EVMAIAgentEscrow is Initializable, OwnableUpgradeable {
  IERC20 public ableToken; // The ERC20 token used for payments.
  IEVMAIAgent public evmAIAgent; // The AI Agent contract this escrow serves.
  address public treasury; // The address where fees are collected.
  address public oracle; // The oracle address, authorized to initiate agent jobs.

  uint256 public constant PROMPT_FEE = 1 * 1e18; // The fee for one AI prompt.
  uint256 public constant REFUND_TIMEOUT = 1 hours; // The time after which a pending prompt can be refunded.

  struct Subscription {
    uint256 allowance; // The total amount the user has authorized.
    uint256 spentAmount; // The amount spent so far.
    uint256 expiresAt; // The unix timestamp when the subscription expires.
  }

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
  event SubscriptionSet(address indexed user, uint256 allowance, uint256 expiresAt);
  event SubscriptionCancelled(address indexed user);
  event PaymentEscrowed(uint256 indexed promptId, address indexed user, uint256 amount);
  event PaymentFinalized(uint256 indexed promptId);
  event PaymentRefunded(uint256 indexed promptId);

  error EscrowNotFound();
  error EscrowNotPending();
  error NoActiveSubscription();
  error SubscriptionExpired();
  error InsufficientSubscriptionAllowance();
  error NotEVMAIAgent();
  error NotOracle();
  error ZeroAddress();

  constructor() {
    _disableInitializers();
  }

  // Sets up the escrow smart contract.
  // @param _tokenAddress The address of the $ABLE token contract.
  // @param _agentAddress The address of the EVMAIAgent contract to interact with.
  // @param _treasuryAddress The initial address where collected fees will be sent.
  // @param _oracleAddress The initial address of the authorized oracle.
  // @param _initialOwner The address that will have ownership of this contract's proxy.
  function initialize(
    address _tokenAddress,
    address _agentAddress,
    address _treasuryAddress,
    address _oracleAddress,
    address _initialOwner
  ) public initializer {
    __Ownable_init(_initialOwner);

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

  // Checks that the caller is the registered EVMAIAgent contract.
  modifier onlyEVMAIAgent() {
    if (msg.sender != address(evmAIAgent)) {
      revert NotEVMAIAgent();
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

  // Sets or updates a user's subscription.
  // Called by the user.
  // @param _allowance The total amount of tokens to approve for the subscription period.
  // @param _expiresAt The unix timestamp when this subscription becomes invalid.
  function setSubscription(uint256 _allowance, uint256 _expiresAt) external {
    subscriptions[msg.sender] = Subscription({
      allowance: _allowance,
      spentAmount: 0, // Reset spent amount on new subscription
      expiresAt: _expiresAt
    });
    emit SubscriptionSet(msg.sender, _allowance, _expiresAt);
  }

  // Cancels a user's subscription.
  // Called by the user.
  function cancelSubscription() external {
    delete subscriptions[msg.sender];
    emit SubscriptionCancelled(msg.sender);
  }

  // Initiates a new prompt request.
  // Called by the user.
  // @param _encryptedContent The prompt, encrypted with a session key.
  // @param _userEncryptedKey The session key, encrypted for the user.
  // @param _roflEncryptedKey The session key, encrypted for the ROFL worker.
  function initiatePrompt(
    bytes calldata _encryptedContent,
    bytes calldata _userEncryptedKey,
    bytes calldata _roflEncryptedKey
  ) external {
    _initiateJob(msg.sender, _encryptedContent, _userEncryptedKey, _roflEncryptedKey);
  }

  // Initiates a new prompt request on behalf of a user.
  // Called by the oracle for autonomous/scheduled jobs.
  // @param _user The address of the user for whom the job is being initiated.
  // @param _encryptedContent The prompt, encrypted with a session key.
  // @param _userEncryptedKey The session key, encrypted for the user.
  // @param _roflEncryptedKey The session key, encrypted for the ROFL worker.
  function initiateAgentJob(
    address _user,
    bytes calldata _encryptedContent,
    bytes calldata _userEncryptedKey,
    bytes calldata _roflEncryptedKey
  ) external onlyOracle {
    _initiateJob(_user, _encryptedContent, _userEncryptedKey, _roflEncryptedKey);
  }

  // Internal function to handle the core logic for any new job.
  // @param _user The address of the user for whom the job is being initiated.
  // @param _encryptedContent The prompt, encrypted with a session key.
  // @param _userEncryptedKey The session key, encrypted for the user.
  // @param _roflEncryptedKey The session key, encrypted for the ROFL worker
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

    ableToken.transferFrom(_user, address(this), PROMPT_FEE);

    uint256 promptId = evmAIAgent.promptIdCounter();
    escrows[promptId] = Escrow({
      user: _user,
      amount: PROMPT_FEE,
      createdAt: block.timestamp,
      status: EscrowStatus.PENDING
    });
    emit PaymentEscrowed(promptId, _user, PROMPT_FEE);

    // Call the agent contract to store the prompt and signal the off-chain oracle.
    evmAIAgent.submitPrompt(
      promptId,
      _user,
      _encryptedContent,
      _userEncryptedKey,
      _roflEncryptedKey
    );
  }

  // Releases the escrowed payment to the treasury upon successful completion.
  // Called by the EVMAIAgent contract.
  // @param _promptId The unique identifier of the prompt to finalize.
  function finalizePayment(uint256 _promptId) external onlyEVMAIAgent {
    Escrow storage escrow = escrows[_promptId];

    if (escrow.user == address(0)) {
      revert EscrowNotFound();
    }

    if (escrow.status != EscrowStatus.PENDING) {
      revert EscrowNotPending();
    }

    escrow.status = EscrowStatus.COMPLETE;
    ableToken.transfer(treasury, escrow.amount);
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
        // Update all local state first.
        escrow.status = EscrowStatus.REFUNDED;
        subscriptions[escrow.user].spentAmount -= escrow.amount;

        // Perform the external call last to avoid re-entrancy issues.
        ableToken.transfer(escrow.user, escrow.amount);

        emit PaymentRefunded(promptId);
      }
    }
  }

  uint256[49] private __gap;
}
