// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Compiles the SENSE token, from its own repository at the commit pinned in package.json, so the
// tests can run the escrow against the token itself. Nothing here is deployed outside tests.
// solhint-disable-next-line no-unused-import
import { SenseToken } from "sense-contracts/contracts/SenseToken.sol";
