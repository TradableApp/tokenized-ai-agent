// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import { IEVMAIAgentEscrow } from "./interfaces/IEVMAIAgentEscrow.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

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

contract EVMAIAgent is Initializable {
  mapping(address => EncryptedPrompt[]) private _prompts;
  mapping(address => EncryptedAnswer[]) private _answers;

  uint256 public promptIdCounter;

  address public oracle; // Oracle address running inside TEE.
  bytes21 public roflAppID; // Allowed app ID within TEE for managing allowed oracle address.
  IEVMAIAgentEscrow public agentEscrow; // The escrow contract that manages payments.
  string public domain; // The domain used for off-chain SIWE validation.

  event PromptSubmitted(address indexed user, uint256 indexed promptId);
  event AnswerSubmitted(address indexed sender, uint256 indexed promptId);

  error InvalidPromptId();
  error PromptAlreadyAnswered();
  error UnauthorizedUserOrOracle();
  error UnauthorizedOracle();
  error NotAIAgentEscrow();
  error MismatchedPromptId();

  constructor() {
    _disableInitializers();
  }

  // Sets up the AI Agent smart contract.
  // @param _domain is used for SIWE login on the frontend
  // @param _roflAppID is the attested ROFL app that is allowed to call setOracle()
  // @param _oracle only for testing, not attested; set the oracle address for accessing prompts
  // @param _agentEscrowAddress The address of the EVMAIAgentEscrow contract this agent is linked to.
  function initialize(
    string memory _domain,
    bytes21 _roflAppID,
    address _oracle,
    address _agentEscrowAddress
  ) public initializer {
    domain = _domain;
    roflAppID = _roflAppID;
    oracle = _oracle;
    agentEscrow = IEVMAIAgentEscrow(_agentEscrowAddress);
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
    if (msg.sender != address(agentEscrow)) {
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

    promptIdCounter++;

    emit PromptSubmitted(_user, _promptId);
  }

  // Clears the conversation.
  // Called by the user.
  function clearPrompt() external {
    delete _prompts[msg.sender];
    delete _answers[msg.sender];
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

  // Sets the oracle address that will be allowed to read prompts and submit answers.
  // This setter can only be called within the ROFL TEE and the keypair
  // corresponding to the address should never leave TEE.
  // @param _addr The new address for the oracle.
  function setOracle(address _addr) external onlyTEE(roflAppID) {
    oracle = _addr;
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
    bool promptExists = false;

    for (uint256 i = 0; i < _prompts[_addr].length; i++) {
      if (_prompts[_addr][i].promptId == _promptId) {
        promptExists = true;
        break;
      }
    }

    if (!promptExists) {
      revert InvalidPromptId();
    }

    for (uint256 i = 0; i < _answers[_addr].length; i++) {
      if (_answers[_addr][i].promptId == _promptId) {
        revert PromptAlreadyAnswered();
      }
    }

    EncryptedMessage memory answerMessage = EncryptedMessage({
      encryptedContent: _encryptedContent,
      userEncryptedKey: _userEncryptedKey,
      roflEncryptedKey: _roflEncryptedKey
    });

    _answers[_addr].push(EncryptedAnswer({ promptId: _promptId, message: answerMessage }));

    emit AnswerSubmitted(_addr, _promptId);

    // After successfully storing the answer, finalize the payment.
    agentEscrow.finalizePayment(_promptId);
  }

  uint256[49] private __gap;
}
