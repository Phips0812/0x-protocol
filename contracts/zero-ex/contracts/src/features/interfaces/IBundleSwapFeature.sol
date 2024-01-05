// SPDX-License-Identifier: Apache-2.0
/*
  Copyright 2023 31Third B.V.
  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at
    http://www.apache.org/licenses/LICENSE-2.0
  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
*/

pragma solidity ^0.6.5;
pragma experimental ABIEncoderV2;

import "@0x/contracts-erc20/src/IERC20Token.sol";
import "../libs/LibSignature.sol";

/// @dev Bundle swap feature.
interface IBundleSwapFeature {

    /// @dev Describes an exchange proxy swap.
    struct Swap {
        IERC20Token inputToken; // can also be ETH pseudo-token
        IERC20Token outputToken; // can also be ETH pseudo-token
        uint256 inputTokenAmount;
        // Encoded call data to a function on the exchange proxy.
        bytes data;
    }

    /// @dev Describes the result of one swap.
    struct Result {
        bool success;
        bytes returnData;
        bytes4 testSelector;
        address testAddress;
        address testAddress2;
    }

    /// @dev Behaviour in case a swap fails.
    enum ErrorBehaviour {
        // As soon as one trade fails the whole tx reverts
        REVERT,
        // As soon as one trade fails the tx stops, but already executed trades stay executed.
        // The input token of the failed trade is returned to the user's wallet. If the returnable amount is not exactly the same as inputTokenAmount the whole tx reverts as well
        STOP,
        // If an error occurs the execution jumps to the next trade.
        // The input token of the failed trade is returned to the user's wallet. If the returnable amount is not exactly the same as inputTokenAmount the whole tx reverts as well.
        CONTINUE
    }

    /// @dev Execute a bundle swap.
    /// @param swaps The bundle of swaps.
    /// @return returnResults The ABI-encoded results of the underlying calls.
    function bundleSwap(
        Swap[] calldata swaps,
        ErrorBehaviour errorBehaviour
    ) external payable returns (Result[] memory returnResults);
}
