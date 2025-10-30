// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import { Subcall } from "@oasisprotocol/sapphire-contracts/contracts/Subcall.sol";
import { ISapphireAIAgentEscrow } from "./interfaces/ISapphireAIAgentEscrow.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Structs } from "./libraries/Structs.sol";

/**
 * @title Sapphire AI Agent Contract
 * @dev This contract acts as an on-chain registry for a decentralized AI agent system.
 *      It manages ownership of conversations and messages, emitting events that allow
 *      off-chain indexers (like The Graph) to build a queryable history of interactions.
 *      Content is stored off-chain (e.g., on Arweave) and referenced by Content IDs (CIDs).
 *      All event payloads are confidentially stored by the Sapphire runtime.
 */
contract SapphireAIAgent is Ownable {
  // --- State Variables ---

  /// @notice The TEE-based oracle address authorized to submit answers.
  address public oracle;
  /// @notice The attested application ID of the ROFL TEE allowed to manage the oracle address.
  bytes21 public roflAppID;
  /// @notice The associated escrow contract that handles all payments.
  ISapphireAIAgentEscrow public aiAgentEscrow;
  /// @notice The domain used for off-chain SIWE validation.
  string public domain;

  /// @notice A counter to ensure each conversation gets a unique ID.
  uint256 public conversationIdCounter;
  /// @notice A counter to ensure each message gets a unique ID.
  uint256 public messageIdCounter;
  /// @notice A counter to ensure each autonomous agent job gets a unique ID.
  uint256 public jobIdCounter;
  /// @notice A counter to ensure each job trigger gets a unique ID.
  uint256 public triggerIdCounter;

  /// @notice Maps a conversation ID to the owner's address for on-chain ownership verification.
  mapping(uint256 => address) public conversationToOwner;
  /// @notice Maps a job ID to the owner's address for on-chain ownership verification.
  mapping(uint256 => address) public jobToOwner;
  /// @notice Maps a message ID to its parent conversation ID for relational integrity checks.
  mapping(uint256 => uint256) public messageToConversation;
  /// @notice Maps a trigger ID to its parent job ID for relational integrity checks.
  mapping(uint256 => uint256) public triggerToJob;
  /// @notice Tracks whether an escrowed job (by its answer/trigger ID) has been completed or cancelled.
  mapping(uint256 => bool) public isJobFinalized;
  /// @notice Tracks whether a prompt message is currently pending a regeneration response.
  mapping(uint256 => bool) public isRegenerationPending;

  // --- Events ---

  // TEE Trigger Events
  /// @notice Emitted when a new user prompt is submitted. This is the primary trigger for the TEE.
  event PromptSubmitted(
    address indexed user,
    uint256 indexed conversationId,
    uint256 indexed promptMessageId,
    uint256 answerMessageId,
    string payload
  );
  /// @notice Emitted when a new agent job is submitted. This is a trigger for the TEE.
  event AgentJobSubmitted(
    address indexed user,
    uint256 indexed jobId,
    uint256 indexed triggerId,
    string payload
  );
  /// @notice Emitted when a user requests the TEE to regenerate an answer.
  event RegenerationRequested(
    address indexed user,
    uint256 indexed conversationId,
    uint256 indexed promptMessageId,
    uint256 originalAnswerMessageId,
    uint256 answerMessageId,
    string payload
  );
  /// @notice Emitted when a user requests the TEE to branch a conversation.
  event BranchRequested(
    address indexed user,
    uint256 indexed originalConversationId,
    uint256 branchPointMessageId,
    uint256 newConversationId,
    string payload
  );
  /// @notice Emitted when a user successfully cancels a pending prompt. This instructs the TEE to halt processing.
  event PromptCancelled(address indexed user, uint256 indexed answerMessageId);
  /// @notice Emitted when a user requests a metadata update. This instructs the TEE to update decentralised storage.
  event MetadataUpdateRequested(
    address indexed user,
    uint256 indexed conversationId,
    string payload
  );

  // Graph Historical Record Events
  /// @notice Emitted when a new conversation is started.
  event ConversationAdded(
    address indexed user,
    uint256 indexed conversationId,
    string conversationCID,
    string metadataCID
  );
  /// @notice Emitted when a new conversation is forked from an existing one.
  event ConversationBranched(
    address indexed user,
    uint256 indexed newConversationId,
    uint256 originalConversationId,
    uint256 branchPointMessageId,
    string conversationCID,
    string metadataCID
  );
  /// @notice Emitted when a user adds a new prompt to a conversation.
  event PromptMessageAdded(
    uint256 indexed conversationId,
    uint256 indexed messageId,
    string messageCID
  );
  /// @notice Emitted when the oracle submits an answer to a prompt.
  event AnswerMessageAdded(
    uint256 indexed conversationId,
    uint256 indexed messageId,
    string messageCID
  );
  /// @notice Emitted with a prompt to provide keywords for off-chain search indexing.
  event SearchIndexDeltaAdded(uint256 indexed messageId, string searchDeltaCID);
  /// @notice Emitted when a conversation's metadata CID is updated by the TEE.
  event ConversationMetadataUpdated(
    uint256 indexed conversationId,
    string newConversationMetadataCID
  );

  // Admin Events
  /// @notice Emitted when the linked escrow contract address is updated.
  event AgentEscrowUpdated(address indexed newAIAgentEscrow);
  /// @notice Emitted when the oracle address is updated by a TEE.
  event OracleUpdated(address indexed newOracle);

  // --- Errors ---

  // Admin and Setup Errors
  /// @notice Reverts if an address parameter is the zero address.
  error ZeroAddress();
  /// @notice Reverts if an attempt is made to set the escrow address more than once.
  error AgentEscrowAlreadySet();

  // Access Control Errors
  /// @notice Reverts if a function is called by an unauthorized user.
  error Unauthorized();
  /// @notice Reverts if a function is called by an address that is not the authorized oracle.
  error UnauthorizedOracle();
  /// @notice Reverts if a function is called by an address other than the linked escrow contract.
  error NotAIAgentEscrow();

  // Input Validation Errors
  /// @notice Reverts if the oracle attempts to answer a prompt that does not exist.
  error InvalidPromptMessageId();
  /// @notice Reverts if the oracle submits an answer without providing a CID for the answer message.
  error AnswerCIDRequired();

  // State Machine Errors
  /// @notice Reverts if an answer or cancellation is submitted for an already-answered job.
  error JobAlreadyFinalized();
  /// @notice Reverts if a regeneration is requested for a prompt that already has one pending.
  error RegenerationAlreadyPending();

  // --- Constructor ---

  /**
   * @notice Sets up the AI Agent smart contract.
   * @param _domain The domain used for off-chain SIWE validation.
   * @param _roflAppID The attested ROFL app that is allowed to call setOracle().
   * @param _initialOracle The initial TEE oracle address for accessing prompts.
   * @param _initialOwner The address that will have ownership of this contract.
   */
  constructor(
    string memory _domain,
    bytes21 _roflAppID,
    address _initialOracle,
    address _initialOwner
  ) Ownable(_initialOwner) {
    if (_initialOracle == address(0)) {
      revert ZeroAddress();
    }
    domain = _domain;
    roflAppID = _roflAppID;
    oracle = _initialOracle;

    // Initialize counters to start from 1 to avoid Zero ID Problem when creating new entities
    conversationIdCounter = 1;
    jobIdCounter = 1;
  }

  // --- Modifiers ---

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
   * @notice Checks that the caller is the registered SapphireAIAgentEscrow contract.
   */
  modifier onlyAIAgentEscrow() {
    if (msg.sender != address(aiAgentEscrow)) {
      revert NotAIAgentEscrow();
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

  // --- Administrative Functions ---

  /**
   * @notice Sets the address of the AgentEscrow contract.
   * @dev This can only be called once by the owner to complete the deployment linking.
   * @param _newAIAgentEscrow The address of the deployed SapphireAIAgentEscrow contract.
   */
  function setAgentEscrow(address _newAIAgentEscrow) external onlyOwner {
    if (_newAIAgentEscrow == address(0)) {
      revert ZeroAddress();
    }
    if (address(aiAgentEscrow) != address(0)) {
      revert AgentEscrowAlreadySet();
    }
    aiAgentEscrow = ISapphireAIAgentEscrow(_newAIAgentEscrow);
    emit AgentEscrowUpdated(_newAIAgentEscrow);
  }

  /**
   * @notice Sets the oracle address that will be allowed to read prompts and submit answers.
   * @dev This setter can only be called from within an authorized ROFL TEE, verified by Sapphire.
   * @param _newOracle The new address for the oracle.
   */
  function setOracle(address _newOracle) external onlyTEE(roflAppID) {
    if (_newOracle == address(0)) {
      revert ZeroAddress();
    }
    oracle = _newOracle;
    emit OracleUpdated(_newOracle);
  }

  // --- Core Functions ---

  /**
   * @notice Atomically reserves a new conversation ID for an upcoming action.
   * @dev This can only be called by the trusted escrow contract.
   * @return newConversationId The newly reserved conversation ID.
   */
  function reserveConversationId() external onlyAIAgentEscrow returns (uint256) {
    uint256 newConversationId = conversationIdCounter;
    conversationIdCounter++;
    return newConversationId;
  }

  /**
   * @notice Atomically reserves a new job ID for an upcoming action.
   * @dev This can only be called by the trusted escrow contract.
   * @return newJobId The newly reserved job ID.
   */
  function reserveJobId() external onlyAIAgentEscrow returns (uint256) {
    uint256 newJobId = jobIdCounter;
    jobIdCounter++;
    return newJobId;
  }

  /**
   * @notice Atomically reserves a new message ID for an upcoming action.
   * @dev This can only be called by the trusted escrow contract to prevent ID griefing.
   *      It ensures that every ID retrieved is unique and the counter is immediately updated.
   * @return newMessageId The newly reserved message ID.
   */
  function reserveMessageId() external onlyAIAgentEscrow returns (uint256) {
    uint256 newMessageId = messageIdCounter;
    messageIdCounter++;
    return newMessageId;
  }

  /**
   * @notice Atomically reserves a new trigger ID for an upcoming agent job.
   * @dev This can only be called by the trusted escrow contract.
   * @return newTriggerId The newly reserved trigger ID.
   */
  function reserveTriggerId() external onlyAIAgentEscrow returns (uint256) {
    uint256 newTriggerId = triggerIdCounter;
    triggerIdCounter++;
    return newTriggerId;
  }

  /**
   * @notice Records a new user prompt after IDs have been reserved and payment secured.
   * @dev This function can only be called by the linked `SapphireAIAgentEscrow` contract.
   * @param _user The address of the user who initiated the prompt.
   * @param _conversationId The ID of the conversation. If this was a newly reserved ID, ownership is assigned.
   * @param _promptMessageId The unique, pre-reserved ID for this prompt message.
   * @param _answerMessageId The unique, pre-reserved ID for the future answer.
   * @param _payload The plaintext prompt data for the TEE, handled confidentially by Sapphire.
   */
  function submitPrompt(
    address _user,
    uint256 _conversationId,
    uint256 _promptMessageId,
    uint256 _answerMessageId,
    string calldata _payload
  ) external onlyAIAgentEscrow {
    if (conversationToOwner[_conversationId] == address(0)) {
      conversationToOwner[_conversationId] = _user;
    } else if (conversationToOwner[_conversationId] != _user) {
      revert Unauthorized();
    }

    messageToConversation[_promptMessageId] = _conversationId;
    emit PromptSubmitted(_user, _conversationId, _promptMessageId, _answerMessageId, _payload);
  }

  /**
   * @notice Records a user's request to regenerate an answer after payment is secured.
   * @dev This function can only be called by the linked `SapphireAIAgentEscrow` contract. It places a
   *      lock on the original prompt to prevent multiple simultaneous regenerations.
   * @param _user The address of the user requesting the regeneration.
   * @param _conversationId The ID of the conversation this regeneration belongs to.
   * @param _promptMessageId The ID of the user's prompt being regenerated.
   * @param _originalAnswerMessageId The ID of the AI answer to regenerate from.
   * @param _answerMessageId The unique, pre-reserved ID for the future answer.
   * @param _payload The plaintext instructions for the TEE, handled confidentially by Sapphire.
   */
  function submitRegenerationRequest(
    address _user,
    uint256 _conversationId,
    uint256 _promptMessageId,
    uint256 _originalAnswerMessageId,
    uint256 _answerMessageId,
    string calldata _payload
  ) external onlyAIAgentEscrow {
    if (isRegenerationPending[_promptMessageId]) {
      revert RegenerationAlreadyPending();
    }
    if (conversationToOwner[_conversationId] != _user) {
      revert Unauthorized();
    }

    isRegenerationPending[_promptMessageId] = true;

    emit RegenerationRequested(
      _user,
      _conversationId,
      _promptMessageId,
      _originalAnswerMessageId,
      _answerMessageId,
      _payload
    );
  }

  /**
   * @notice Records a new autonomous agent job after payment has been secured by the escrow contract.
   * @dev This function can only be called by the linked `SapphireAIAgentEscrow` contract.
   * @param _user The address of the user for whom the job is being run.
   * @param _jobId The ID of the parent job. If this was a newly reserved ID, ownership is assigned.
   * @param _triggerId The unique identifier for this specific job trigger.
   * @param _payload The plaintext job data for the TEE, handled confidentially by Sapphire.
   */
  function submitAgentJob(
    address _user,
    uint256 _jobId,
    uint256 _triggerId,
    string calldata _payload
  ) external onlyAIAgentEscrow {
    if (jobToOwner[_jobId] == address(0)) {
      jobToOwner[_jobId] = _user;
    } else if (jobToOwner[_jobId] != _user) {
      revert Unauthorized();
    }

    triggerToJob[_triggerId] = _jobId;
    emit AgentJobSubmitted(_user, _jobId, _triggerId, _payload);
  }

  /**
   * @notice Submits the final answer and all related decentralised storage CIDs for a prompt.
   * @dev Called by the oracle from within its TEE. The answer ID was pre-reserved.
   * @param _promptMessageId The ID of the user's prompt being answered.
   * @param _answerMessageId The pre-reserved ID that must be used for this answer message.
   * @param _cids A struct containing all the decentralised storage CIDs for the relevant files.
   */
  function submitAnswer(
    uint256 _promptMessageId,
    uint256 _answerMessageId,
    Structs.CidBundle calldata _cids
  ) external onlyOracle {
    if (isJobFinalized[_answerMessageId]) {
      revert JobAlreadyFinalized();
    }

    if (bytes(_cids.answerMessageCID).length == 0) {
      revert AnswerCIDRequired();
    }

    uint256 conversationId = messageToConversation[_promptMessageId];

    if (conversationToOwner[conversationId] == address(0)) {
      revert InvalidPromptMessageId();
    }

    isJobFinalized[_answerMessageId] = true;
    address user = conversationToOwner[conversationId];

    if (bytes(_cids.conversationCID).length > 0) {
      emit ConversationAdded(user, conversationId, _cids.conversationCID, _cids.metadataCID);
    }

    if (bytes(_cids.promptMessageCID).length > 0) {
      emit PromptMessageAdded(conversationId, _promptMessageId, _cids.promptMessageCID);
      emit SearchIndexDeltaAdded(_promptMessageId, _cids.searchDeltaCID);
    } else if (isRegenerationPending[_promptMessageId]) {
      // This is a regeneration response, so unlock the original prompt.
      isRegenerationPending[_promptMessageId] = false;
    }

    messageToConversation[_answerMessageId] = conversationId;
    emit AnswerMessageAdded(conversationId, _answerMessageId, _cids.answerMessageCID);
    aiAgentEscrow.finalizePayment(_answerMessageId);
  }

  /**
   * @notice Records a user's request to update a conversation's metadata.
   * @dev This function can only be called by the linked `SapphireAIAgentEscrow` contract after charging a fee.
   * @param _user The address of the user requesting the update.
   * @param _conversationId The ID of the conversation to update.
   * @param _payload The plaintext ABI-encoded update instructions (e.g., new title).
   */
  function submitMetadataUpdate(
    address _user,
    uint256 _conversationId,
    string calldata _payload
  ) external onlyAIAgentEscrow {
    if (conversationToOwner[_conversationId] != _user) {
      revert Unauthorized();
    }

    emit MetadataUpdateRequested(_user, _conversationId, _payload);
  }

  /**
   * @notice Reveals the new metadata CID after the TEE has updated decentralised storage.
   * @dev This function can only be called by the authorized oracle.
   * @param _conversationId The ID of the conversation that was updated.
   * @param _newConversationMetadataCID The decentralised storage CID of the new metadata file.
   */
  function submitConversationMetadata(
    uint256 _conversationId,
    string calldata _newConversationMetadataCID
  ) external onlyOracle {
    emit ConversationMetadataUpdated(_conversationId, _newConversationMetadataCID);
  }

  /**
   * @notice Records a user's request to branch a conversation after the fee is paid.
   * @dev This function can only be called by the linked `SapphireAIAgentEscrow` contract.
   * @param _user The address of the user who is branching the conversation.
   * @param _originalConversationId The ID of the conversation being branched from.
   * @param _branchPointMessageId The ID of the message where the branch occurs.
   * @param _newConversationId The pre-reserved ID for the new branched conversation.
   * @param _payload The plaintext context from the client.
   */
  function submitBranchRequest(
    address _user,
    uint256 _originalConversationId,
    uint256 _branchPointMessageId,
    uint256 _newConversationId,
    string calldata _payload
  ) external onlyAIAgentEscrow {
    if (conversationToOwner[_originalConversationId] != _user) {
      revert Unauthorized();
    }
    conversationToOwner[_newConversationId] = _user;

    emit BranchRequested(
      _user,
      _originalConversationId,
      _branchPointMessageId,
      _newConversationId,
      _payload
    );
  }

  /**
   * @notice Submits the final CIDs for a newly branched conversation.
   * @dev Called by the oracle. Uses the pre-reserved newConversationId.
   * @param _user The address of the user who initiated the branch.
   * @param _originalConversationId The ID of the conversation that was branched from.
   * @param _branchPointMessageId The ID of the message where the branch occurs.
   * @param _newConversationId The pre-reserved ID for the new conversation.
   * @param _conversationCID The decentralised storage CID for the new branched conversation's data.
   * @param _metadataCID The decentralised storage CID for the new branched conversation's metadata.
   */
  function submitBranch(
    address _user,
    uint256 _originalConversationId,
    uint256 _branchPointMessageId,
    uint256 _newConversationId,
    string calldata _conversationCID,
    string calldata _metadataCID
  ) external onlyOracle {
    if (conversationToOwner[_newConversationId] != _user) {
      revert Unauthorized();
    }

    emit ConversationBranched(
      _user,
      _newConversationId,
      _originalConversationId,
      _branchPointMessageId,
      _conversationCID,
      _metadataCID
    );
  }

  /**
   * @notice Records that a prompt was cancelled by the user.
   * @dev This function can only be called by the linked `SapphireAIAgentEscrow` contract.
   *      It sets the answered flag to prevent the oracle from submitting a late answer.
   * @param _user The address of the user who cancelled.
   * @param _answerMessageId The ID of the answer that was cancelled.
   */
  function recordCancellation(address _user, uint256 _answerMessageId) external onlyAIAgentEscrow {
    if (isJobFinalized[_answerMessageId]) {
      revert JobAlreadyFinalized();
    }

    isJobFinalized[_answerMessageId] = true;
    emit PromptCancelled(_user, _answerMessageId);
  }
}
