import {
    blockchainTests,
    constants,
    getRandomInteger,
    toBaseUnitAmount,
    verifyEventsFromLogs
} from "@0x/contracts-test-utils";
import {
    TestUniswapV3FactoryContract,
    TestUniswapV3FactoryPoolCreatedEventArgs
} from "../generated-wrappers/test_uniswap_v3_factory";
import {artifacts} from "../artifacts";
import {UniswapV3FeatureContract} from "../generated-wrappers/uniswap_v3_feature";
import {IOwnableFeatureContract} from "../generated-wrappers/i_ownable_feature";
import {TestWethContract, TestWethEvents} from "../generated-wrappers/test_weth";
import {fullMigrateAsync, IZeroExContract} from "../../src";
import {
    TestMintableERC20TokenContract,
    TestMintableERC20TokenEvents
} from "../generated-wrappers/test_mintable_erc20_token";
import {TestMintTokenERC20TransformerContract} from "../generated-wrappers/test_mint_token_erc20_transformer";
import {abis} from "../utils/abis";
import {BundleSwapFeatureContract} from "../generated-wrappers/bundle_swap_feature";
import {BigNumber, hexUtils} from "@0x/utils";
import {TestUniswapV3PoolContract} from "../generated-wrappers/test_uniswap_v3_pool";
import {LogWithDecodedArgs} from "ethereum-types";

interface TransferEvent {
    token: string;
    from: string;
    to: string;
    value?: BigNumber;
}

interface Swap {
    inputToken: string;
    outputToken: string;
    inputTokenAmount: BigNumber;
    data: string
}

enum ErrorBehaviour {
    REVERT,
    STOP,
    CONTINUE
}

blockchainTests.resets('BundleSwapFeature', env => {
    const POOL_FEE = 1234;

    let zeroEx: IZeroExContract;
    let bundleSwap: BundleSwapFeatureContract;
    let flashWalletAddress: string;
    // TODO
    // let sandbox: LiquidityProviderSandboxContract;
    // let liquidityProvider: TestLiquidityProviderContract;
    // let sushiFactory: TestUniswapV2FactoryContract;
    // let uniV2Factory: TestUniswapV2FactoryContract;
    let uniV3Factory: TestUniswapV3FactoryContract;
    let uniV3Feature: UniswapV3FeatureContract;
    let dai: TestMintableERC20TokenContract;
    let shib: TestMintableERC20TokenContract;
    let zrx: TestMintableERC20TokenContract;
    let weth: TestWethContract;
    let owner: string;
    let maker: string;
    let taker: string;
    let transformerNonce: number;

    async function migrateUniswapV3ContractsAsync(): Promise<void> {
        uniV3Factory = await TestUniswapV3FactoryContract.deployFrom0xArtifactAsync(
            artifacts.TestUniswapV3Factory,
            env.provider,
            env.txDefaults,
            artifacts,
        );
        uniV3Feature = await UniswapV3FeatureContract.deployFrom0xArtifactAsync(
            artifacts.TestUniswapV3Feature,
            env.provider,
            env.txDefaults,
            artifacts,
            weth.address,
            uniV3Factory.address,
            await uniV3Factory.POOL_INIT_CODE_HASH().callAsync(),
        );
        await new IOwnableFeatureContract(zeroEx.address, env.provider, env.txDefaults)
            .migrate(uniV3Feature.address, uniV3Feature.migrate().getABIEncodedTransactionData(), owner)
            .awaitTransactionSuccessAsync();
    }

    function isWethContract(t: TestMintableERC20TokenContract | TestWethContract): t is TestWethContract {
        return !!(t as any).deposit;
    }

    async function mintToAsync(
        token: TestMintableERC20TokenContract | TestWethContract,
        recipient: string,
        amount: BigNumber,
    ): Promise<void> {
        if (isWethContract(token)) {
            await token.depositTo(recipient).awaitTransactionSuccessAsync({ value: amount });
        } else {
            await token.mint(recipient, amount).awaitTransactionSuccessAsync();
        }
    }

    async function createUniswapV3PoolAsync(
        token0: TestMintableERC20TokenContract | TestWethContract,
        token1: TestMintableERC20TokenContract | TestWethContract,
        balance0: BigNumber = toBaseUnitAmount(10),
        balance1: BigNumber = toBaseUnitAmount(10),
    ): Promise<TestUniswapV3PoolContract> {
        const r = await uniV3Factory
            .createPool(token0.address, token1.address, new BigNumber(POOL_FEE))
            .awaitTransactionSuccessAsync();
        const pool = new TestUniswapV3PoolContract(
            (r.logs[0] as LogWithDecodedArgs<TestUniswapV3FactoryPoolCreatedEventArgs>).args.pool,
            env.provider,
            env.txDefaults,
        );
        await mintToAsync(token0, pool.address, balance0);
        await mintToAsync(token1, pool.address, balance1);
        return pool;
    }

    function getUniswapV3MultiHopEncodedPath(
        tokens_: Array<TestMintableERC20TokenContract | TestWethContract>,
    ): string {
        const elems: string[] = [];
        tokens_.forEach((t, i) => {
            if (i) {
                elems.push(hexUtils.leftPad(POOL_FEE, 3));
            }
            elems.push(hexUtils.leftPad(t.address, 20));
        });
        return hexUtils.concat(...elems);
    }

    function getUniswapV3Swap(
        tokens: Array<TestMintableERC20TokenContract | TestWethContract>,
        sellEth = false,
        receiveEth = false,
        sellAmount: BigNumber = getRandomInteger(1, toBaseUnitAmount(1)),
    ): Swap {
        const encodedPath = getUniswapV3MultiHopEncodedPath(tokens);

        let inputToken = tokens[0].address;
        let calldata;
        if (sellEth) {
            inputToken = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
            calldata = uniV3Feature.sellEthForTokenToUniswapV3(
                encodedPath,
                constants.ZERO_AMOUNT, // TODO
                constants.NULL_ADDRESS
            ).getABIEncodedTransactionData();
        } else if (receiveEth) {
            calldata = uniV3Feature.sellTokenForEthToUniswapV3(
                encodedPath,
                sellAmount,
                constants.ZERO_AMOUNT, // TODO
                constants.NULL_ADDRESS
            ).getABIEncodedTransactionData();
        } else {
            calldata = uniV3Feature.sellTokenForTokenToUniswapV3(
                encodedPath,
                sellAmount,
                constants.ZERO_AMOUNT, // TODO
                constants.NULL_ADDRESS
            ).getABIEncodedTransactionData();
        }

        return {
            inputToken,
            outputToken: tokens[tokens.length - 1].address,
            inputTokenAmount: sellAmount,
            data: calldata
        }
    }

    before(async () => {
        [owner, maker, taker] = await env.getAccountAddressesAsync();
        zeroEx = await fullMigrateAsync(owner, env.provider, env.txDefaults, {});
        flashWalletAddress = await zeroEx.getTransformWallet().callAsync();

        [dai, shib, zrx] = await Promise.all(
            [...new Array(3)].map(async () =>
                TestMintableERC20TokenContract.deployFrom0xArtifactAsync(
                    artifacts.TestMintableERC20Token,
                    env.provider,
                    env.txDefaults,
                    artifacts,
                ),
            ),
        );
        weth = await TestWethContract.deployFrom0xArtifactAsync(
            artifacts.TestWeth,
            env.provider,
            env.txDefaults,
            artifacts,
        );

        await Promise.all([
            ...[dai, shib, zrx, weth].map(t =>
                t.approve(zeroEx.address, constants.MAX_UINT256).awaitTransactionSuccessAsync({ from: taker }),
            ),
            ...[dai, shib, zrx, weth].map(t =>
                t.approve(zeroEx.address, constants.MAX_UINT256).awaitTransactionSuccessAsync({ from: maker }),
            ),
        ]);
        // TODO
        // await migrateOtcOrdersFeatureAsync();
        // await migrateLiquidityProviderContractsAsync();
        // await migrateUniswapV2ContractsAsync();
        await migrateUniswapV3ContractsAsync();
        transformerNonce = await env.web3Wrapper.getAccountNonceAsync(owner);
        await TestMintTokenERC20TransformerContract.deployFrom0xArtifactAsync(
            artifacts.TestMintTokenERC20Transformer,
            env.provider,
            env.txDefaults,
            artifacts,
        );

        const featureImpl = await BundleSwapFeatureContract.deployFrom0xArtifactAsync(
            artifacts.BundleSwapFeature,
            env.provider,
            env.txDefaults,
            artifacts,
        );

        await new IOwnableFeatureContract(zeroEx.address, env.provider, env.txDefaults)
            .migrate(featureImpl.address, featureImpl.migrate().getABIEncodedTransactionData(), owner)
            .awaitTransactionSuccessAsync();
        bundleSwap = new BundleSwapFeatureContract(zeroEx.address, env.provider, env.txDefaults, abis);
    });

    describe('single swap', () => {
        describe('swap token for token', () => {
            it('UniV3', async () => {
                const uniV3 = await createUniswapV3PoolAsync(dai, shib);
                const uniV3Swap = getUniswapV3Swap([dai, shib]);

                await mintToAsync(dai, taker, uniV3Swap.inputTokenAmount);

                const tx = await bundleSwap.bundleSwap([
                    uniV3Swap
                ], ErrorBehaviour.REVERT).awaitTransactionSuccessAsync({from: taker});

                verifyEventsFromLogs<TransferEvent>(
                    tx.logs,
                    [
                        {
                            token: shib.address,
                            from: uniV3.address,
                            to: taker,
                        },
                        {
                            token: dai.address,
                            from: taker,
                            to: uniV3.address,
                            value: uniV3Swap.inputTokenAmount,
                        },
                    ],
                    TestMintableERC20TokenEvents.Transfer,
                );
            });
        });

        describe('swap eth for token', () => {
            it('UniV3', async () => {
                const uniV3 = await createUniswapV3PoolAsync(weth, zrx);
                const uniV3Swap = getUniswapV3Swap([weth, zrx], true);

                const tx = await bundleSwap.bundleSwap([
                    uniV3Swap
                ], ErrorBehaviour.REVERT).awaitTransactionSuccessAsync({from: taker, value: uniV3Swap.inputTokenAmount});

                verifyEventsFromLogs(
                    tx.logs,
                    [{ owner: zeroEx.address, value: uniV3Swap.inputTokenAmount }],
                    TestWethEvents.Deposit,
                );
                verifyEventsFromLogs<TransferEvent>(
                    tx.logs,
                    [
                        {
                            token: zrx.address,
                            from: uniV3.address,
                            to: zeroEx.address,
                        },
                        {
                            token: weth.address,
                            from: zeroEx.address,
                            to: uniV3.address,
                            value: uniV3Swap.inputTokenAmount,
                        },
                        {
                            token: zrx.address,
                            from: zeroEx.address,
                            to: taker,
                        },
                    ],
                    TestMintableERC20TokenEvents.Transfer,
                );
            });
        });

        describe('swap token for eth', () => {
            it('UniV3', async () => {
                const uniV3 = await createUniswapV3PoolAsync(zrx, weth);
                const uniV3Swap = getUniswapV3Swap([zrx, weth], false, true);

                await mintToAsync(zrx, taker, uniV3Swap.inputTokenAmount);

                const tx = await bundleSwap.bundleSwap([
                    uniV3Swap
                ], ErrorBehaviour.REVERT).awaitTransactionSuccessAsync({from: taker});

                verifyEventsFromLogs(
                    tx.logs,
                    [{ owner: zeroEx.address }],
                    TestWethEvents.Withdrawal,
                );
                verifyEventsFromLogs<TransferEvent>(
                    tx.logs,
                    [
                        {
                            token: weth.address,
                            from: uniV3.address,
                            to: zeroEx.address,
                        },
                        {
                            token: zrx.address,
                            from: taker,
                            to: uniV3.address,
                            value: uniV3Swap.inputTokenAmount,
                        },
                    ],
                    TestMintableERC20TokenEvents.Transfer,
                );
            });
        });
    });

    describe('bundle swap', () => {
        describe('swap tokens for tokens', () => {
            it('UniV3', async () => {
                const uniV3DaiShib = await createUniswapV3PoolAsync(dai, shib);
                const uniV3DaiZrx = await createUniswapV3PoolAsync(dai, zrx);
                const uniV3ShibZrx = await createUniswapV3PoolAsync(shib, zrx);

                const uniV3SwapDaiShib = getUniswapV3Swap([dai, shib]);
                const uniV3SwapDaiZrx = getUniswapV3Swap([dai, zrx]);
                const uniV3SwapShibZrx = getUniswapV3Swap([shib, zrx]);

                await mintToAsync(dai, taker, BigNumber.sum(uniV3SwapDaiShib.inputTokenAmount, uniV3SwapDaiZrx.inputTokenAmount));
                await mintToAsync(shib, taker, uniV3SwapShibZrx.inputTokenAmount);

                const tx = await bundleSwap.bundleSwap([
                    uniV3SwapDaiShib,
                    uniV3SwapDaiZrx,
                    uniV3SwapShibZrx
                ], ErrorBehaviour.REVERT).awaitTransactionSuccessAsync({from: taker});

                verifyEventsFromLogs<TransferEvent>(
                    tx.logs,
                    [
                        {
                            token: shib.address,
                            from: uniV3DaiShib.address,
                            to: taker,
                        },
                        {
                            token: dai.address,
                            from: taker,
                            to: uniV3DaiShib.address,
                            value: uniV3SwapDaiShib.inputTokenAmount,
                        },
                        {
                            token: zrx.address,
                            from: uniV3DaiZrx.address,
                            to: taker,
                        },
                        {
                            token: dai.address,
                            from: taker,
                            to: uniV3DaiZrx.address,
                            value: uniV3SwapDaiZrx.inputTokenAmount,
                        },
                        {
                            token: zrx.address,
                            from: uniV3ShibZrx.address,
                            to: taker,
                        },
                        {
                            token: shib.address,
                            from: taker,
                            to: uniV3ShibZrx.address,
                            value: uniV3SwapShibZrx.inputTokenAmount,
                        },
                    ],
                    TestMintableERC20TokenEvents.Transfer,
                );
            });
        });

        describe('swap eth for tokens', () => {
            it('UniV3', async () => {
                const uniV3WethDai = await createUniswapV3PoolAsync(weth, dai);
                const uniV3WethZrx = await createUniswapV3PoolAsync(weth, zrx);
                const uniV3WethShib = await createUniswapV3PoolAsync(weth, shib);

                const uniV3SwapWethDai = getUniswapV3Swap([weth, dai], true);
                const uniV3SwapWethZrx = getUniswapV3Swap([weth, zrx], true);
                const uniV3SwapWethShib = getUniswapV3Swap([weth, shib], true);

                await mintToAsync(dai, taker, uniV3SwapWethDai.inputTokenAmount);
                await mintToAsync(zrx, taker, uniV3SwapWethZrx.inputTokenAmount);
                await mintToAsync(shib, taker, uniV3SwapWethShib.inputTokenAmount);

                const value = BigNumber.sum(
                    uniV3SwapWethDai.inputTokenAmount,
                    uniV3SwapWethZrx.inputTokenAmount,
                    uniV3SwapWethShib.inputTokenAmount,
                );

                const tx = await bundleSwap.bundleSwap([
                    uniV3SwapWethDai,
                    uniV3SwapWethZrx,
                    uniV3SwapWethShib
                ], ErrorBehaviour.REVERT).awaitTransactionSuccessAsync({
                    from: taker,
                    value
                });

                verifyEventsFromLogs(
                    tx.logs,
                    [{ owner: zeroEx.address }, { owner: zeroEx.address }, { owner: zeroEx.address }],
                    TestWethEvents.Deposit,
                );
                verifyEventsFromLogs<TransferEvent>(
                    tx.logs,
                    [
                        {
                            token: dai.address,
                            from: uniV3WethDai.address,
                            to: zeroEx.address,
                        },
                        {
                            token: weth.address,
                            from: zeroEx.address,
                            to: uniV3WethDai.address,
                            value: uniV3SwapWethDai.inputTokenAmount,
                        },
                        {
                            token: dai.address,
                            from: zeroEx.address,
                            to: taker,
                        },
                        {
                            token: zrx.address,
                            from: uniV3WethZrx.address,
                            to: zeroEx.address,
                        },
                        {
                            token: weth.address,
                            from: zeroEx.address,
                            to: uniV3WethZrx.address,
                            value: uniV3SwapWethZrx.inputTokenAmount,
                        },
                        {
                            token: zrx.address,
                            from: zeroEx.address,
                            to: taker,
                        },
                        {
                            token: shib.address,
                            from: uniV3WethShib.address,
                            to: zeroEx.address,
                        },
                        {
                            token: weth.address,
                            from: zeroEx.address,
                            to: uniV3WethShib.address,
                            value: uniV3SwapWethShib.inputTokenAmount,
                        },
                        {
                            token: shib.address,
                            from: zeroEx.address,
                            to: taker,
                        },
                    ],
                    TestMintableERC20TokenEvents.Transfer,
                );
            });
        });

        describe('swap tokens for eth', () => {
            it('UniV3', async () => {
                const uniV3DaiWeth = await createUniswapV3PoolAsync(dai, weth);
                const uniV3ZrxWeth = await createUniswapV3PoolAsync(zrx, weth);
                const uniV3ShibWeth = await createUniswapV3PoolAsync(shib, weth);

                const uniV3SwapDaiWeth = getUniswapV3Swap([dai, weth], false, true);
                const uniV3SwapZrxWeth = getUniswapV3Swap([zrx, weth], false, true);
                const uniV3SwapShibWeth = getUniswapV3Swap([shib, weth], false, true);

                await mintToAsync(dai, taker, uniV3SwapDaiWeth.inputTokenAmount);
                await mintToAsync(zrx, taker, uniV3SwapZrxWeth.inputTokenAmount);
                await mintToAsync(shib, taker, uniV3SwapShibWeth.inputTokenAmount);

                const tx = await bundleSwap.bundleSwap([
                    uniV3SwapDaiWeth,
                    uniV3SwapZrxWeth,
                    uniV3SwapShibWeth
                ], ErrorBehaviour.REVERT).awaitTransactionSuccessAsync({from: taker});

                verifyEventsFromLogs(
                    tx.logs,
                    [{ owner: zeroEx.address }, { owner: zeroEx.address }, { owner: zeroEx.address }],
                    TestWethEvents.Withdrawal,
                );
                verifyEventsFromLogs<TransferEvent>(
                    tx.logs,
                    [
                        {
                            token: weth.address,
                            from: uniV3DaiWeth.address,
                            to: zeroEx.address,
                        },
                        {
                            token: dai.address,
                            from: taker,
                            to: uniV3DaiWeth.address,
                            value: uniV3SwapDaiWeth.inputTokenAmount,
                        },
                        {
                            token: weth.address,
                            from: uniV3ZrxWeth.address,
                            to: zeroEx.address,
                        },
                        {
                            token: zrx.address,
                            from: taker,
                            to: uniV3ZrxWeth.address,
                            value: uniV3SwapZrxWeth.inputTokenAmount,
                        },
                        {
                            token: weth.address,
                            from: uniV3ShibWeth.address,
                            to: zeroEx.address,
                        },
                        {
                            token: shib.address,
                            from: taker,
                            to: uniV3ShibWeth.address,
                            value: uniV3SwapShibWeth.inputTokenAmount,
                        },
                    ],
                    TestMintableERC20TokenEvents.Transfer,
                );
            });
        });
    });

    describe('error behaviour', () => {
        // TODO: test for error behaviour
    });

    describe('revert cases', () => {
        // TODO: test ETH leak
        // TODO: test returning of outputToken error
        // TODO: input token leak
        // TODO: test for not all msg.value used
    });
});
