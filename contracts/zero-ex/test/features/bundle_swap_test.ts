import {
    blockchainTests,
    constants, expect,
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
import {BigNumber, hexUtils, NULL_ADDRESS} from "@0x/utils";
import {TestUniswapV3PoolContract} from "../generated-wrappers/test_uniswap_v3_pool";
import {LogEntry, LogWithDecodedArgs} from "ethereum-types";
import {TestBundleSwapErrorsERC20TokenContract} from "../generated-wrappers/test_bundle_swap_errors_erc20_token";
import {LiquidityProviderSandboxContract} from "../generated-wrappers/liquidity_provider_sandbox";
import {
    TestLiquidityProviderContract,
    TestLiquidityProviderEvents
} from "../generated-wrappers/test_liquidity_provider";
import {LiquidityProviderFeatureContract} from "../../generated-wrappers/liquidity_provider_feature";
import {OtcOrdersFeatureContract} from "../generated-wrappers/otc_orders_feature";
import {OtcOrder} from "@0x/protocol-utils";
import {computeOtcOrderFilledAmounts, getRandomOtcOrder} from "../utils/orders";

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

interface VerifyConfig {
    swap: Swap;
    outputFirst?: boolean // e.g. UniV3 first returns output token then receives input token (order of Transfer events)
    deposit?: boolean; // deposit ETH to WETH
    withdraw?: boolean; // withdraw ETH from WETH
    source?: {address: string};
    fail?: boolean;
}

const ETH_TOKEN_ADDRESS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

blockchainTests.resets('BundleSwapFeature', env => {
    const POOL_FEE = 1234;

    let zeroEx: IZeroExContract;
    let bundleSwap: BundleSwapFeatureContract;
    let flashWalletAddress: string;
    let uniV3Factory: TestUniswapV3FactoryContract;
    let uniV3Feature: UniswapV3FeatureContract;
    // let sandbox: LiquidityProviderSandboxContract;
    let liquidityProviderFeature: LiquidityProviderFeatureContract;
    let liquidityProvider: TestLiquidityProviderContract;
    let otcOrdersFeature: OtcOrdersFeatureContract;
    // let sushiFactory: TestUniswapV2FactoryContract;
    // let uniV2Factory: TestUniswapV2FactoryContract;
    let dai: TestMintableERC20TokenContract;
    let shib: TestMintableERC20TokenContract;
    let zrx: TestMintableERC20TokenContract;
    let transferErrorToken: TestBundleSwapErrorsERC20TokenContract;
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

    async function migrateLiquidityProviderContractsAsync(): Promise<void> {
        const sandbox = await LiquidityProviderSandboxContract.deployFrom0xArtifactAsync(
            artifacts.LiquidityProviderSandbox,
            env.provider,
            env.txDefaults,
            artifacts,
            zeroEx.address,
        );
        liquidityProviderFeature = await LiquidityProviderFeatureContract.deployFrom0xArtifactAsync(
            artifacts.LiquidityProviderFeature,
            env.provider,
            env.txDefaults,
            artifacts,
            sandbox.address,
        );
        await new IOwnableFeatureContract(zeroEx.address, env.provider, env.txDefaults, abis)
            .migrate(liquidityProviderFeature.address, liquidityProviderFeature.migrate().getABIEncodedTransactionData(), owner)
            .awaitTransactionSuccessAsync();

        liquidityProvider = await TestLiquidityProviderContract.deployFrom0xArtifactAsync(
            artifacts.TestLiquidityProvider,
            env.provider,
            env.txDefaults,
            artifacts,
        );
    }

    async function migrateOtcOrdersFeatureAsync(): Promise<void> {
        otcOrdersFeature = await OtcOrdersFeatureContract.deployFrom0xArtifactAsync(
            artifacts.OtcOrdersFeature,
            env.provider,
            env.txDefaults,
            artifacts,
            zeroEx.address,
            weth.address,
        );
        await new IOwnableFeatureContract(zeroEx.address, env.provider, env.txDefaults)
            .migrate(otcOrdersFeature.address, otcOrdersFeature.migrate().getABIEncodedTransactionData(), owner)
            .awaitTransactionSuccessAsync();
    }

    function isWethContract(t: TestMintableERC20TokenContract | TestWethContract | TestBundleSwapErrorsERC20TokenContract): t is TestWethContract {
        return !!(t as any).deposit;
    }

    async function mintToAsync(
        token: TestMintableERC20TokenContract | TestWethContract | TestBundleSwapErrorsERC20TokenContract,
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
        token0: TestMintableERC20TokenContract | TestWethContract | TestBundleSwapErrorsERC20TokenContract,
        token1: TestMintableERC20TokenContract | TestWethContract | TestBundleSwapErrorsERC20TokenContract,
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
        tokens_: Array<TestMintableERC20TokenContract | TestWethContract | TestBundleSwapErrorsERC20TokenContract>,
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
        tokens: Array<TestMintableERC20TokenContract | TestWethContract | TestBundleSwapErrorsERC20TokenContract>,
        sellEth = false,
        receiveEth = false,
        sellAmount: BigNumber = getRandomInteger(1, toBaseUnitAmount(1)),
        minBuyAmount: BigNumber = constants.ZERO_AMOUNT
    ): Swap {
        const encodedPath = getUniswapV3MultiHopEncodedPath(tokens);

        let inputToken = tokens[0].address;
        let outputToken = tokens[tokens.length - 1].address;
        let calldata;
        if (sellEth) {
            inputToken = ETH_TOKEN_ADDRESS;
            calldata = uniV3Feature.sellEthForTokenToUniswapV3(
                encodedPath,
                minBuyAmount,
                constants.NULL_ADDRESS
            ).getABIEncodedTransactionData();
        } else if (receiveEth) {
            outputToken = ETH_TOKEN_ADDRESS;
            calldata = uniV3Feature.sellTokenForEthToUniswapV3(
                encodedPath,
                sellAmount,
                minBuyAmount,
                constants.NULL_ADDRESS
            ).getABIEncodedTransactionData();
        } else {
            calldata = uniV3Feature.sellTokenForTokenToUniswapV3(
                encodedPath,
                sellAmount,
                minBuyAmount,
                constants.NULL_ADDRESS
            ).getABIEncodedTransactionData();
        }

        return {
            inputToken,
            outputToken,
            inputTokenAmount: sellAmount,
            data: calldata
        }
    }

    async function fundLiquidityProvider(
        token: 'ETH' | TestMintableERC20TokenContract | TestWethContract | TestBundleSwapErrorsERC20TokenContract,
        balance: BigNumber = getRandomInteger(1, toBaseUnitAmount(1)),
    ): Promise<void> {
        if (token === 'ETH') {
            await env.web3Wrapper.sendTransactionAsync({from: owner, value: balance});
        } else {
            await mintToAsync(token, liquidityProvider.address, balance);
        }
    }

    function getLiquidityProviderSwap(
        inputToken: 'ETH' | TestMintableERC20TokenContract | TestWethContract | TestBundleSwapErrorsERC20TokenContract,
        outputToken: 'ETH' | TestMintableERC20TokenContract | TestWethContract | TestBundleSwapErrorsERC20TokenContract,
        sellAmount: BigNumber = getRandomInteger(1, toBaseUnitAmount(1)),
        minBuyAmount: BigNumber = constants.ZERO_AMOUNT
    ): Swap {
        const calldata = liquidityProviderFeature.sellToLiquidityProvider(
            inputToken === 'ETH' ? ETH_TOKEN_ADDRESS : inputToken.address,
            outputToken === 'ETH' ? ETH_TOKEN_ADDRESS : outputToken.address,
            liquidityProvider.address,
            constants.NULL_ADDRESS,
            sellAmount,
            minBuyAmount,
            constants.NULL_BYTES
        ).getABIEncodedTransactionData();

        return {
            inputToken: inputToken === 'ETH' ? ETH_TOKEN_ADDRESS : inputToken.address,
            outputToken: outputToken === 'ETH' ? ETH_TOKEN_ADDRESS : outputToken.address,
            inputTokenAmount: sellAmount,
            data: calldata
        };
    }

    async function getOtcOrderSwap(
        takerToken: 'ETH' | TestMintableERC20TokenContract | TestWethContract | TestBundleSwapErrorsERC20TokenContract,
        makerToken: 'ETH' | TestMintableERC20TokenContract | TestWethContract | TestBundleSwapErrorsERC20TokenContract,
        takerTokenAmount: BigNumber = getRandomInteger(1, toBaseUnitAmount(1)),
        makerTokenAmount: BigNumber = getRandomInteger(1, toBaseUnitAmount(1)),
    ): Promise<[OtcOrder, Swap]> {
        const order = getRandomOtcOrder({
            maker,
            verifyingContract: zeroEx.address,
            chainId: 1337,
            takerToken: takerToken === 'ETH' ? ETH_TOKEN_ADDRESS : takerToken.address,
            makerToken: makerToken === 'ETH' ? weth.address : makerToken.address,
            takerAmount: takerTokenAmount,
            makerAmount: makerTokenAmount,
            taker: constants.NULL_ADDRESS,
            txOrigin: taker,
        });

        let calldata;
        if (takerToken === 'ETH') {
            calldata = otcOrdersFeature.fillOtcOrderWithEth(
                order,
                await order.getSignatureWithProviderAsync(env.provider),
            ).getABIEncodedTransactionData();
        } else if (makerToken === 'ETH') {
            calldata = otcOrdersFeature.fillOtcOrderForEth(
                order,
                await order.getSignatureWithProviderAsync(env.provider),
                takerTokenAmount
            ).getABIEncodedTransactionData();
        } else {
            calldata = otcOrdersFeature.fillOtcOrder(
                order,
                await order.getSignatureWithProviderAsync(env.provider),
                takerTokenAmount
            ).getABIEncodedTransactionData();
        }

        return [order, {
            inputToken: takerToken === 'ETH' ? ETH_TOKEN_ADDRESS : takerToken.address,
            outputToken: makerToken === 'ETH' ? ETH_TOKEN_ADDRESS : makerToken.address,
            inputTokenAmount: order.takerAmount,
            data: calldata
        }];
    }

    function verifyBundleSwapEventsFromLogs(
        verifyConfigs: VerifyConfig[],
        logs: LogEntry[]
    ): void {
        const expectedDepositEvents: {owner: string}[] = [];
        const expectedWithdrawEvents: {owner: string}[] = [];
        const expectedTransferEvents: TransferEvent[] = [];

        verifyConfigs.forEach(config => {
            let inputToken = config.swap.inputToken;
            if (config.deposit) {
                inputToken = weth.address;
                expectedDepositEvents.push({ owner: zeroEx.address });
            }

            if (config.swap.inputToken !== ETH_TOKEN_ADDRESS) {
                expectedTransferEvents.push({
                    token: inputToken,
                    from: taker,
                    to: zeroEx.address,
                    value: config.swap.inputTokenAmount,
                });
            }

            if (!config.fail) {
                let outputToken = config.swap.outputToken;
                if (config.withdraw) {
                    outputToken = weth.address;
                    expectedWithdrawEvents.push({ owner: zeroEx.address });
                }

                if (!config.outputFirst) {
                    if (inputToken !== ETH_TOKEN_ADDRESS) {
                        expectedTransferEvents.push(
                            {
                                token: inputToken,
                                from: zeroEx.address,
                                to: config.source!.address,
                                value: config.swap.inputTokenAmount,
                            },
                        );
                    }
                    if (outputToken !== ETH_TOKEN_ADDRESS) {
                        expectedTransferEvents.push(
                            {
                                token: outputToken,
                                from: config.source!.address,
                                to: zeroEx.address,
                            },
                        );
                    }
                } else {
                    if (outputToken !== ETH_TOKEN_ADDRESS) {
                        expectedTransferEvents.push(
                            {
                                token: outputToken,
                                from: config.source!.address,
                                to: zeroEx.address,
                            },
                        );
                    }
                    if (inputToken !== ETH_TOKEN_ADDRESS) {
                        expectedTransferEvents.push(
                            {
                                token: inputToken,
                                from: zeroEx.address,
                                to: config.source!.address,
                                value: config.swap.inputTokenAmount,
                            },
                        );
                    }
                }

                if (config.swap.outputToken !== ETH_TOKEN_ADDRESS) {
                    expectedTransferEvents.push({
                        token: outputToken,
                        from: zeroEx.address,
                        to: taker,
                    });
                }
            } else {
                expectedTransferEvents.push({
                    token: inputToken,
                    from: zeroEx.address,
                    to: taker,
                    value: config.swap.inputTokenAmount,
                });
            }
        });

        verifyEventsFromLogs(
            logs,
            expectedDepositEvents,
            TestWethEvents.Deposit,
        );
        verifyEventsFromLogs(
            logs,
            expectedWithdrawEvents,
            TestWethEvents.Withdrawal,
        );
        verifyEventsFromLogs<TransferEvent>(
            logs,
            expectedTransferEvents,
            TestMintableERC20TokenEvents.Transfer,
        );
    }

    async function assertExpectedFinalBalancesFromOtcOrderFillAsync(
        order: OtcOrder,
        takerTokenFillAmount: BigNumber = order.takerAmount,
    ): Promise<void> {
        const { makerTokenFilledAmount, takerTokenFilledAmount } = computeOtcOrderFilledAmounts(
            order,
            takerTokenFillAmount,
        );

        if (order.takerToken !== ETH_TOKEN_ADDRESS) {
            const makerBalance = await new TestMintableERC20TokenContract(order.takerToken, env.provider)
                .balanceOf(order.maker)
                .callAsync();
            expect(makerBalance, 'maker balance').to.bignumber.eq(takerTokenFilledAmount);
        }

        if (order.makerToken !== ETH_TOKEN_ADDRESS) {
            const takerBalance = await new TestMintableERC20TokenContract(order.makerToken, env.provider)
                .balanceOf(order.taker !== NULL_ADDRESS ? order.taker : taker)
                .callAsync();
            expect(takerBalance, 'taker balance').to.bignumber.eq(makerTokenFilledAmount);
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
        transferErrorToken = await TestBundleSwapErrorsERC20TokenContract.deployFrom0xArtifactAsync(
            artifacts.TestBundleSwapErrorsERC20Token,
            env.provider,
            env.txDefaults,
            artifacts
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
        await migrateUniswapV3ContractsAsync();
        await migrateLiquidityProviderContractsAsync();
        await migrateOtcOrdersFeatureAsync();
        // await migrateUniswapV2ContractsAsync();
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

                verifyBundleSwapEventsFromLogs([
                    { swap: uniV3Swap, outputFirst: true, source: uniV3 },
                ], tx.logs);
            });

            it('LiquidityProvider', async () => {
                await fundLiquidityProvider(zrx);
                const liquidityProviderSwap = getLiquidityProviderSwap(dai, zrx);
                await mintToAsync(dai, taker, liquidityProviderSwap.inputTokenAmount);

                const tx = await bundleSwap.bundleSwap([
                    liquidityProviderSwap
                ], ErrorBehaviour.REVERT).awaitTransactionSuccessAsync({from: taker});

                verifyEventsFromLogs(
                    tx.logs,
                    [
                        {
                            inputToken: dai.address,
                            outputToken: zrx.address,
                            recipient: zeroEx.address,
                            minBuyAmount: constants.ZERO_AMOUNT,
                            inputTokenBalance: liquidityProviderSwap.inputTokenAmount,
                        },
                    ],
                    TestLiquidityProviderEvents.SellTokenForToken,
                );

                verifyBundleSwapEventsFromLogs([
                    { swap: liquidityProviderSwap, source: liquidityProvider },
                ], tx.logs);
            });

            it('OtcOrder', async () => {
                const [order, otcOrderSwap] = await getOtcOrderSwap(dai, shib);

                await mintToAsync(dai, taker, otcOrderSwap.inputTokenAmount);
                await mintToAsync(shib, maker, order.makerAmount);

                const tx = await bundleSwap.bundleSwap([
                    otcOrderSwap
                ], ErrorBehaviour.REVERT).awaitTransactionSuccessAsync({from: taker});

                await assertExpectedFinalBalancesFromOtcOrderFillAsync(order);

                verifyBundleSwapEventsFromLogs([
                    { swap: otcOrderSwap, source: {address: maker} },
                ], tx.logs);
            });
        });

        describe('swap eth for token', () => {
            it('UniV3', async () => {
                const uniV3 = await createUniswapV3PoolAsync(weth, zrx);
                const uniV3Swap = getUniswapV3Swap([weth, zrx], true);

                const tx = await bundleSwap.bundleSwap([
                    uniV3Swap
                ], ErrorBehaviour.REVERT).awaitTransactionSuccessAsync({from: taker, value: uniV3Swap.inputTokenAmount});

                verifyBundleSwapEventsFromLogs([
                    { swap: uniV3Swap, outputFirst: true, deposit: true, source: uniV3 },
                ], tx.logs);
            });

            it('LiquidityProvider', async () => {
                await fundLiquidityProvider(zrx);
                const liquidityProviderSwap = getLiquidityProviderSwap('ETH', zrx);

                const tx = await bundleSwap.bundleSwap([
                    liquidityProviderSwap
                ], ErrorBehaviour.REVERT).awaitTransactionSuccessAsync({from: taker, value: liquidityProviderSwap.inputTokenAmount});

                verifyEventsFromLogs(
                    tx.logs,
                    [
                        {
                            outputToken: zrx.address,
                            recipient: zeroEx.address,
                            minBuyAmount: constants.ZERO_AMOUNT,
                            ethBalance: liquidityProviderSwap.inputTokenAmount,
                        },
                    ],
                    TestLiquidityProviderEvents.SellEthForToken,
                );

                verifyBundleSwapEventsFromLogs([
                    { swap: liquidityProviderSwap, source: liquidityProvider },
                ], tx.logs);
            });

            it('OtcOrder', async () => {
                const [order, otcOrderSwap] = await getOtcOrderSwap('ETH', shib);

                await mintToAsync(shib, maker, order.makerAmount);

                const tx = await bundleSwap.bundleSwap([
                    otcOrderSwap
                ], ErrorBehaviour.REVERT).awaitTransactionSuccessAsync({from: taker, value: otcOrderSwap.inputTokenAmount});

                await assertExpectedFinalBalancesFromOtcOrderFillAsync(order);

                verifyBundleSwapEventsFromLogs([
                    { swap: otcOrderSwap, source: {address: maker} },
                ], tx.logs);
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

                verifyBundleSwapEventsFromLogs([
                    { swap: uniV3Swap, outputFirst: true, withdraw: true, source: uniV3},
                ], tx.logs);
            });

            it('LiquidityProvider', async () => {
                await fundLiquidityProvider('ETH');
                const liquidityProviderSwap = getLiquidityProviderSwap(dai, 'ETH');
                await mintToAsync(dai, taker, liquidityProviderSwap.inputTokenAmount);

                const tx = await bundleSwap.bundleSwap([
                    liquidityProviderSwap
                ], ErrorBehaviour.REVERT).awaitTransactionSuccessAsync({from: taker});

                verifyEventsFromLogs(
                    tx.logs,
                    [
                        {
                            inputToken: dai.address,
                            recipient: zeroEx.address,
                            minBuyAmount: constants.ZERO_AMOUNT,
                            inputTokenBalance: liquidityProviderSwap.inputTokenAmount,
                        },
                    ],
                    TestLiquidityProviderEvents.SellTokenForEth,
                );

                verifyBundleSwapEventsFromLogs([
                    { swap: liquidityProviderSwap, source: liquidityProvider },
                ], tx.logs);
            });

            it('OtcOrder', async () => {
                const [order, otcOrderSwap] = await getOtcOrderSwap(dai, 'ETH');

                await mintToAsync(dai, taker, otcOrderSwap.inputTokenAmount);
                await mintToAsync(weth, maker, order.makerAmount);

                const ethBalanceBefore = await env.web3Wrapper.getBalanceInWeiAsync(taker);

                const tx = await bundleSwap.bundleSwap([
                    otcOrderSwap
                ], ErrorBehaviour.REVERT).awaitTransactionSuccessAsync({from: taker});

                const ethBalanceAfter = await env.web3Wrapper.getBalanceInWeiAsync(taker);

                expect(ethBalanceAfter).to.bignumber.eq(ethBalanceBefore.plus(order.makerAmount).minus(tx.gasUsed));

                verifyBundleSwapEventsFromLogs([
                    { swap: otcOrderSwap, withdraw: true, source: {address: maker} },
                ], tx.logs);
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

                verifyBundleSwapEventsFromLogs([
                    { swap: uniV3SwapDaiShib, outputFirst: true, source: uniV3DaiShib },
                    { swap: uniV3SwapDaiZrx, outputFirst: true, source: uniV3DaiZrx },
                    { swap: uniV3SwapShibZrx, outputFirst: true, source: uniV3ShibZrx }
                ], tx.logs);
            });

            it('UniV3, LiquidityProvider', async () => {
                const uniV3DaiShib = await createUniswapV3PoolAsync(dai, shib);
                await fundLiquidityProvider(zrx);
                const uniV3ShibZrx = await createUniswapV3PoolAsync(shib, zrx);

                const uniV3SwapDaiShib = getUniswapV3Swap([dai, shib]);
                const liquidityProviderSwapDaiZrx = getLiquidityProviderSwap(dai, zrx);
                const uniV3SwapShibZrx = getUniswapV3Swap([shib, zrx]);

                await mintToAsync(dai, taker, BigNumber.sum(uniV3SwapDaiShib.inputTokenAmount, liquidityProviderSwapDaiZrx.inputTokenAmount));
                await mintToAsync(shib, taker, uniV3SwapShibZrx.inputTokenAmount);

                const tx = await bundleSwap.bundleSwap([
                    uniV3SwapDaiShib,
                    liquidityProviderSwapDaiZrx,
                    uniV3SwapShibZrx
                ], ErrorBehaviour.REVERT).awaitTransactionSuccessAsync({from: taker});

                verifyBundleSwapEventsFromLogs([
                    { swap: uniV3SwapDaiShib, outputFirst: true, source: uniV3DaiShib },
                    { swap: liquidityProviderSwapDaiZrx, source: liquidityProvider },
                    { swap: uniV3SwapShibZrx, outputFirst: true, source: uniV3ShibZrx }
                ], tx.logs);
            });

            it('UniV3, LiquidityProvider, OtcOrder', async () => {
                const uniV3DaiShib = await createUniswapV3PoolAsync(dai, shib);
                await fundLiquidityProvider(zrx);

                const uniV3SwapDaiShib = getUniswapV3Swap([dai, shib]);
                const liquidityProviderSwapDaiZrx = getLiquidityProviderSwap(dai, zrx);
                const [order, otcOrderSwap] = await getOtcOrderSwap(shib, zrx);

                await mintToAsync(dai, taker, BigNumber.sum(uniV3SwapDaiShib.inputTokenAmount, liquidityProviderSwapDaiZrx.inputTokenAmount));
                await mintToAsync(shib, taker, otcOrderSwap.inputTokenAmount);
                await mintToAsync(zrx, maker, order.makerAmount);

                const tx = await bundleSwap.bundleSwap([
                    uniV3SwapDaiShib,
                    liquidityProviderSwapDaiZrx,
                    otcOrderSwap
                ], ErrorBehaviour.REVERT).awaitTransactionSuccessAsync({from: taker});

                verifyBundleSwapEventsFromLogs([
                    { swap: uniV3SwapDaiShib, outputFirst: true, source: uniV3DaiShib },
                    { swap: liquidityProviderSwapDaiZrx, source: liquidityProvider },
                    { swap: otcOrderSwap, source: {address: maker} }
                ], tx.logs);
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

                verifyBundleSwapEventsFromLogs([
                    { swap: uniV3SwapWethDai, outputFirst: true, deposit: true, source: uniV3WethDai },
                    { swap: uniV3SwapWethZrx, outputFirst: true, deposit: true, source: uniV3WethZrx },
                    { swap: uniV3SwapWethShib, outputFirst: true, deposit: true, source: uniV3WethShib }
                ], tx.logs);
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

                verifyBundleSwapEventsFromLogs([
                    { swap: uniV3SwapDaiWeth, outputFirst: true, withdraw: true, source: uniV3DaiWeth },
                    { swap: uniV3SwapZrxWeth, outputFirst: true, withdraw: true, source: uniV3ZrxWeth },
                    { swap: uniV3SwapShibWeth, outputFirst: true, withdraw: true, source: uniV3ShibWeth }
                ], tx.logs);
            });
        });

        describe('swap eth and tokens for tokens', () => {
            it('UniV3', async () => {
                const uniV3WethDai = await createUniswapV3PoolAsync(weth, dai);
                const uniV3WethZrx = await createUniswapV3PoolAsync(weth, zrx);
                const uniV3WethShib = await createUniswapV3PoolAsync(weth, shib);

                const uniV3SwapWethDai = getUniswapV3Swap([weth, dai], true);
                const uniV3SwapWethZrx = getUniswapV3Swap([weth, zrx]);
                const uniV3SwapWethShib = getUniswapV3Swap([weth, shib]);

                await mintToAsync(weth, taker, uniV3SwapWethZrx.inputTokenAmount.plus(uniV3SwapWethShib.inputTokenAmount));

                const tx = await bundleSwap.bundleSwap([
                    uniV3SwapWethDai,
                    uniV3SwapWethZrx,
                    uniV3SwapWethShib
                ], ErrorBehaviour.REVERT).awaitTransactionSuccessAsync({
                    from: taker,
                    value: uniV3SwapWethDai.inputTokenAmount
                });

                verifyBundleSwapEventsFromLogs([
                    { swap: uniV3SwapWethDai, outputFirst: true, deposit: true, source: uniV3WethDai },
                    { swap: uniV3SwapWethZrx, outputFirst: true, source: uniV3WethZrx },
                    { swap: uniV3SwapWethShib, outputFirst: true, source: uniV3WethShib }
                ], tx.logs);
            });
        });
    });

    describe('additional ETH handling', () => {
        // TODO: ETH_LEAK

        it('not all used', async () => {
            const uniV3 = await createUniswapV3PoolAsync(weth, zrx);
            const uniV3Swap = getUniswapV3Swap([weth, zrx], true);

            const ethBalanceBefore = await env.web3Wrapper.getBalanceInWeiAsync(taker);

            const tx = await bundleSwap.bundleSwap([
                uniV3Swap
            ], ErrorBehaviour.REVERT).awaitTransactionSuccessAsync({from: taker, value: BigNumber.sum(uniV3Swap.inputTokenAmount, new BigNumber(1))});

            const ethBalanceAfter = await env.web3Wrapper.getBalanceInWeiAsync(taker);

            // 1 wei sent too much should be returned
            expect(ethBalanceAfter).to.bignumber.eq(ethBalanceBefore.minus(uniV3Swap.inputTokenAmount).minus(tx.gasUsed));

            verifyBundleSwapEventsFromLogs([
                { swap: uniV3Swap, outputFirst: true, deposit: true, source: uniV3 },
            ], tx.logs);
        });
    });

    describe('error behaviour', () => {
        it('revert', async () => {
            await createUniswapV3PoolAsync(shib, zrx);
            const uniV3Swap = getUniswapV3Swap([shib, zrx], false, false, toBaseUnitAmount(1), toBaseUnitAmount(11));
            await mintToAsync(shib, taker, uniV3Swap.inputTokenAmount);

            const txPromise = bundleSwap.bundleSwap([
                uniV3Swap
            ], ErrorBehaviour.REVERT).awaitTransactionSuccessAsync({from: taker});

            return expect(txPromise).to.revertWith('UniswapV3Feature/UNDERBOUGHT');
        });

        it('continue ETH -> has to revert', async () => {
            await createUniswapV3PoolAsync(weth, zrx);

            const uniV3SwapUnderbought = getUniswapV3Swap([weth, zrx], true, false, toBaseUnitAmount(1), toBaseUnitAmount(11));
            const uniV3Swap = getUniswapV3Swap([weth, zrx], true);

            const value = BigNumber.sum(
              uniV3SwapUnderbought.inputTokenAmount,
              uniV3Swap.inputTokenAmount,
            );

            const txPromise = bundleSwap.bundleSwap([
                uniV3SwapUnderbought,
                uniV3Swap
            ], ErrorBehaviour.CONTINUE).awaitTransactionSuccessAsync({from: taker, value});

            return expect(txPromise).to.revertWith('BundleSwapFeature::bundleSwap/SELL_ETH_REVERTED');
        });

        it('continue tokens -> should not revert', async () => {
            await createUniswapV3PoolAsync(shib, zrx);
            const uniV3WethZrx = await createUniswapV3PoolAsync(weth, zrx);

            const uniV3SwapUnderbought = getUniswapV3Swap([shib, zrx], false, false, toBaseUnitAmount(1), toBaseUnitAmount(11));
            const uniV3Swap = getUniswapV3Swap([weth, zrx], true);

            await mintToAsync(shib, taker, uniV3SwapUnderbought.inputTokenAmount);

            const shibBalanceBefore = await shib.balanceOf(taker).callAsync();

            const tx = await bundleSwap.bundleSwap([
                uniV3SwapUnderbought,
                uniV3Swap
            ], ErrorBehaviour.CONTINUE).awaitTransactionSuccessAsync({from: taker, value: uniV3Swap.inputTokenAmount});

            const shibBalanceAfter = await shib.balanceOf(taker).callAsync();

            expect(shibBalanceAfter).to.bignumber.eq(shibBalanceBefore);

            verifyBundleSwapEventsFromLogs([
                { swap: uniV3SwapUnderbought, fail: true},
                { swap: uniV3Swap, outputFirst: true, deposit: true, source: uniV3WethZrx},
            ], tx.logs);
        });

        it('stop ETH -> has to revert', async () => {
            await createUniswapV3PoolAsync(weth, zrx);

            const uniV3Swap = getUniswapV3Swap([weth, zrx], true);
            const uniV3SwapUnderbought = getUniswapV3Swap([weth, zrx], true, false, toBaseUnitAmount(1), toBaseUnitAmount(11));

            const value = BigNumber.sum(
                uniV3Swap.inputTokenAmount,
                uniV3SwapUnderbought.inputTokenAmount,
            );

            const txPromise = bundleSwap.bundleSwap([
                uniV3Swap,
                uniV3SwapUnderbought,
            ], ErrorBehaviour.STOP).awaitTransactionSuccessAsync({from: taker, value});

            return expect(txPromise).to.revertWith('BundleSwapFeature::bundleSwap/SELL_ETH_REVERTED');
        });

        it('stop tokens -> should not revert', async () => {
            const uniV3DaiZrx = await createUniswapV3PoolAsync(dai, zrx);
            await createUniswapV3PoolAsync(shib, zrx);
            await createUniswapV3PoolAsync(weth, zrx);

            const uniV3Swap1 = getUniswapV3Swap([dai, zrx]);
            const uniV3SwapUnderbought = getUniswapV3Swap([shib, zrx], false, false, toBaseUnitAmount(1), toBaseUnitAmount(20));
            const uniV3Swap2 = getUniswapV3Swap([weth, zrx], true);

            await mintToAsync(dai, taker, uniV3Swap1.inputTokenAmount);
            await mintToAsync(shib, taker, uniV3SwapUnderbought.inputTokenAmount);

            const shibBalanceBefore = await shib.balanceOf(taker).callAsync();
            const ethBalanceBefore = await env.web3Wrapper.getBalanceInWeiAsync(taker);

            const tx = await bundleSwap.bundleSwap([
                uniV3Swap1,
                uniV3SwapUnderbought,
                uniV3Swap2
            ], ErrorBehaviour.STOP).awaitTransactionSuccessAsync({from: taker, value: uniV3Swap2.inputTokenAmount});

            const shibBalanceAfter = await shib.balanceOf(taker).callAsync();
            const ethBalanceAfter = await env.web3Wrapper.getBalanceInWeiAsync(taker);

            expect(shibBalanceAfter).to.bignumber.eq(shibBalanceBefore);
            expect(ethBalanceAfter).to.bignumber.eq(ethBalanceBefore.minus(tx.gasUsed));

            verifyBundleSwapEventsFromLogs([
                { swap: uniV3Swap1, outputFirst: true, source: uniV3DaiZrx},
                { swap: uniV3SwapUnderbought, fail: true},
            ], tx.logs);
        });
    });

    describe('additional token handling', () => {
        it('output token return failed', async () => {
            // amount of error token in pool has to be 3132 because the token contract will return false on transfer
            // in this case. Test pool always return full amount.
            await createUniswapV3PoolAsync(dai, transferErrorToken, toBaseUnitAmount(10), new BigNumber(3132));
            const uniV3Swap1 = getUniswapV3Swap([dai, transferErrorToken]);
            await mintToAsync(dai, taker, uniV3Swap1.inputTokenAmount);

            const txPromise = bundleSwap.bundleSwap([
                uniV3Swap1,
            ], ErrorBehaviour.REVERT).awaitTransactionSuccessAsync({from: taker});

            return expect(txPromise).to.revertWith('BundleSwapFeature::_returnOutputToken/OUTPUT_TOKEN_RETURN_FAILED');
        });
    });
});
