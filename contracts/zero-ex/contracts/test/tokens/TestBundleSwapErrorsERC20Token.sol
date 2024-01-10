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

import "./TestMintableERC20Token.sol";

contract TestBundleSwapErrorsERC20Token is TestMintableERC20Token {
    event TransferCalled(address sender, address to, uint256 amount);

    // the x. transfer will return false. x = amount - 3130
    uint256 private constant FALSE_RETURN_ON_X_TRANSFER = 3130;

    uint256 private transferCount = 0;

    function transfer(address to, uint256 amount) public override returns (bool) {
        emit TransferCalled(msg.sender, to, amount);
        transferCount++;

        if (amount - FALSE_RETURN_ON_X_TRANSFER == transferCount) {
            return false;
        }

        return transferFrom(msg.sender, to, amount);
    }
}
