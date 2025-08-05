// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

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

contract EVMChatBot {
  mapping(address => EncryptedPrompt[]) private _prompts;
  mapping(address => EncryptedAnswer[]) private _answers;

  uint256 private _promptIdCounter;

  address public oracle; // Oracle address running inside TEE.
  bytes21 public roflAppID; // Allowed app ID within TEE for managing allowed oracle address.
  string public domain; // The domain used for off-chain SIWE validation.

  event PromptSubmitted(address indexed sender, uint256 promptId);
  event AnswerSubmitted(address indexed sender, uint256 promptId);

  error InvalidPromptId();
  error PromptAlreadyAnswered();
  error UnauthorizedUserOrOracle();
  error UnauthorizedOracle();

  // Sets up a chat bot smart contract where.
  // @param inDomain is used for SIWE login on the frontend
  // @param inRoflAppID is the attested ROFL app that is allowed to call setOracle()
  // @param inOracle only for testing, not attested; set the oracle address for accessing prompts
  constructor(string memory inDomain, bytes21 inRoflAppID, address inOracle) {
    domain = inDomain;
    roflAppID = inRoflAppID;
    oracle = inOracle;
  }

  // For the user: checks that the caller is the specified user address.
  // For the oracle: checks that the transaction was signed by the oracle's private key.
  // @dev On a standard EVM, msg.sender is reliable and an authToken is not needed.
  modifier onlyUserOrOracle(address addr) {
    if (msg.sender != addr && msg.sender != oracle) {
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

  // Checks whether the transaction was signed by the ROFL's app key inside
  // TEE.
  // @dev Placeholder: This check requires a Sapphire precompile and cannot be performed on-chain here.
  modifier onlyTEE(bytes21 appId) {
    // TODO: A robust mechanism for TEE attestation on a standard EVM chain requires
    // further research (e.g., via light client or message bridge to Sapphire).
    _;
  }

  // Append the new prompt and request answer.
  // Called by the user.
  function appendPrompt(
    bytes calldata encryptedContent,
    bytes calldata userEncryptedKey,
    bytes calldata roflEncryptedKey
  ) external {
    uint256 promptId = _promptIdCounter++;
    EncryptedMessage memory promptMessage = EncryptedMessage({
      encryptedContent: encryptedContent,
      userEncryptedKey: userEncryptedKey,
      roflEncryptedKey: roflEncryptedKey
    });

    _prompts[msg.sender].push(EncryptedPrompt({ promptId: promptId, message: promptMessage }));

    emit PromptSubmitted(msg.sender, promptId);
  }

  // Clears the conversation.
  // Called by the user.
  function clearPrompt() external {
    delete _prompts[msg.sender];
    delete _answers[msg.sender];
  }

  function getPromptsCount(address addr) external view onlyUserOrOracle(addr) returns (uint256) {
    return _prompts[addr].length;
  }

  // Returns all prompts for a given user address.
  // Called by the user in the frontend and by the oracle to generate the answer.
  function getPrompts(
    address addr
  ) external view onlyUserOrOracle(addr) returns (EncryptedPrompt[] memory) {
    return _prompts[addr];
  }

  // Returns all answers for a given user address.
  // Called by the user.
  function getAnswers(
    address addr
  ) external view onlyUserOrOracle(addr) returns (EncryptedAnswer[] memory) {
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
  function submitAnswer(
    bytes calldata encryptedContent,
    bytes calldata userEncryptedKey,
    bytes calldata roflEncryptedKey,
    uint256 promptId,
    address addr
  ) external onlyOracle {
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

    EncryptedMessage memory answerMessage = EncryptedMessage({
      encryptedContent: encryptedContent,
      userEncryptedKey: userEncryptedKey,
      roflEncryptedKey: roflEncryptedKey
    });

    _answers[addr].push(EncryptedAnswer({ promptId: promptId, message: answerMessage }));

    emit AnswerSubmitted(addr, promptId);
  }
}
