// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import { Subcall } from "@oasisprotocol/sapphire-contracts/contracts/Subcall.sol";
import { SiweAuth } from "@oasisprotocol/sapphire-contracts/contracts/auth/SiweAuth.sol";
import { ISapphireAIAgentEscrow } from "./interfaces/ISapphireAIAgentEscrow.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

struct Prompt {
  uint256 promptId;
  string prompt;
}

struct Answer {
  uint256 promptId;
  string answer;
}

contract SapphireAIAgent is SiweAuth, Ownable {
  mapping(address => Prompt[]) private _prompts;
  mapping(address => Answer[]) private _answers;
  mapping(uint256 => address) public promptIdToUser;
  mapping(uint256 => bool) public isPromptAnswered;

  uint256 public promptIdCounter;

  address public oracle; // Oracle address running inside TEE.
  bytes21 public roflAppID; // Allowed app ID within TEE for managing allowed oracle address.
  ISapphireAIAgentEscrow public agentEscrow; // The escrow contract that manages payments.

  event PromptSubmitted(address indexed sender, uint256 indexed promptId);
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

  // Sets up a chat bot smart contract where.
  // @param _domain is used for SIWE login on the frontend
  // @param _roflAppID is the attested ROFL app that is allowed to call setOracle()
  // @param _oracle only for testing, not attested; set the oracle address for accessing prompts
  // @param _initialOwner The address that will have ownership of this contract.
  constructor(
    string memory _domain,
    bytes21 _roflAppID,
    address _oracle,
    address _initialOwner
  ) SiweAuth(_domain) Ownable(_initialOwner) {
    if (_oracle == address(0) || _initialOwner == address(0)) {
      revert ZeroAddress();
    }

    roflAppID = _roflAppID;
    oracle = _oracle;
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

  // For the user: checks whether authToken is a valid SIWE token
  // corresponding to the requested address.
  // @param _authToken The encrypted SIWE token for authentication.
  // @param _addr The address being authenticated.
  modifier onlyUser(bytes memory _authToken, address _addr) {
    if (msg.sender != _addr) {
      address msgSender = authMsgSender(_authToken);
      if (msgSender != _addr) {
        revert UnauthorizedUser();
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

  // Submits a new prompt after payment has been secured by the SapphireAIAgentEscrow contract.
  // Called by the SapphireAIAgentEscrow contract.
  // @param _promptId The unique identifier for the prompt.
  // @param _user The original user who initiated the prompt.
  // @param _prompt The plaintext prompt from the user.
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

  // Clears the conversation.
  // Called by the user.
  // @param _authToken The encrypted SIWE token for authentication.
  // @param _addr The address of the user whose conversation is being cleared.
  function clearPrompt(
    bytes memory _authToken,
    address _addr
  ) external onlyUser(_authToken, _addr) {
    delete _prompts[_addr];
    delete _answers[_addr];
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
