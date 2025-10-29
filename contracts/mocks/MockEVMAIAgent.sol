// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import { IEVMAIAgentEscrow } from "../../contracts/interfaces/IEVMAIAgentEscrow.sol";
import { IEVMAIAgent } from "../../contracts/interfaces/IEVMAIAgent.sol";
import { Structs } from "../libraries/Structs.sol";

contract MockEVMAIAgent is IEVMAIAgent {
  uint256 private _conversationIdCounter;
  uint256 private _jobIdCounter;
  uint256 private _messageIdCounter;
  uint256 private _triggerIdCounter;

  // Made public to create an automatic getter, satisfying the IEVMAIAgent interface.
  address public oracle;

  // State variables to record the last call for testing
  uint256 public lastPromptMessageId;
  uint256 public lastAnswerMessageId;
  uint256 public lastConversationId;
  uint256 public lastNewConversationId;
  address public lastUser;
  uint256 public lastOriginalAnswerMessageId;
  uint256 public lastTriggerId;
  uint256 public lastJobId;
  uint256 public lastOriginalConversationId;
  uint256 public lastBranchPointMessageId;

  event PromptSubmitted(address user, uint256 conversationId, uint256 promptMessageId);
  event RegenerationSubmitted(address user, uint256 conversationId, uint256 promptMessageId);
  event AgentJobSubmitted(address user, uint256 jobId, uint256 triggerId);
  event MetadataUpdateSubmitted(address user, uint256 conversationId);
  event BranchRequestSubmitted(
    address user,
    uint256 originalConversationId,
    uint256 newConversationId
  );
  event CancellationRecorded(address user, uint256 answerMessageId);
  event AnswerSubmitted(uint256 promptMessageId, uint256 answerMessageId);
  event BranchSubmitted(uint256 newConversationId, uint256 originalConversationId);
  event MetadataSubmitted(uint256 conversationId);

  constructor(address _initialOracle) {
    oracle = _initialOracle;
    _conversationIdCounter = 1;
    _jobIdCounter = 1;
  }

  function reserveConversationId() external override returns (uint256) {
    uint256 id = _conversationIdCounter;
    _conversationIdCounter++;
    return id;
  }

  function reserveJobId() external override returns (uint256) {
    uint256 id = _jobIdCounter;
    _jobIdCounter++;
    return id;
  }

  function reserveMessageId() external override returns (uint256) {
    uint256 id = _messageIdCounter;
    _messageIdCounter++;
    return id;
  }

  function reserveTriggerId() external override returns (uint256) {
    uint256 id = _triggerIdCounter;
    _triggerIdCounter++;
    return id;
  }

  function submitPrompt(
    address _user,
    uint256 _conversationId,
    uint256 _promptMessageId,
    uint256 _answerMessageId,
    bytes calldata, // _encryptedPayload
    bytes calldata // _roflEncryptedKey
  ) external override {
    lastUser = _user;
    lastConversationId = _conversationId;
    lastPromptMessageId = _promptMessageId;
    lastAnswerMessageId = _answerMessageId;
    emit PromptSubmitted(_user, _conversationId, _promptMessageId);
  }

  function submitAnswer(
    uint256 _promptMessageId,
    uint256 _answerMessageId,
    Structs.CidBundle calldata // _cids
  ) external override {
    lastPromptMessageId = _promptMessageId;
    lastAnswerMessageId = _answerMessageId;
    emit AnswerSubmitted(_promptMessageId, _answerMessageId);
  }

  function submitRegenerationRequest(
    address _user,
    uint256 _conversationId,
    uint256 _promptMessageId,
    uint256 _originalAnswerMessageId,
    uint256 _answerMessageId,
    bytes calldata, // _encryptedPayload
    bytes calldata // _roflEncryptedKey
  ) external override {
    lastUser = _user;
    lastConversationId = _conversationId;
    lastPromptMessageId = _promptMessageId;
    lastOriginalAnswerMessageId = _originalAnswerMessageId;
    lastAnswerMessageId = _answerMessageId;
    emit RegenerationSubmitted(_user, _conversationId, _promptMessageId);
  }

  function submitAgentJob(
    address _user,
    uint256 _jobId,
    uint256 _triggerId,
    bytes calldata, // _encryptedPayload
    bytes calldata // _roflEncryptedKey
  ) external override {
    lastUser = _user;
    lastJobId = _jobId;
    lastTriggerId = _triggerId;
    emit AgentJobSubmitted(_user, _jobId, _triggerId);
  }

  function submitMetadataUpdate(
    address _user,
    uint256 _conversationId,
    bytes calldata, // _encryptedPayload
    bytes calldata // _roflEncryptedKey
  ) external override {
    lastUser = _user;
    lastConversationId = _conversationId;
    emit MetadataUpdateSubmitted(_user, _conversationId);
  }

  function submitBranchRequest(
    address _user,
    uint256 _originalConversationId,
    uint256 _branchPointMessageId,
    uint256 _newConversationId,
    bytes calldata, // _encryptedPayload
    bytes calldata // _roflEncryptedKey
  ) external override {
    lastUser = _user;
    lastOriginalConversationId = _originalConversationId;
    lastBranchPointMessageId = _branchPointMessageId;
    lastNewConversationId = _newConversationId;
    emit BranchRequestSubmitted(_user, _originalConversationId, _newConversationId);
  }

  function recordCancellation(address _user, uint256 _answerMessageId) external override {
    lastUser = _user;
    lastAnswerMessageId = _answerMessageId;
    emit CancellationRecorded(_user, _answerMessageId);
  }

  function submitConversationMetadata(
    uint256 _conversationId,
    string calldata // _newConversationMetadataCID
  ) external override {
    lastConversationId = _conversationId;
    emit MetadataSubmitted(_conversationId);
  }

  function submitBranch(
    address _user,
    uint256 _originalConversationId,
    uint256 _branchPointMessageId,
    uint256 _newConversationId,
    string calldata, // _conversationCID
    string calldata // _metadataCID
  ) external override {
    lastUser = _user;
    lastOriginalConversationId = _originalConversationId;
    lastBranchPointMessageId = _branchPointMessageId;
    lastNewConversationId = _newConversationId;
    emit BranchSubmitted(_newConversationId, _originalConversationId);
  }

  // A helper for the test suite to simulate the agent calling back to finalize payment.
  function callFinalizePayment(address _escrow, uint256 _escrowId) external {
    IEVMAIAgentEscrow(_escrow).finalizePayment(_escrowId);
  }
}
