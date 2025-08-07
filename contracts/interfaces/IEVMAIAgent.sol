// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

interface IEVMAIAgent {
  /**
   * @notice Returns the next promptId that will be generated.
   */
  function promptIdCounter() external view returns (uint256);

  /**
   * @notice Submits a new prompt after payment has been secured.
   * @param _promptId The unique identifier for the prompt.
   * @param _user The address of the user who initiated the prompt.
   * @param _encryptedContent The prompt, encrypted with a session key.
   * @param _userEncryptedKey The session key, encrypted for the user.
   * @param _roflEncryptedKey The session key, encrypted for the ROFL worker.
   */
  function submitPrompt(
    uint256 _promptId,
    address _user,
    bytes calldata _encryptedContent,
    bytes calldata _userEncryptedKey,
    bytes calldata _roflEncryptedKey
  ) external;
}
