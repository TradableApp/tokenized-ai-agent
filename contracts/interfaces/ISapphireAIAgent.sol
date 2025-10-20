// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import { Structs } from "../libraries/Structs.sol";

interface ISapphireAIAgent {
  /**
   * @notice Returns the address of the currently authorized oracle.
   * @dev This is the single source of truth for the oracle's address in the system.
   */
  function oracle() external view returns (address);

  /**
   * @notice Atomically reserves a new message ID.
   * @return The newly reserved message ID.
   */
  function reserveMessageId() external returns (uint256);

  /**
   * @notice Atomically reserves a new trigger ID for an agent job.
   * @return The newly reserved trigger ID.
   */
  function reserveTriggerId() external returns (uint256);

  /**
   * @notice Submits a new prompt after payment has been secured.
   * @param _promptMessageId The unique, pre-reserved ID for this prompt message.
   * @param _answerMessageId The unique, pre-reserved ID for the future answer.
   * @param _conversationId The ID of the conversation. If 0, a new conversation will be created.
   * @param _user The address of the user who initiated the prompt.
   * @param _payload The plaintext prompt data for the TEE, handled confidentially by Sapphire.
   */
  function submitPrompt(
    uint256 _promptMessageId,
    uint256 _answerMessageId,
    uint256 _conversationId,
    address _user,
    string calldata _payload
  ) external;

  /**
   * @notice Submits a request to regenerate a previous answer.
   * @param _user The address of the user requesting the regeneration.
   * @param _promptMessageId The ID of the user's prompt being regenerated.
   * @param _originalAnswerMessageId The ID of the AI answer to regenerate from.
   * @param _answerMessageId The unique, pre-reserved ID for the new answer.
   * @param _payload The plaintext instructions for the TEE, handled confidentially by Sapphire.
   */
  function submitRegenerationRequest(
    address _user,
    uint256 _promptMessageId,
    uint256 _originalAnswerMessageId,
    uint256 _answerMessageId,
    string calldata _payload
  ) external;

  /**
   * @notice Submits a new autonomous agent job.
   * @param _triggerId The unique identifier for this specific job trigger.
   * @param _jobId The ID of the parent job. If 0, a new job will be created.
   * @param _user The address of the user for whom the job is being run.
   * @param _payload The plaintext job data for the TEE, handled confidentially by Sapphire.
   */
  function submitAgentJob(
    uint256 _triggerId,
    uint256 _jobId,
    address _user,
    string calldata _payload
  ) external;

  /**
   * @notice Submits the final answer and all related Arweave CIDs for a prompt.
   * @param _promptMessageId The ID of the user's prompt being answered.
   * @param _answerMessageId The pre-reserved ID that must be used for this answer message.
   * @param _cids A struct containing all the Arweave CIDs for the relevant files.
   */
  function submitAnswer(
    uint256 _promptMessageId,
    uint256 _answerMessageId,
    Structs.CidBundle calldata _cids
  ) external;

  /**
   * @notice Records a user's request to update a conversation's metadata.
   * @param _conversationId The ID of the conversation to update.
   * @param _user The address of the user requesting the update.
   * @param _payload The plaintext update instructions for the TEE, handled confidentially by Sapphire.
   */
  function submitMetadataUpdate(
    uint256 _conversationId,
    address _user,
    string calldata _payload
  ) external;

  /**
   * @notice Records a user's request to branch a conversation.
   * @param _user The address of the user who is branching the conversation.
   * @param _originalConversationId The ID of the conversation being branched from.
   * @param _branchPointMessageId The ID of the message where the branch occurs.
   */
  function submitBranchRequest(
    address _user,
    uint256 _originalConversationId,
    uint256 _branchPointMessageId
  ) external;

  /**
   * @notice Records that a prompt was cancelled by the user.
   * @param _answerMessageId The ID of the answer that was cancelled.
   * @param _user The address of the user who cancelled.
   */
  function recordCancellation(uint256 _answerMessageId, address _user) external;
}
