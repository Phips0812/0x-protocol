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
import "@0x/contracts-utils/contracts/src/v06/errors/LibRichErrorsV06.sol";
import "@0x/contracts-utils/contracts/src/v06/LibBytesV06.sol";
import "../fixins/FixinCommon.sol";
import "../migrations/LibMigrate.sol";
import "./interfaces/IFeature.sol";
import "./interfaces/IBundleSwapFeature.sol";
import "../IZeroEx.sol";
import "../ZeroEx.sol";

/// @dev Bundle swap feature.
contract BundleSwapFeature is
    IFeature,
    IBundleSwapFeature,
    FixinCommon
{
    using LibBytesV06 for bytes;
    using LibRichErrorsV06 for bytes;

    /// @dev Name of this feature.
    string public constant override FEATURE_NAME = "BundleSwap";
    /// @dev Version of this feature.
    uint256 public immutable override FEATURE_VERSION = _encodeVersion(1, 0, 0);
    /// @dev ETH pseudo-token address.
    address private constant ETH_TOKEN_ADDRESS = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    constructor() public FixinCommon() {}

    /// @dev Initialize and register this feature.
    ///      Should be delegatecalled by `Migrate.migrate()`.
    /// @return success `LibMigrate.SUCCESS` on success.
    function migrate() external returns (bytes4 success) {
        _registerFeatureFunction(this.bundleSwap.selector);
        return LibMigrate.MIGRATE_SUCCESS;
    }
    
    function bundleSwap(
        Swap[] calldata swaps,
        ErrorBehaviour errorBehaviour
    ) public payable override returns (Result[] memory returnResults) {
        uint256 length = swaps.length;
        returnResults = new Result[](length);

        uint256 valueUsed = 0;

        for (uint256 i = 0; i < length; ++i) {
            Swap calldata swap = swaps[i];
            Result memory result = returnResults[i];

            uint256 inputTokenBalanceBefore = _getInputTokenBalance(swap.inputToken);

            if (address(swap.inputToken) == ETH_TOKEN_ADDRESS) {
                valueUsed += swap.inputTokenAmount;
                if (valueUsed > msg.value) {
                    // ErrorBehaviour exception - ETH leak
                    revert("BundleSwapFeature::bundleSwap/ETH_LEAK");
                }

                uint256 outputTokenBalanceBefore = swap.outputToken.balanceOf(address(this));

                // address(this) = address of ZeroExProxy since the proxy is using delegatecall
                (result.success, result.returnData) = address(this).call{value: swap.inputTokenAmount}(swap.data);

                if (result.success) {
                    uint256 outputTokenBalanceAfter = swap.outputToken.balanceOf(address(this));
                    bool transferSuccess = swap.outputToken.transfer(msg.sender, outputTokenBalanceAfter - outputTokenBalanceBefore);
                    if (!transferSuccess) {
                        // ErrorBehaviour exception - Failed to return token
                        revert("BundleSwapFeature::bundleSwap/OUTPUT_TOKEN_TRANSFER_FAILED");
                    }
                }
            } else {
                // address(this) = address of ZeroExProxy since the proxy is using delegatecall
                (result.success, result.returnData) = address(this).delegatecall(swap.data);
            }

            if (!result.success) {
                if (errorBehaviour == ErrorBehaviour.REVERT) {
                    result.returnData.rrevert();
                }

                uint256 inputTokenBalanceAfter = _getInputTokenBalance(swap.inputToken);
                if (inputTokenBalanceBefore != inputTokenBalanceAfter) {
                    revert("BundleSwapFeature::bundleSwap/INPUT_TOKEN_LEAK");
                }

                if (errorBehaviour == ErrorBehaviour.STOP) {
                    break;
                }
            }
        }

        if (valueUsed < msg.value) {
            // Transfer not used ETH back.
            (bool success, bytes memory revertData) = msg.sender.call{value: msg.value - valueUsed}("");
            if (!success) {
                revertData.rrevert();
            }
        }
    }

    /// @dev Returns either ETH balance of this if input token is ETH because ETH is sent with the tx or the token
    ///      balance of msg.sender.
    function _getInputTokenBalance(IERC20Token token) private view returns (uint256) {
        if (address(token) == ETH_TOKEN_ADDRESS) {
            return address(this).balance;
        } else {
            return token.balanceOf(msg.sender);
        }
    }
}
