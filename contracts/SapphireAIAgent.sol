// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import { Subcall } from "@oasisprotocol/sapphire-contracts/contracts/Subcall.sol";
import { SiweAuth } from "@oasisprotocol/sapphire-contracts/contracts/auth/SiweAuth.sol";
import { ISapphireAIAgentEscrow } from "./interfaces/ISapphireAIAgentEscrow.sol";

struct Prompt {
  uint256 promptId;
  string prompt;
}

struct Answer {
  uint256 promptId;
  string answer;
}

contract SapphireAIAgent is SiweAuth {
  mapping(address => Prompt[]) private _prompts;
  mapping(address => Answer[]) private _answers;

  uint256 public promptIdCounter;

  address public oracle; // Oracle address running inside TEE.
  bytes21 public roflAppID; // Allowed app ID within TEE for managing allowed oracle address.
  ISapphireAIAgentEscrow public agentEscrow; // The escrow contract that manages payments.

  event PromptSubmitted(address indexed sender, uint256 indexed promptId);
  event AnswerSubmitted(address indexed sender, uint256 indexed promptId);

  error InvalidPromptId();
  error PromptAlreadyAnswered();
  error UnauthorizedUserOrOracle();
  error UnauthorizedOracle();
  error NotAIAgentEscrow();
  error MismatchedPromptId();

  // Sets up a chat bot smart contract where.
  // @param _domain is used for SIWE login on the frontend
  // @param _roflAppID is the attested ROFL app that is allowed to call setOracle()
  // @param _oracle only for testing, not attested; set the oracle address for accessing prompts
  // @param _agentEscrowAddress The address of the SapphireAIAgentEscrow contract.
  constructor(
    string memory _domain,
    bytes21 _roflAppID,
    address _oracle,
    address _agentEscrowAddress
  ) SiweAuth(_domain) {
    roflAppID = _roflAppID;
    oracle = _oracle;
    agentEscrow = ISapphireAIAgentEscrow(_agentEscrowAddress);
  }

  // For the user: checks whether authToken is a valid SIWE token
  // corresponding to the requested address.
  // For the oracle: checks whether the transaction or query was signed by the
  // oracle's private key accessible only within TEE.
  // @param _authToken The encrypted SIWE token for authentication.
  // @param _addr The address being authenticated.
  modifier onlyUserOrOracle(bytes memory _authToken, address _addr) {
    if (msg.sender != _addr && msg.sender != oracle) {
      address msgSender = authMsgSender(_authToken);
      if (msgSender != _addr && msgSender != oracle) {
        revert UnauthorizedUserOrOracle();
      }
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

  // Checks whether the transaction was signed by the ROFL's app key inside
  // TEE.
  // @param _appId The application ID of the ROFL instance.
  modifier onlyTEE(bytes21 _appId) {
    Subcall.roflEnsureAuthorizedOrigin(_appId);
    _;
  }

  // Checks that the caller is the registered AIAgentEscrow contract.
  modifier onlyAIAgentEscrow() {
    if (msg.sender != address(agentEscrow)) {
      revert NotAIAgentEscrow();
    }
    _;
  }

  // Submits a new prompt after payment has been secured by the SapphireAIAgentEscrow contract.
  // Called by the SapphireAIAgentEscrow contract.
  // @param _promptId The unique identifier for the prompt.
  // @param _prompt The plaintext prompt from the user.
  function submitPrompt(uint256 _promptId, string memory _prompt) external onlyAIAgentEscrow {
    if (_promptId != promptIdCounter) {
      revert MismatchedPromptId();
    }

    _prompts[msg.sender].push(Prompt({ promptId: _promptId, prompt: _prompt }));

    promptIdCounter++;

    emit PromptSubmitted(msg.sender, _promptId);
  }

  // Clears the conversation.
  // Called by the user.
  function clearPrompt() external {
    delete _prompts[msg.sender];
    delete _answers[msg.sender];
  }

  // @param _authToken The encrypted SIWE token for authentication.
  // @param _addr The address of the user whose prompt count is being checked.
  function getPromptsCount(
    bytes memory _authToken,
    address _addr
  ) external view onlyUserOrOracle(_authToken, _addr) returns (uint256) {
    return _prompts[_addr].length;
  }

  // Returns all prompts for a given user address.
  // Called by the user in the frontend and by the oracle to generate the answer.
  // @param _authToken The encrypted SIWE token for authentication.
  // @param _addr The address of the user whose prompts are being retrieved.
  function getPrompts(
    bytes memory _authToken,
    address _addr
  ) external view onlyUserOrOracle(_authToken, _addr) returns (Prompt[] memory) {
    return _prompts[_addr];
  }

  // Returns all answers for a given user address.
  // Called by the user.
  // @param _authToken The encrypted SIWE token for authentication.
  // @param _addr The address of the user whose answers are being retrieved.
  function getAnswers(
    bytes memory _authToken,
    address _addr
  ) external view onlyUserOrOracle(_authToken, _addr) returns (Answer[] memory) {
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
  // @param _answer The plaintext AI response.
  // @param _promptId The unique identifier of the prompt being answered.
  // @param _addr The address of the user who initiated the prompt.
  function submitAnswer(
    string memory _answer,
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

    _answers[_addr].push(Answer({ promptId: _promptId, answer: _answer }));

    emit AnswerSubmitted(_addr, _promptId);

    agentEscrow.finalizePayment(_promptId);
  }
}
