// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import { Subcall } from "@oasisprotocol/sapphire-contracts/contracts/Subcall.sol";
import { SiweAuth } from "@oasisprotocol/sapphire-contracts/contracts/auth/SiweAuth.sol";

struct Prompt {
  uint256 promptId;
  string prompt;
}

struct Answer {
  uint256 promptId;
  string answer;
}

contract SapphireChatBot is SiweAuth {
  mapping(address => Prompt[]) private _prompts;
  mapping(address => Answer[]) private _answers;

  uint256 private _promptIdCounter;

  address public oracle; // Oracle address running inside TEE.
  bytes21 public roflAppID; // Allowed app ID within TEE for managing allowed oracle address.

  event PromptSubmitted(address indexed sender, uint256 promptId);
  event AnswerSubmitted(address indexed sender, uint256 promptId);

  error InvalidPromptId();
  error PromptAlreadyAnswered();
  error UnauthorizedUserOrOracle();
  error UnauthorizedOracle();

  // Sets up a chat bot smart contract where.
  // @param domain is used for SIWE login on the frontend
  // @param roflAppId is the attested ROFL app that is allowed to call setOracle()
  // @param inOracle only for testing, not attested; set the oracle address for accessing prompts
  constructor(string memory domain, bytes21 inRoflAppID, address inOracle) SiweAuth(domain) {
    roflAppID = inRoflAppID;
    oracle = inOracle;
  }

  // For the user: checks whether authToken is a valid SIWE token
  // corresponding to the requested address.
  // For the oracle: checks whether the transaction or query was signed by the
  // oracle's private key accessible only within TEE.
  modifier onlyUserOrOracle(bytes memory authToken, address addr) {
    if (msg.sender != addr && msg.sender != oracle) {
      address msgSender = authMsgSender(authToken);
      if (msgSender != addr && msgSender != oracle) {
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
  modifier onlyTEE(bytes21 appId) {
    Subcall.roflEnsureAuthorizedOrigin(appId);
    _;
  }

  // Append the new prompt and request answer.
  // Called by the user.
  function appendPrompt(string memory prompt) external {
    uint256 promptId = _promptIdCounter++;
    _prompts[msg.sender].push(Prompt({ promptId: promptId, prompt: prompt }));
    emit PromptSubmitted(msg.sender, promptId);
  }

  // Clears the conversation.
  // Called by the user.
  function clearPrompt() external {
    delete _prompts[msg.sender];
    delete _answers[msg.sender];
  }

  function getPromptsCount(
    bytes memory authToken,
    address addr
  ) external view onlyUserOrOracle(authToken, addr) returns (uint256) {
    return _prompts[addr].length;
  }

  // Returns all prompts for a given user address.
  // Called by the user in the frontend and by the oracle to generate the answer.
  function getPrompts(
    bytes memory authToken,
    address addr
  ) external view onlyUserOrOracle(authToken, addr) returns (Prompt[] memory) {
    return _prompts[addr];
  }

  // Returns all answers for a given user address.
  // Called by the user.
  function getAnswers(
    bytes memory authToken,
    address addr
  ) external view onlyUserOrOracle(authToken, addr) returns (Answer[] memory) {
    return _answers[addr];
  }

  // Sets the oracle address that will be allowed to read prompts and submit answers.
  // This setter can only be called within the ROFL TEE and the keypair
  // corresponding to the address should never leave TEE.
  function setOracle(address addr) external onlyTEE(roflAppID) {
    oracle = addr;
  }

  // Submits the answer to the prompt for a given user address.
  // Called by the oracle within TEE.
  function submitAnswer(string memory answer, uint256 promptId, address addr) external onlyOracle {
    // Check if a prompt with this ID exists for this user.
    bool promptExists = false;
    for (uint256 i = 0; i < _prompts[addr].length; i++) {
      if (_prompts[addr][i].promptId == promptId) {
        promptExists = true;
        break;
      }
    }
    if (!promptExists) {
      revert InvalidPromptId();
    }

    // Check if this prompt has already been answered.
    for (uint256 i = 0; i < _answers[addr].length; i++) {
      if (_answers[addr][i].promptId == promptId) {
        revert PromptAlreadyAnswered();
      }
    }

    _answers[addr].push(Answer({ promptId: promptId, answer: answer }));

    emit AnswerSubmitted(addr, promptId);
  }
}
