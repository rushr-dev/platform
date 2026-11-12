// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.26;

/// @dev Uniswap Universal Router v2.1 (Robinhood Chain: 0x204f…0498 official, 0x8876…0904 legacy).
interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IERC20R {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title RushrRouter
/// @notice Swaps ETH <-> token on canonical Uniswap v2 / v3 / v4 pools with the Rushr platform fee, for
///         the signer policy of Rushr's one-click trading. The caller passes a STRUCTURED route; this
///         contract builds the Universal Router commands itself, so the output can only ever go to
///         msg.sender (the trader). There is no arbitrary-calldata entry point.
///
///         Entry points and who may call them (enforced by the wallet provider's signer policy, since
///         on-chain the server signer and the user are the same EOA):
///         - `buy`  : server signer and user. Any canonical v2/v3 pool (the Universal Router derives the
///                    pool from Uniswap's factory), v4 pools only with allowlisted hooks. Bounded by the
///                    policy's ETH caps. Paused by the guardian.
///         - `sell` : server signer and user. Only pools on the timelocked sell allowlist. Paused by the
///                    guardian.
///         - `sellAnyPool`: user-confirmed only (denied in the server signer's policy). Any canonical pool,
///                    never paused, so users can always exit through Rushr.
///
///         Fee: taken in ETH, from the input on buys and from the output on sells; `referralFeeBps` when
///         `referred`. NOT DEPLOYED. Audit-gated.
contract RushrRouter {
    // ------------------------------------------------------------------ types

    enum Kind {
        V2,
        V3,
        V4
    }

    /// @param kind     pool family
    /// @param token    the traded token
    /// @param quote    WETH (v2/v3/v4) or address(0) for native ETH (v4 only)
    /// @param fee      v3 fee tier / v4 fee (incl. dynamic flag); ignored for v2
    /// @param tickSpacing v4 only
    /// @param hooks    v4 only
    struct Route {
        Kind kind;
        address token;
        address quote;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    // ------------------------------------------------------------------ constants

    uint16 public constant MAX_FEE_BPS = 300;
    uint256 public constant MIN_DELAY = 10 minutes;

    // Universal Router v2 commands / v4 actions / recipients (Commands.sol, Actions.sol, ActionConstants.sol)
    bytes1 internal constant V3_SWAP_EXACT_IN = 0x00;
    bytes1 internal constant V2_SWAP_EXACT_IN = 0x08;
    bytes1 internal constant WRAP_ETH = 0x0b;
    bytes1 internal constant UNWRAP_WETH = 0x0c;
    bytes1 internal constant V4_SWAP = 0x10;
    uint8 internal constant A_SWAP_EXACT_IN_SINGLE = 0x06;
    uint8 internal constant A_SETTLE = 0x0b;
    uint8 internal constant A_TAKE = 0x0e;
    uint8 internal constant A_TAKE_ALL = 0x0f;
    address internal constant UR_MSG_SENDER = address(1);
    address internal constant UR_ADDRESS_THIS = address(2);
    uint256 internal constant OPEN_DELTA = 0;

    // ------------------------------------------------------------------ immutables

    IUniversalRouter public immutable universalRouter;
    address public immutable weth;
    address public immutable treasury;
    uint16 public immutable feeBps;
    uint16 public immutable referralFeeBps;
    address public immutable guardian;
    uint256 public immutable delay;

    // ------------------------------------------------------------------ state

    /// @notice Queues allowlist additions (cannot activate or pause). Rotated by the guardian.
    address public operator;
    bool public paused;
    /// @notice v4 hooks usable for buys and sells (address(0) = hookless).
    mapping(address => bool) public hookAllowed;
    /// @notice Pools usable by `sell` (key = poolKeyOf(route)).
    mapping(bytes32 => bool) public sellPoolAllowed;
    /// @notice Pending additions: key => earliest activation time.
    mapping(bytes32 => uint256) public queuedAt;

    uint256 private _lock = 1;

    // ------------------------------------------------------------------ events / errors

    event Trade(
        address indexed trader,
        address indexed token,
        bytes32 indexed pool,
        bool isBuy,
        bool referred,
        uint256 quoteAmount,
        uint256 tokenAmount,
        uint256 fee
    );
    event Queued(bytes32 indexed key, bool isHook, uint256 eta);
    event Activated(bytes32 indexed key, bool isHook);
    event Removed(bytes32 indexed key, bool isHook);
    event Paused(bool paused);
    event OperatorChanged(address operator);

    error ZeroAddress();
    error FeeTooHigh();
    error DelayTooShort();
    error ZeroAmount();
    error DeadlinePassed();
    error BadRoute();
    error HookNotAllowed(address hooks);
    error PoolNotAllowed(bytes32 pool);
    error SlippageExceeded(uint256 received, uint256 minimum);
    error IsPaused();
    error NotGuardian();
    error NotOperator();
    error NotQueued();
    error TooEarly(uint256 eta);
    error EthTransferFailed();
    error TokenCallFailed();
    error Reentrancy();
    error UnexpectedEth();

    // ------------------------------------------------------------------ modifiers

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert NotGuardian();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert IsPaused();
        _;
    }

    modifier beforeDeadline(uint256 deadline) {
        if (block.timestamp > deadline) revert DeadlinePassed();
        _;
    }

    constructor(
        IUniversalRouter universalRouter_,
        address weth_,
        address treasury_,
        uint16 feeBps_,
        uint16 referralFeeBps_,
        address guardian_,
        address operator_,
        uint256 delay_,
        address[] memory initialHooks
    ) {
        if (
            address(universalRouter_) == address(0) || weth_ == address(0) || treasury_ == address(0)
                || guardian_ == address(0)
        ) revert ZeroAddress();
        if (feeBps_ > MAX_FEE_BPS || referralFeeBps_ > feeBps_) revert FeeTooHigh();
        if (delay_ < MIN_DELAY) revert DelayTooShort();
        universalRouter = universalRouter_;
        weth = weth_;
        treasury = treasury_;
        feeBps = feeBps_;
        referralFeeBps = referralFeeBps_;
        guardian = guardian_;
        operator = operator_;
        delay = delay_;
        for (uint256 i; i < initialHooks.length; ++i) {
            hookAllowed[initialHooks[i]] = true;
            emit Activated(_hookKey(initialHooks[i]), true);
        }
    }

    // ------------------------------------------------------------------ trading

    /// @notice Buy `route.token` with msg.value ETH. Fee comes off the input; `minTokensOut` is checked on
    ///         what msg.sender actually receives.
    function buy(Route calldata route, uint256 minTokensOut, uint256 deadline, bool referred)
        external
        payable
        nonReentrant
        whenNotPaused
        beforeDeadline(deadline)
        returns (uint256 tokensOut)
    {
        if (msg.value == 0) revert ZeroAmount();
        bytes32 pool = _checkRoute(route);
        uint256 bps = referred ? referralFeeBps : feeBps;
        uint256 fee = (msg.value * bps) / 10_000;
        uint256 ethBefore = address(this).balance - msg.value;

        tokensOut = _buyAndDeliver(route, msg.value - fee, deadline);
        if (tokensOut < minTokensOut) revert SlippageExceeded(tokensOut, minTokensOut);

        // Anything the Universal Router sent back besides the withheld fee is refunded.
        uint256 extra = address(this).balance - ethBefore - fee;
        _sendEth(treasury, fee);
        _sendEth(msg.sender, extra);
        emit Trade(msg.sender, route.token, pool, true, referred, msg.value - extra, tokensOut, fee);
    }

    /// @dev Swap output lands here (the Universal Router pays its msg.sender, this router), then goes to
    ///      the trader; returns what the trader actually received (transfer-tax safe).
    function _buyAndDeliver(Route calldata route, uint256 amount, uint256 deadline)
        internal
        returns (uint256 tokensOut)
    {
        uint256 held = IERC20R(route.token).balanceOf(address(this));
        (bytes memory commands, bytes[] memory inputs) = _buyPlan(route, amount);
        universalRouter.execute{value: amount}(commands, inputs, deadline);
        uint256 got = IERC20R(route.token).balanceOf(address(this)) - held;

        uint256 before = IERC20R(route.token).balanceOf(msg.sender);
        _call(route.token, abi.encodeCall(IERC20R.transfer, (msg.sender, got)));
        tokensOut = IERC20R(route.token).balanceOf(msg.sender) - before;
    }

    /// @notice Sell on an allowlisted pool (the server signer's sell path).
    function sell(Route calldata route, uint256 tokensIn, uint256 minQuoteOut, uint256 deadline, bool referred)
        external
        nonReentrant
        whenNotPaused
        beforeDeadline(deadline)
        returns (uint256 quoteOut)
    {
        bytes32 pool = _checkRoute(route);
        if (!sellPoolAllowed[pool]) revert PoolNotAllowed(pool);
        quoteOut = _sell(route, pool, tokensIn, minQuoteOut, deadline, referred);
    }

    /// @notice Sell on any canonical pool. User-confirmed only: the server signer's policy must deny this
    ///         selector. Not paused, so users can always exit.
    function sellAnyPool(Route calldata route, uint256 tokensIn, uint256 minQuoteOut, uint256 deadline, bool referred)
        external
        nonReentrant
        beforeDeadline(deadline)
        returns (uint256 quoteOut)
    {
        bytes32 pool = _checkRoute(route);
        quoteOut = _sell(route, pool, tokensIn, minQuoteOut, deadline, referred);
    }

    function _sell(
        Route calldata route,
        bytes32 pool,
        uint256 tokensIn,
        uint256 minQuoteOut,
        uint256 deadline,
        bool referred
    ) internal returns (uint256 quoteOut) {
        if (tokensIn == 0) revert ZeroAmount();
        // Pull from the trader, then hand the Universal Router exactly what it actually received
        // (fee-on-transfer safe); it pays the pool from its own balance.
        uint256 ur0 = IERC20R(route.token).balanceOf(address(universalRouter));
        _call(route.token, abi.encodeCall(IERC20R.transferFrom, (msg.sender, address(universalRouter), tokensIn)));
        uint256 amount = IERC20R(route.token).balanceOf(address(universalRouter)) - ur0;
        if (amount == 0) revert ZeroAmount();

        uint256 ethBefore = address(this).balance;
        (bytes memory commands, bytes[] memory inputs) = _sellPlan(route, amount);
        universalRouter.execute(commands, inputs, deadline);
        uint256 gross = address(this).balance - ethBefore;

        uint256 fee = (gross * (referred ? referralFeeBps : feeBps)) / 10_000;
        quoteOut = gross - fee;
        if (quoteOut < minQuoteOut) revert SlippageExceeded(quoteOut, minQuoteOut);
        _sendEth(treasury, fee);
        _sendEth(msg.sender, quoteOut);
        emit Trade(msg.sender, route.token, pool, false, referred, gross, amount, fee);
    }

    /// @dev ETH only arrives mid-trade (Universal Router payouts / refunds).
    receive() external payable {
        if (_lock != 2) revert UnexpectedEth();
    }

    // ------------------------------------------------------------------ route building

    function _checkRoute(Route calldata r) internal view returns (bytes32 pool) {
        if (r.token == address(0) || r.token == weth || r.token == r.quote) revert BadRoute();
        if (r.kind == Kind.V4) {
            if (r.quote != address(0) && r.quote != weth) revert BadRoute();
            if (!hookAllowed[r.hooks]) revert HookNotAllowed(r.hooks);
        } else {
            if (r.quote != weth || r.hooks != address(0)) revert BadRoute();
            if (r.kind == Kind.V3 && r.fee == 0) revert BadRoute();
        }
        pool = poolKeyOf(r);
    }

    /// @notice Allowlist key of a route: the v4 PoolId, or a hash identifying the canonical v2/v3 pool.
    function poolKeyOf(Route calldata r) public pure returns (bytes32) {
        if (r.kind == Kind.V4) {
            (address c0, address c1) = r.quote < r.token ? (r.quote, r.token) : (r.token, r.quote);
            return keccak256(abi.encode(c0, c1, r.fee, r.tickSpacing, r.hooks));
        }
        (address t0, address t1) = r.quote < r.token ? (r.quote, r.token) : (r.token, r.quote);
        return keccak256(abi.encode(uint8(r.kind), t0, t1, r.kind == Kind.V3 ? r.fee : uint24(0)));
    }

    function _buyPlan(Route calldata r, uint256 amount) internal view returns (bytes memory c, bytes[] memory in_) {
        if (r.kind == Kind.V4 && r.quote == address(0)) {
            c = abi.encodePacked(V4_SWAP);
            in_ = new bytes[](1);
            in_[0] = _v4Swap(r, true, amount, r.quote, r.token, false);
            return (c, in_);
        }
        c = abi.encodePacked(
            WRAP_ETH, r.kind == Kind.V4 ? V4_SWAP : r.kind == Kind.V3 ? V3_SWAP_EXACT_IN : V2_SWAP_EXACT_IN
        );
        in_ = new bytes[](2);
        in_[0] = abi.encode(UR_ADDRESS_THIS, amount);
        in_[1] = r.kind == Kind.V4
            ? _v4Swap(r, true, amount, weth, r.token, false)
            : _v23Swap(r, amount, weth, r.token, UR_MSG_SENDER);
    }

    function _sellPlan(Route calldata r, uint256 amount) internal view returns (bytes memory c, bytes[] memory in_) {
        if (r.kind == Kind.V4 && r.quote == address(0)) {
            c = abi.encodePacked(V4_SWAP);
            in_ = new bytes[](1);
            in_[0] = _v4Swap(r, false, amount, r.token, r.quote, true);
            return (c, in_);
        }
        // Output WETH stays in the Universal Router, then UNWRAP_WETH pays ETH to this router.
        c = abi.encodePacked(
            r.kind == Kind.V4 ? V4_SWAP : r.kind == Kind.V3 ? V3_SWAP_EXACT_IN : V2_SWAP_EXACT_IN, UNWRAP_WETH
        );
        in_ = new bytes[](2);
        in_[0] = r.kind == Kind.V4
            ? _v4Swap(r, false, amount, r.token, weth, false)
            : _v23Swap(r, amount, r.token, weth, UR_ADDRESS_THIS);
        in_[1] = abi.encode(UR_MSG_SENDER, uint256(0));
    }

    /// @dev V2/V3_SWAP_EXACT_IN with v2.1's trailing `uint256[] maxHopSlippage` (empty). Paid from the
    ///      Universal Router's own balance (payerIsUser = false); min out is checked by this contract.
    function _v23Swap(Route calldata r, uint256 amount, address tokenIn, address tokenOut, address recipient)
        internal
        pure
        returns (bytes memory)
    {
        uint256[] memory noHops = new uint256[](0);
        if (r.kind == Kind.V3) {
            return abi.encode(recipient, amount, uint256(0), abi.encodePacked(tokenIn, r.fee, tokenOut), false, noHops);
        }
        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;
        return abi.encode(recipient, amount, uint256(0), path, false, noHops);
    }

    /// @dev V4_SWAP: SWAP_EXACT_IN_SINGLE (v2.1 params with maxHopSlippage), SETTLE the input from the
    ///      Universal Router's balance, then TAKE the output: to this router directly (buys: TAKE_ALL to
    ///      msgSender; native-ETH sells: TAKE to msgSender) or into the Universal Router for unwrapping.
    function _v4Swap(
        Route calldata r,
        bool isBuy,
        uint256 amount,
        address currencyIn,
        address currencyOut,
        bool outToCaller
    ) internal pure returns (bytes memory) {
        (address c0, address c1) = r.quote < r.token ? (r.quote, r.token) : (r.token, r.quote);
        bytes memory actions = abi.encodePacked(A_SWAP_EXACT_IN_SINGLE, A_SETTLE, isBuy ? A_TAKE_ALL : A_TAKE);
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            ExactInputSingleParams({
                poolKey: PoolKey(c0, c1, r.fee, r.tickSpacing, r.hooks),
                zeroForOne: currencyIn == c0,
                amountIn: uint128(amount),
                amountOutMinimum: 0,
                maxHopSlippage: 0,
                hookData: ""
            })
        );
        params[1] = abi.encode(currencyIn, OPEN_DELTA, false);
        params[2] = isBuy
            ? abi.encode(currencyOut, uint256(0))
            : abi.encode(currencyOut, outToCaller ? UR_MSG_SENDER : UR_ADDRESS_THIS, OPEN_DELTA);
        return abi.encode(actions, params);
    }

    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct ExactInputSingleParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        uint256 maxHopSlippage;
        bytes hookData;
    }

    // ------------------------------------------------------------------ allowlists (timelocked)

    function queueSellPool(bytes32 pool) external {
        if (msg.sender != operator && msg.sender != guardian) revert NotOperator();
        _queue(pool, false);
    }

    function queueHook(address hooks) external {
        if (msg.sender != operator && msg.sender != guardian) revert NotOperator();
        _queue(_hookKey(hooks), true);
    }

    /// @notice Anyone can activate a queued entry once its delay has passed.
    function activateSellPool(bytes32 pool) external {
        _activate(pool);
        sellPoolAllowed[pool] = true;
        emit Activated(pool, false);
    }

    function activateHook(address hooks) external {
        _activate(_hookKey(hooks));
        hookAllowed[hooks] = true;
        emit Activated(_hookKey(hooks), true);
    }

    /// @notice Guardian: cancel a queued entry or remove an active one, immediately.
    function removeSellPool(bytes32 pool) external onlyGuardian {
        delete queuedAt[pool];
        delete sellPoolAllowed[pool];
        emit Removed(pool, false);
    }

    function removeHook(address hooks) external onlyGuardian {
        delete queuedAt[_hookKey(hooks)];
        delete hookAllowed[hooks];
        emit Removed(_hookKey(hooks), true);
    }

    function setPaused(bool p) external onlyGuardian {
        paused = p;
        emit Paused(p);
    }

    function setOperator(address op) external onlyGuardian {
        operator = op;
        emit OperatorChanged(op);
    }

    function _queue(bytes32 key, bool isHook) internal {
        uint256 eta = block.timestamp + delay;
        queuedAt[key] = eta;
        emit Queued(key, isHook, eta);
    }

    function _activate(bytes32 key) internal {
        uint256 eta = queuedAt[key];
        if (eta == 0) revert NotQueued();
        if (block.timestamp < eta) revert TooEarly(eta);
        delete queuedAt[key];
    }

    function _hookKey(address hooks) internal pure returns (bytes32) {
        return keccak256(abi.encode("hook", hooks));
    }

    // ------------------------------------------------------------------ utils

    function _sendEth(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert EthTransferFailed();
    }

    function _call(address token, bytes memory data) internal {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TokenCallFailed();
    }
}
