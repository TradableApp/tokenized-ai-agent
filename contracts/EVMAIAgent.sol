// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import { IEVMAIAgentEscrow } from "./interfaces/IEVMAIAgentEscrow.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/// @notice Represents an encrypted message payload, including keys for the user and the ROFL oracle.
struct EncryptedMessage {
  bytes encryptedContent;
  bytes userEncryptedKey;
  bytes roflEncryptedKey;
}

/// @notice Represents an encrypted prompt with its unique ID.
struct EncryptedPrompt {
  uint256 promptId;
  EncryptedMessage message;
}

/// @notice Represents an encrypted answer with its corresponding prompt ID.
struct EncryptedAnswer {
  uint256 promptId;
  EncryptedMessage message;
}

/**
 * @title EVM AI Agent Contract
 * @dev This contract manages the storage of encrypted prompts and answers on a public EVM chain.
 *      It is upgradeable using the UUPS proxy pattern.
 */
contract EVMAIAgent is Initializable, OwnableUpgradeable, UUPSUpgradeable {
  /// @notice Stores all encrypted prompts submitted by a user.
  mapping(address => EncryptedPrompt[]) private _prompts;
  /// @notice Stores all encrypted answers received for a user.
  mapping(address => EncryptedAnswer[]) private _answers;
  /// @notice Maps a prompt ID to the user who created it for efficient lookups.
  mapping(uint256 => address) public promptIdToUser;
  /// @notice Tracks whether a prompt has been answered or cancelled to prevent duplicates.
  mapping(uint256 => bool) public isPromptAnswered;

  /// @notice A counter to ensure each prompt gets a unique ID.
  uint256 public promptIdCounter;

  /// @notice The TEE-based oracle address authorized to submit answers.
  address public oracle;
  /// @notice The attested application ID of the ROFL TEE allowed to manage the oracle address.
  bytes21 public roflAppID;
  /// @notice The associated escrow contract that handles all payments.
  IEVMAIAgentEscrow public aiAgentEscrow;
  /// @notice The domain used for off-chain SIWE validation.
  string public domain;

  /// @notice Emitted when a new prompt is successfully submitted via the escrow contract.
  event PromptSubmitted(address indexed user, uint256 indexed promptId);
  /// @notice Emitted when the oracle successfully submits an answer.
  event AnswerSubmitted(address indexed sender, uint256 indexed promptId);
  /// @notice Emitted when the linked escrow contract address is updated.
  event AgentEscrowUpdated(address indexed newAIAgentEscrow);
  /// @notice Emitted when the oracle address is updated by a TEE.
  event OracleUpdated(address indexed newOracle);

  /// @notice Reverts if an address parameter is the zero address.
  error ZeroAddress();
  /// @notice Reverts if an attempt is made to set the escrow address more than once.
  error AgentEscrowAlreadySet();
  /// @notice Reverts if a function is called by an unauthorized user or oracle.
  error UnauthorizedUserOrOracle();
  /// @notice Reverts if a function is called by an address that is not the authorized user.
  error UnauthorizedUser();
  /// @notice Reverts if a function is called by an address that is not the authorized oracle.
  error UnauthorizedOracle();
  /// @notice Reverts if a function is called by an address other than the linked escrow contract.
  error NotAIAgentEscrow();
  /// @notice Reverts if a prompt ID is not valid or does not exist.
  error InvalidPromptId();
  /// @notice Reverts if an answer or cancellation is submitted for an already-answered prompt.
  error PromptAlreadyAnswered();
  /// @notice Reverts if the prompt ID from escrow does not match the expected next ID.
  error MismatchedPromptId();

  /**
   * @notice Sets up the AI Agent smart contract.
   * @param _domain The domain used for off-chain SIWE validation.
   * @param _roflAppID The attested ROFL app that is allowed to call setOracle().
   * @param _oracle The initial TEE oracle address for accessing prompts.
   * @param _initialOwner The address that will have ownership of this contract.
   */
  function initialize(
    string memory _domain,
    bytes21 _roflAppID,
    address _oracle,
    address _initialOwner
  ) public initializer {
    if (_oracle == address(0) || _initialOwner == address(0)) {
      revert ZeroAddress();
    }
    __Ownable_init(_initialOwner);
    __UUPSUpgradeable_init();
    domain = _domain;
    roflAppID = _roflAppID;
    oracle = _oracle;
  }

  /**
   * @notice For the user: checks that `msg.sender` is the specified user address.
   * @notice For the oracle: checks that `msg.sender` is the authorized oracle.
   * @param _addr The address being authenticated.
   */
  modifier onlyUserOrOracle(address _addr) {
    if (msg.sender != _addr && msg.sender != oracle) {
      revert UnauthorizedUserOrOracle();
    }
    _;
  }

  /**
   * @notice Checks that `msg.sender` is the specified user address.
   * @param _addr The address being authenticated.
   */
  modifier onlyUser(address _addr) {
    if (msg.sender != _addr) {
      revert UnauthorizedUser();
    }
    _;
  }

  /**
   * @notice Checks whether the transaction was signed by the oracle's private key.
   */
  modifier onlyOracle() {
    if (msg.sender != oracle) {
      revert UnauthorizedOracle();
    }
    _;
  }

  /**
   * @notice Checks that the caller is the registered EVMAIAgentEscrow contract.
   */
  modifier onlyAIAgentEscrow() {
    if (msg.sender != address(aiAgentEscrow)) {
      revert NotAIAgentEscrow();
    }
    _;
  }

  /**
   * @notice Checks whether the transaction was signed by the ROFL's app key inside a TEE.
   * @dev Placeholder: This check requires a Sapphire precompile and cannot be performed on-chain here.
   * @param _appId The application ID of the ROFL instance.
   */
  modifier onlyTEE(bytes21 _appId) {
    // TODO: A robust mechanism for TEE attestation on a standard EVM chain requires
    // further research (e.g., via light client or message bridge to Sapphire).
    _;
  }

  /**
   * @notice Sets the address of the AgentEscrow contract.
   * @dev This can only be called once by the owner to complete the deployment linking.
   * @param _newAIAgentEscrow The address of the deployed EVMAIAgentEscrow contract.
   */
  function setAgentEscrow(address _newAIAgentEscrow) external onlyOwner {
    if (_newAIAgentEscrow == address(0)) {
      revert ZeroAddress();
    }
    if (address(aiAgentEscrow) != address(0)) {
      revert AgentEscrowAlreadySet();
    }
    aiAgentEscrow = IEVMAIAgentEscrow(_newAIAgentEscrow);
    emit AgentEscrowUpdated(_newAIAgentEscrow);
  }

  /**
   * @notice Sets the oracle address that will be allowed to read prompts and submit answers.
   * @dev This setter can only be called from within an authorized ROFL TEE.
   * @param _newOracle The new address for the oracle.
   */
  function setOracle(address _newOracle) external onlyTEE(roflAppID) {
    if (_newOracle == address(0)) {
      revert ZeroAddress();
    }
    oracle = _newOracle;
    emit OracleUpdated(_newOracle);
  }

  /**
   * @notice Stores a new encrypted prompt after payment has been secured by the escrow contract.
   * @dev This function can only be called by the linked `EVMAIAgentEscrow` contract.
   * @param _promptId The unique identifier for the prompt.
   * @param _user The address of the user who initiated the prompt.
   * @param _encryptedContent The prompt, encrypted with a session key.
   * @param _userEncryptedKey The session key, encrypted for the user.
   * @param _roflEncryptedKey The session key, encrypted for the ROFL worker.
   */
  function submitPrompt(
    uint256 _promptId,
    address _user,
    bytes calldata _encryptedContent,
    bytes calldata _userEncryptedKey,
    bytes calldata _roflEncryptedKey
  ) external onlyAIAgentEscrow {
    if (_promptId != promptIdCounter) {
      revert MismatchedPromptId();
    }
    EncryptedMessage memory promptMessage = EncryptedMessage({
      encryptedContent: _encryptedContent,
      userEncryptedKey: _userEncryptedKey,
      roflEncryptedKey: _roflEncryptedKey
    });
    _prompts[_user].push(EncryptedPrompt({ promptId: _promptId, message: promptMessage }));
    promptIdToUser[_promptId] = _user;
    promptIdCounter++;
    emit PromptSubmitted(_user, _promptId);
  }

  /**
   * @notice Clears the conversation history for the specified user.
   * @param _addr The address of the user whose conversation is being cleared.
   */
  function clearPrompt(address _addr) external onlyUser(_addr) {
    delete _prompts[_addr];
    delete _answers[_addr];
  }

  /**
   * @notice Gets the total number of prompts a user has submitted.
   * @param _addr The address of the user whose prompt count is being checked.
   * @return The total number of prompts.
   */
  function getPromptsCount(address _addr) external view onlyUserOrOracle(_addr) returns (uint256) {
    return _prompts[_addr].length;
  }

  /**
   * @notice Returns all encrypted prompts for a given user address.
   * @param _addr The address of the user whose prompts are being retrieved.
   * @return An array of `EncryptedPrompt` structs.
   */
  function getPrompts(
    address _addr
  ) external view onlyUserOrOracle(_addr) returns (EncryptedPrompt[] memory) {
    return _prompts[_addr];
  }

  /**
   * @notice Returns all encrypted answers for a given user address.
   * @param _addr The address of the user whose answers are being retrieved.
   * @return An array of `EncryptedAnswer` structs.
   */
  function getAnswers(
    address _addr
  ) external view onlyUserOrOracle(_addr) returns (EncryptedAnswer[] memory) {
    return _answers[_addr];
  }

  /**
   * @notice Stores a cancellation record for a given prompt.
   * @dev This is called by the Escrow contract when a user cancels a pending prompt.
   *      It creates an "answer" record to provide clarity in the user's history
   *      and prevents the oracle from submitting a real answer later. The off-chain client
   *      knows to treat this as plaintext because the key fields are empty.
   * @param _promptId The ID of the prompt that was cancelled.
   * @param _user The address of the user who cancelled.
   */
  function storeCancellation(uint256 _promptId, address _user) external onlyAIAgentEscrow {
    if (isPromptAnswered[_promptId]) {
      revert PromptAlreadyAnswered();
    }
    isPromptAnswered[_promptId] = true;
    EncryptedMessage memory cancelledMessage = EncryptedMessage({
      encryptedContent: bytes("Prompt cancelled by user."),
      userEncryptedKey: bytes(""),
      roflEncryptedKey: bytes("")
    });
    _answers[_user].push(EncryptedAnswer({ promptId: _promptId, message: cancelledMessage }));
  }

  /**
   * @notice Submits the encrypted answer to the prompt for a given user address.
   * @dev Called by the oracle from within its TEE.
   * @param _encryptedContent The answer, encrypted with a session key.
   * @param _userEncryptedKey The session key, encrypted for the user.
   * @param _roflEncryptedKey The session key, encrypted for the ROFL worker.
   * @param _promptId The unique identifier of the prompt being answered.
   * @param _addr The address of the user who initiated the prompt.
   */
  function submitAnswer(
    bytes calldata _encryptedContent,
    bytes calldata _userEncryptedKey,
    bytes calldata _roflEncryptedKey,
    uint256 _promptId,
    address _addr
  ) external onlyOracle {
    if (promptIdToUser[_promptId] != _addr) {
      revert InvalidPromptId();
    }
    if (isPromptAnswered[_promptId]) {
      revert PromptAlreadyAnswered();
    }
    isPromptAnswered[_promptId] = true;
    EncryptedMessage memory answerMessage = EncryptedMessage({
      encryptedContent: _encryptedContent,
      userEncryptedKey: _userEncryptedKey,
      roflEncryptedKey: _roflEncryptedKey
    });
    _answers[_addr].push(EncryptedAnswer({ promptId: _promptId, message: answerMessage }));
    emit AnswerSubmitted(_addr, _promptId);
    aiAgentEscrow.finalizePayment(_promptId);
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
