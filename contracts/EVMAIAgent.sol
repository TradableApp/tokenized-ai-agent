// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import { IEVMAIAgentEscrow } from "./interfaces/IEVMAIAgentEscrow.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

struct EncryptedMessage {
  bytes encryptedContent;
  bytes userEncryptedKey;
  bytes roflEncryptedKey;
}

struct EncryptedPrompt {
  uint256 promptId;
  EncryptedMessage message;
}

struct EncryptedAnswer {
  uint256 promptId;
  EncryptedMessage message;
}

contract EVMAIAgent is Initializable, OwnableUpgradeable, UUPSUpgradeable {
  mapping(address => EncryptedPrompt[]) private _prompts;
  mapping(address => EncryptedAnswer[]) private _answers;
  mapping(uint256 => address) public promptIdToUser;
  mapping(uint256 => bool) public isPromptAnswered;

  uint256 public promptIdCounter;

  address public oracle; // Oracle address running inside TEE.
  bytes21 public roflAppID; // Allowed app ID within TEE for managing allowed oracle address.
  IEVMAIAgentEscrow public aiAgentEscrow; // The escrow contract that manages payments.
  string public domain; // The domain used for off-chain SIWE validation.

  event PromptSubmitted(address indexed user, uint256 indexed promptId);
  event AnswerSubmitted(address indexed sender, uint256 indexed promptId);
  event AgentEscrowUpdated(address indexed newAIAgentEscrow);
  event OracleUpdated(address indexed newOracle);

  error ZeroAddress();
  error AgentEscrowAlreadySet();
  error UnauthorizedUserOrOracle();
  error UnauthorizedUser();
  error UnauthorizedOracle();
  error NotAIAgentEscrow();
  error InvalidPromptId();
  error PromptAlreadyAnswered();
  error MismatchedPromptId();

  // Sets up the AI Agent smart contract.
  // @param _domain is used for SIWE login on the frontend
  // @param _roflAppID is the attested ROFL app that is allowed to call setOracle()
  // @param _oracle only for testing, not attested; set the oracle address for accessing prompts
  // @param _initialOwner The address that will have ownership of this contract.
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

  // For the user: checks that the caller is the specified user address.
  // For the oracle: checks that the transaction was signed by the oracle's private key.
  // @dev On a standard EVM, msg.sender is reliable and an authToken is not needed.
  modifier onlyUserOrOracle(address _addr) {
    if (msg.sender != _addr && msg.sender != oracle) {
      revert UnauthorizedUserOrOracle();
    }
    _;
  }

  // For the user: checks that the caller is the specified user address.
  // @dev On a standard EVM, msg.sender is reliable and an authToken is not needed.
  modifier onlyUser(address _addr) {
    if (msg.sender != _addr) {
      revert UnauthorizedUser();
    }
    _;
  }

  // Checks whether the transaction or query was signed by the oracle's
  // private key accessible only within TEE.
  modifier onlyOracle() {
    if (msg.sender != oracle) {
      revert UnauthorizedOracle();
    }
    _;
  }

  // Checks that the caller is the registered EVMAIAgentEscrow contract.
  modifier onlyAIAgentEscrow() {
    if (msg.sender != address(aiAgentEscrow)) {
      revert NotAIAgentEscrow();
    }
    _;
  }

  // Checks whether the transaction was signed by the ROFL's app key inside
  // TEE.
  // @dev Placeholder: This check requires a Sapphire precompile and cannot be performed on-chain here.
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
    // This ensures the link can only be set once, from address(0) to the real address.
    if (address(aiAgentEscrow) != address(0)) {
      revert AgentEscrowAlreadySet();
    }

    aiAgentEscrow = IEVMAIAgentEscrow(_newAIAgentEscrow);
    emit AgentEscrowUpdated(_newAIAgentEscrow);
  }

  // Sets the oracle address that will be allowed to read prompts and submit answers.
  // This setter can only be called within the ROFL TEE and the keypair
  // corresponding to the address should never leave TEE.
  // @param _newOracle The new address for the oracle.
  function setOracle(address _newOracle) external onlyTEE(roflAppID) {
    if (_newOracle == address(0)) {
      revert ZeroAddress();
    }

    oracle = _newOracle;
    emit OracleUpdated(_newOracle);
  }

  // Submits a new prompt after payment has been secured by the EVMAIAgentEscrow contract.
  // Called by the EVMAIAgentEscrow contract.
  // @param _promptId The unique identifier for the prompt.
  // @param _user The address of the user who initiated the prompt.
  // @param _encryptedContent The prompt, encrypted with a session key.
  // @param _userEncryptedKey The session key, encrypted for the user.
  // @param _roflEncryptedKey The session key, encrypted for the ROFL worker.
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

  // Clears the conversation.
  // Called by the user.
  // @param _addr The address of the user whose conversation is being cleared.
  function clearPrompt(address _addr) external onlyUser(_addr) {
    delete _prompts[_addr];
    delete _answers[_addr];
  }

  // @param _addr The address of the user whose prompt count is being checked.
  function getPromptsCount(address _addr) external view onlyUserOrOracle(_addr) returns (uint256) {
    return _prompts[_addr].length;
  }

  // Returns all prompts for a given user address.
  // Called by the user in the frontend and by the oracle to generate the answer.
  // @param _addr The address of the user whose prompts are being retrieved.
  function getPrompts(
    address _addr
  ) external view onlyUserOrOracle(_addr) returns (EncryptedPrompt[] memory) {
    return _prompts[_addr];
  }

  // Returns all answers for a given user address.
  // Called by the user.
  // @param _addr The address of the user whose answers are being retrieved.
  function getAnswers(
    address _addr
  ) external view onlyUserOrOracle(_addr) returns (EncryptedAnswer[] memory) {
    return _answers[_addr];
  }

  // Submits the answer to the prompt for a given user address.
  // Called by the oracle within TEE.
  // @param _encryptedContent The answer, encrypted with a session key.
  // @param _userEncryptedKey The session key, encrypted for the user.
  // @param _roflEncryptedKey The session key, encrypted for the ROFL worker.
  // @param _promptId The unique identifier of the prompt being answered.
  // @param _addr The address of the user who initiated the prompt.
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

    // After successfully storing the answer, finalize the payment.
    aiAgentEscrow.finalizePayment(_promptId);
  }

  // @dev Authorizes an upgrade to a new implementation contract.
  // @dev This internal function is part of the UUPS upgrade mechanism. Access is restricted to the
  // owner via the `onlyOwner` modifier.
  // @param _newImplementation The address of the new implementation contract.
  function _authorizeUpgrade(address _newImplementation) internal override onlyOwner {
    // solhint-disable-previous-line no-empty-blocks
    // Intentionally left blank. The onlyOwner modifier provides the necessary access control.
  }

  uint256[49] private __gap;
}
