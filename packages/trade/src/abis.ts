import { parseAbi } from 'viem';

export const erc20Abi = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

export const permit2Abi = parseAbi([
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
]);

export const v4QuoterAbi = parseAbi([
  'function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)',
]);

export const v3QuoterV2Abi = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);

export const v3FactoryAbi = parseAbi(['function getPool(address, address, uint24) view returns (address)']);
export const v3PoolAbi = parseAbi(['function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)', 'function liquidity() view returns (uint128)']);
export const v2FactoryAbi = parseAbi(['function getPair(address, address) view returns (address)']);
export const v2PairAbi = parseAbi(['function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32)', 'function token0() view returns (address)']);

export const v4StateViewAbi = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128)',
]);
export const v4PositionManagerAbi = parseAbi([
  'function poolKeys(bytes25 poolId) view returns (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)',
]);

/** PONS per-token curve (no verified source; selectors resolved via the public signature database and checked by simulation). */
export const ponsCurveAbi = parseAbi([
  'function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256)',
  'function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256)',
  'function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)',
  'function feeBps() view returns (uint256)',
  'function creatorTaxBps() view returns (uint256)',
  'function currentSnipeTaxBps(address) view returns (uint256)',
  'function graduated() view returns (bool)',
  'function token() view returns (address)',
  'function factory() view returns (address)',
  'function isNativeQuote() view returns (bool)',
  'function realQuoteReserve() view returns (uint256)',
  'function graduationThreshold() view returns (uint256)',
  'function sellableTokens() view returns (uint256)',
]);
export const ponsFactoryAbi = parseAbi(['function getLaunchedToken(address token) view returns (address token_, address curve)']);

/** RushrCurveRouter (contracts/src/RushrCurveRouter.sol). Not deployed. */
export const rushrCurveRouterAbi = parseAbi([
  'function buy(address token, uint256 minTokensOut, address recipient, uint256 deadline, bool referred) payable returns (uint256 tokensOut)',
  'function sell(address token, uint256 tokensIn, uint256 minQuoteOut, address recipient, uint256 deadline, bool referred) returns (uint256 quoteOut)',
  'function feeBps() view returns (uint16)',
  'function referralFeeBps() view returns (uint16)',
  'function treasury() view returns (address)',
]);

/** Errors we decode from simulations and quotes. */
export const knownErrorsAbi = parseAbi([
  'error V3TooLittleReceived()',
  'error V2TooLittleReceived()',
  'error V4TooLittleReceived(uint256 minAmountOutReceived, uint256 amountReceived)',
  'error InsufficientETH()',
  'error InsufficientToken()',
  'error TransactionDeadlinePassed()',
  'error ExecutionFailed(uint256 commandIndex, bytes message)',
  'error AllowanceExpired(uint256 deadline)',
  'error InsufficientAllowance(uint256 amount)',
  'error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)',
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
  'error NotEnoughLiquidity(bytes32 poolId)',
  'error UnexpectedRevertBytes(bytes revertData)',
  'error WrappedError(address target, bytes4 selector, bytes reason, bytes details)',
  'error PoolNotInitialized()',
  'error PriceLimitAlreadyExceeded(uint160 sqrtPriceCurrentX96, uint160 sqrtPriceLimitX96)',
  'error SlippageExceeded(uint256 received, uint256 minimum)',
  'error UnknownCurve(address token)',
  'error CurveGraduated(address token)',
  'error DeadlinePassed()',
  'error Reentrancy()',
  'error EthTransferFailed()',
  'error TokenCallFailed()',
  'error Error(string)',
]);
