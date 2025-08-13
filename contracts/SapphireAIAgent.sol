// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import { Subcall } from "@oasisprotocol/sapphire-contracts/contracts/Subcall.sol";
import { SiweAuth } from "@oasisprotocol/sapphire-contracts/contracts/auth/SiweAuth.sol";
import { ISapphireAIAgentEscrow } from "./interfaces/ISapphireAIAgentEscrow.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Represents a user's prompt with its unique ID.
struct Prompt {
  uint256 promptId;
  string prompt;
}

/// @notice Represents an AI-generated answer with the corresponding prompt ID.
struct Answer {
  uint256 promptId;
  string answer;
}

/**
 * @title Sapphire AI Agent Contract
 * @dev This contract manages the storage of prompts and AI-generated answers in a confidential
 *      environment provided by the Oasis Sapphire runtime. It works in tandem with an Escrow contract.
 */
contract SapphireAIAgent is SiweAuth, Ownable {
  /// @notice Stores all prompts submitted by a user.
  mapping(address => Prompt[]) private _prompts;
  /// @notice Stores all answers received for a user.
  mapping(address => Answer[]) private _answers;
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
  ISapphireAIAgentEscrow public agentEscrow;

  /// @notice Emitted when a new prompt is successfully submitted via the escrow contract.
  event PromptSubmitted(address indexed sender, uint256 indexed promptId);
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
   * @param _domain The domain used for SIWE login on the frontend.
   * @param _roflAppID The attested ROFL app that is allowed to call setOracle().
   * @param _oracle The initial TEE oracle address for accessing prompts.
   * @param _initialOwner The address that will have ownership of this contract.
   */
  constructor(
    string memory _domain,
    bytes21 _roflAppID,
    address _oracle,
    address _initialOwner
  ) SiweAuth(_domain) Ownable(_initialOwner) {
    if (_oracle == address(0)) {
      revert ZeroAddress();
    }
    roflAppID = _roflAppID;
    oracle = _oracle;
  }

  /**
   * @notice For the user: checks whether `_authToken` corresponds to `_addr`.
   * @notice For the oracle: checks whether `msg.sender` is the authorized oracle.
   * @param _authToken The encrypted SIWE token for authentication.
   * @param _addr The address being authenticated.
   */
  modifier onlyUserOrOracle(bytes memory _authToken, address _addr) {
    if (msg.sender != _addr && msg.sender != oracle) {
      address msgSender = authMsgSender(_authToken);
      if (msgSender != _addr && msgSender != oracle) {
        revert UnauthorizedUserOrOracle();
      }
    }
    _;
  }

  /**
   * @notice Checks whether `_authToken` is a valid SIWE token corresponding to `_addr`.
   * @param _authToken The encrypted SIWE token for authentication.
   * @param _addr The address being authenticated.
   */
  modifier onlyUser(bytes memory _authToken, address _addr) {
    if (msg.sender != _addr) {
      address msgSender = authMsgSender(_authToken);
      if (msgSender != _addr) {
        revert UnauthorizedUser();
      }
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
   * @notice Checks whether the transaction was signed by the ROFL's app key inside a TEE.
   * @param _appId The application ID of the ROFL instance.
   */
  modifier onlyTEE(bytes21 _appId) {
    Subcall.roflEnsureAuthorizedOrigin(_appId);
    _;
  }

  /**
   * @notice Checks that the caller is the registered AIAgentEscrow contract.
   */
  modifier onlyAIAgentEscrow() {
    if (msg.sender != address(agentEscrow)) {
      revert NotAIAgentEscrow();
    }
    _;
  }

  /**
   * @notice Sets the address of the AgentEscrow contract.
   * @dev This can only be called once by the owner to complete the deployment linking.
   * @param _newAIAgentEscrow The address of the deployed SapphireAIAgentEscrow contract.
   */
  function setAgentEscrow(address _newAIAgentEscrow) external onlyOwner {
    if (_newAIAgentEscrow == address(0)) {
      revert ZeroAddress();
    }
    if (address(agentEscrow) != address(0)) {
      revert AgentEscrowAlreadySet();
    }
    agentEscrow = ISapphireAIAgentEscrow(_newAIAgentEscrow);
    emit AgentEscrowUpdated(_newAIAgentEscrow);
  }

  /**
   * @notice Sets the oracle address that will be allowed to read prompts and submit answers.
   * @dev This setter can only be called from within an authorized ROFL TEE. The keypair
   *      corresponding to the address should never leave the TEE.
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
   * @notice Stores a new prompt after payment has been secured by the escrow contract.
   * @dev This function can only be called by the linked `SapphireAIAgentEscrow` contract.
   * @param _promptId The unique identifier for the prompt.
   * @param _user The original user who initiated the prompt.
   * @param _prompt The plaintext prompt from the user.
   */
  function submitPrompt(
    uint256 _promptId,
    address _user,
    string memory _prompt
  ) external onlyAIAgentEscrow {
    if (_promptId != promptIdCounter) {
      revert MismatchedPromptId();
    }
    _prompts[_user].push(Prompt({ promptId: _promptId, prompt: _prompt }));
    promptIdToUser[_promptId] = _user;
    promptIdCounter++;
    emit PromptSubmitted(_user, _promptId);
  }

  /**
   * @notice Clears the conversation history for the calling user.
   * @param _authToken The encrypted SIWE token for authentication.
   * @param _addr The address of the user whose conversation is being cleared.
   */
  function clearPrompt(
    bytes memory _authToken,
    address _addr
  ) external onlyUser(_authToken, _addr) {
    delete _prompts[_addr];
    delete _answers[_addr];
  }

  /**
   * @notice Gets the total number of prompts a user has submitted.
   * @param _authToken The encrypted SIWE token for authentication.
   * @param _addr The address of the user whose prompt count is being checked.
   * @return The total number of prompts.
   */
  function getPromptsCount(
    bytes memory _authToken,
    address _addr
  ) external view onlyUserOrOracle(_authToken, _addr) returns (uint256) {
    return _prompts[_addr].length;
  }

  /**
   * @notice Returns all prompts for a given user address.
   * @dev Called by the user in the frontend and by the oracle to generate the answer.
   * @param _authToken The encrypted SIWE token for authentication.
   * @param _addr The address of the user whose prompts are being retrieved.
   * @return An array of `Prompt` structs.
   */
  function getPrompts(
    bytes memory _authToken,
    address _addr
  ) external view onlyUserOrOracle(_authToken, _addr) returns (Prompt[] memory) {
    return _prompts[_addr];
  }

  /**
   * @notice Returns all answers for a given user address.
   * @param _authToken The encrypted SIWE token for authentication.
   * @param _addr The address of the user whose answers are being retrieved.
   * @return An array of `Answer` structs.
   */
  function getAnswers(
    bytes memory _authToken,
    address _addr
  ) external view onlyUserOrOracle(_authToken, _addr) returns (Answer[] memory) {
    return _answers[_addr];
  }

  /**
   * @notice Stores a cancellation record for a given prompt.
   * @dev This is called by the Escrow contract when a user cancels a pending prompt.
   *      It creates an "answer" record to provide clarity in the user's history
   *      and prevents the oracle from submitting a real answer later.
   * @param _promptId The ID of the prompt that was cancelled.
   * @param _user The address of the user who cancelled.
   */
  function storeCancellation(uint256 _promptId, address _user) external onlyAIAgentEscrow {
    if (isPromptAnswered[_promptId]) {
      revert PromptAlreadyAnswered();
    }
    isPromptAnswered[_promptId] = true;
    _answers[_user].push(Answer({ promptId: _promptId, answer: "Prompt cancelled by user." }));
  }

  /**
   * @notice Submits the answer to the prompt for a given user address.
   * @dev Called by the oracle from within its TEE.
   * @param _answer The plaintext AI response.
   * @param _promptId The unique identifier of the prompt being answered.
   * @param _addr The address of the user who initiated the prompt.
   */
  function submitAnswer(
    string memory _answer,
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
    _answers[_addr].push(Answer({ promptId: _promptId, answer: _answer }));
    emit AnswerSubmitted(_addr, _promptId);
    agentEscrow.finalizePayment(_promptId);
  }
}
