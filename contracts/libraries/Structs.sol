// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

/**
 * @dev A central library for shared data structures used across the AI Agent contracts.
 */
library Structs {
  /// @notice A bundle of off-chain Content IDs (CIDs) related to a message submission.
  struct CidBundle {
    string conversationCID;
    string metadataCID;
    string promptMessageCID;
    string answerMessageCID;
    string searchDeltaCID;
  }
}
