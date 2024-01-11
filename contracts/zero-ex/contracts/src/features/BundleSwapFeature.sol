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
import "@0x/contracts-utils/contracts/src/v06/LibSafeMathV06.sol";
import "@0x/contracts-utils/contracts/src/v06/errors/LibRichErrorsV06.sol";
import "@0x/contracts-utils/contracts/src/v06/LibBytesV06.sol";
import "../fixins/FixinCommon.sol";
import "../migrations/LibMigrate.sol";
import "../transformers/LibERC20Transformer.sol";
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
    using LibSafeMathV06 for uint256;
    using LibBytesV06 for bytes;
    using LibRichErrorsV06 for bytes;

    /// @dev Name of this feature.
    string public constant override FEATURE_NAME = "BundleSwap";
    /// @dev Version of this feature.
    uint256 public immutable override FEATURE_VERSION = _encodeVersion(1, 0, 0);

    constructor() public FixinCommon() {}

    /// @dev Initialize and register this feature.
    ///      Should be delegatecalled by `Migrate.migrate()`.
    /// @return success `LibMigrate.SUCCESS` on success.
    function migrate() external returns (bytes4 success) {
        _registerFeatureFunction(this.bundleSwap.selector);
        return LibMigrate.MIGRATE_SUCCESS;
    }

    // TODO (v2): for gas efficiency it could make sense to also create separate bundleSwapJustEthInput and
    //       bundleSwapNoEthInput (this one could use delegatecall) methods

    // TODO (v2): support recipient

    function bundleSwap(
        Swap[] calldata swaps,
        ErrorBehaviour errorBehaviour
    ) public payable override returns (Result[] memory returnResults) {
        uint256 length = swaps.length;
        returnResults = new Result[](length);

        uint256 value = msg.value;

        for (uint256 i = 0; i < length; ++i) {
            Swap calldata swap = swaps[i];
            Result memory result = _swap(swap);
            returnResults[i] = result;

            if (result.success) {
                if (LibERC20Transformer.isTokenETH(swap.inputToken)) {
                    value = value.safeSub(swap.inputTokenAmount);
                }
                if (LibERC20Transformer.isTokenETH(swap.outputToken)) {
                    value = value.safeAdd(result.outputTokenAmount);
                }
            } else {
                // cannot ErrorBehaviour.STOP or CONTINUE - always has to revert to not lose sent ETH
                if (LibERC20Transformer.isTokenETH(swap.inputToken)) {
                    revert("BundleSwapFeature::bundleSwap/SELL_ETH_REVERTED");
                }

                // also revert if first trade
                if (errorBehaviour == ErrorBehaviour.REVERT || length == 0) {
                    result.returnData.rrevert();
                }
                _returnInputTokenOnError(swap);
                if (errorBehaviour == ErrorBehaviour.STOP) {
                    break; // break loop and return senders eth
                }
            }
        }

        if (value < 0) {
            revert("BundleSwapFeature::bundleSwap/ETH_LEAK");
        }
        if (value > 0) {
            // Transfer remaining ETH back.
            (bool success, bytes memory revertData) = msg.sender.call{value: value}("");
            if (!success) {
                revertData.rrevert();
            }
        }
    }

    function _swap(Swap calldata swap) private returns (Result memory result) {
        bool success = _getInputToken(swap);
        if (success) {
            result = _callFeature(swap);
            _returnOutputToken(swap, result.outputTokenAmount);
        }
    }

    function _getInputToken(Swap calldata swap) private returns (bool success) {
        // TODO: think about transfer tax tokens

        if (!LibERC20Transformer.isTokenETH(swap.inputToken)) {
            success = swap.inputToken.transferFrom(
                msg.sender,
                address(this),
                swap.inputTokenAmount
            );
        } else {
            success = true;
        }
    }

    function _callFeature(Swap calldata swap) private returns (Result memory result) {
        uint256 inputTokenBalanceBefore = _getBalance(swap.inputToken);
        uint256 outputTokenBalanceBefore = _getBalance(swap.outputToken);

        if (LibERC20Transformer.isTokenETH(swap.inputToken)) {
            (result.success, result.returnData) = address(this).call{value: swap.inputTokenAmount}(
                swap.data
            );
        } else {
            (result.success, result.returnData) = address(this).call(
                swap.data
            );
        }

        if (result.success) {
            uint256 outputTokenBalanceAfter = _getBalance(swap.outputToken);
            result.outputTokenAmount = outputTokenBalanceAfter.safeSub(outputTokenBalanceBefore);
        } else {
            uint256 inputTokenBalanceAfter = _getBalance(swap.inputToken);
            if (inputTokenBalanceAfter < inputTokenBalanceBefore) {
                revert("BundleSwapFeature::_callFeature/INPUT_TOKEN_LEAK");
            }
            result.outputTokenAmount = 0;
        }
    }

    function _returnOutputToken(Swap calldata swap, uint256 amount) private {
        if (!LibERC20Transformer.isTokenETH(swap.outputToken) && amount > 0) {
            bool success = swap.outputToken.transfer(msg.sender, amount);

            if (!success) {
                // ErrorBehaviour exception - Failed to return token
                revert("BundleSwapFeature::_returnOutputToken/OUTPUT_TOKEN_RETURN_FAILED");
            }
        }
    }

    function _returnInputTokenOnError(Swap calldata swap) private {
        if (!LibERC20Transformer.isTokenETH(swap.inputToken)) {
            swap.inputToken.transfer(
                msg.sender,
                swap.inputTokenAmount
            );
        }
    }

    function _getBalance(IERC20Token token) private view returns (uint256) {
        if (LibERC20Transformer.isTokenETH(token)) {
            return address(this).balance;
        } else {
            return token.balanceOf(address(this));
        }
    }
}
