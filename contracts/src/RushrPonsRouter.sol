// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.26;

/// @notice Minimal views of the PONS launch factory and per-token bonding curve on Robinhood Chain.
/// Selectors were resolved from deployed bytecode and checked with eth_simulateV1 (see docs/trading.md).
interface IPonsFactory {
    /// @dev Returns a larger struct; only the first two words (token, curve) are read.
    function getLaunchedToken(address token) external view returns (address token_, address curve);
}

interface IPonsCurve {
    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) external payable returns (uint256);
    function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) external returns (uint256);
    function graduated() external view returns (bool);
}

interface IERC20Min {
    function balanceOf(address) external view returns (uint256);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title RushrPonsRouter
/// @notice Buys and sells PONS bonding-curve tokens with the Rushr platform fee, in one transaction.
///         The fee is always taken in ETH: from the ETH actually spent on buys, from the output on sells.
///         Two immutable rates: `feeBps` and the discounted `referralFeeBps` for referred traders
///         (referral attribution and the referrer's share are accounted off-chain).
/// @dev Non-custodial and stateless between transactions. No owner, no upgradeability, no arbitrary
///      calls: the only external targets are the immutable PONS factory, the curve it reports for the
///      token, the token itself and the immutable treasury. NOT DEPLOYED; review before any deployment.
contract RushrPonsRouter {
    uint16 public constant MAX_FEE_BPS = 300;

    IPonsFactory public immutable factory;
    address public immutable treasury;
    uint16 public immutable feeBps;
    uint16 public immutable referralFeeBps;

    uint256 private _lock = 1;

    event Trade(
        address indexed trader,
        address indexed token,
        address indexed recipient,
        bool isBuy,
        bool referred,
        uint256 quoteAmount,
        uint256 tokenAmount,
        uint256 fee,
        uint256 refund
    );

    error ZeroAddress();
    error FeeTooHigh();
    error ZeroAmount();
    error DeadlinePassed();
    error UnknownCurve(address token);
    error CurveGraduated(address token);
    error SlippageExceeded(uint256 received, uint256 minimum);
    error EthTransferFailed();
    error TokenCallFailed();
    error Reentrancy();
    error UnexpectedEth();

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    modifier beforeDeadline(uint256 deadline) {
        if (block.timestamp > deadline) revert DeadlinePassed();
        _;
    }

    constructor(IPonsFactory factory_, address treasury_, uint16 feeBps_, uint16 referralFeeBps_) {
        if (address(factory_) == address(0) || treasury_ == address(0)) revert ZeroAddress();
        if (feeBps_ > MAX_FEE_BPS || referralFeeBps_ > feeBps_) revert FeeTooHigh();
        factory = factory_;
        treasury = treasury_;
        feeBps = feeBps_;
        referralFeeBps = referralFeeBps_;
    }

    /// @notice Buy `token` on its PONS curve with msg.value ETH; the fee is taken from the input.
    /// @dev If the buy completes the curve, PONS keeps only what reaches the graduation threshold and
    ///      refunds the rest to this router; we then charge the fee only on the ETH actually spent and
    ///      refund the remainder to msg.sender.
    /// @param minTokensOut Minimum tokens `recipient` must actually receive (after any transfer tax).
    /// @param referred Trader was referred: charge `referralFeeBps` instead of `feeBps`.
    function buy(address token, uint256 minTokensOut, address recipient, uint256 deadline, bool referred)
        external
        payable
        nonReentrant
        beforeDeadline(deadline)
        returns (uint256 tokensOut)
    {
        if (msg.value == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroAddress();
        uint256 bps = referred ? referralFeeBps : feeBps;
        uint256 fee = (msg.value * bps) / 10_000;
        uint256 ethBefore = address(this).balance - msg.value;

        tokensOut = _buyOnCurve(_curveOf(token), token, msg.value - fee, minTokensOut, recipient);

        uint256 refund;
        (fee, refund) = _settleRefund(msg.value, fee, ethBefore, bps);
        _sendEth(treasury, fee);
        _sendEth(msg.sender, refund);
        emit Trade(msg.sender, token, recipient, true, referred, msg.value - refund, tokensOut, fee, refund);
    }

    /// @notice Sell `tokensIn` of `token` (pulled from msg.sender, which must approve this router) on its
    ///         PONS curve; the fee is taken from the ETH output.
    /// @param minQuoteOut Minimum ETH `recipient` receives, after the fee.
    function sell(
        address token,
        uint256 tokensIn,
        uint256 minQuoteOut,
        address recipient,
        uint256 deadline,
        bool referred
    ) external nonReentrant beforeDeadline(deadline) returns (uint256 quoteOut) {
        if (tokensIn == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroAddress();
        IPonsCurve curve = _curveOf(token);

        // Measure what actually arrived, so fee-on-transfer tokens can't make the curve call overspend.
        uint256 tokenBefore = IERC20Min(token).balanceOf(address(this));
        _call(token, abi.encodeCall(IERC20Min.transferFrom, (msg.sender, address(this), tokensIn)));
        uint256 received = IERC20Min(token).balanceOf(address(this)) - tokenBefore;

        _call(token, abi.encodeCall(IERC20Min.approve, (address(curve), received)));
        uint256 ethBefore = address(this).balance;
        curve.sell(received, 0, address(this));
        uint256 gross = address(this).balance - ethBefore;
        _call(token, abi.encodeCall(IERC20Min.approve, (address(curve), 0)));

        // Tokens the curve did not take go back to the seller.
        uint256 unsold = IERC20Min(token).balanceOf(address(this)) - tokenBefore;
        if (unsold != 0) _call(token, abi.encodeCall(IERC20Min.transfer, (msg.sender, unsold)));

        uint256 fee = (gross * (referred ? referralFeeBps : feeBps)) / 10_000;
        quoteOut = gross - fee;
        if (quoteOut < minQuoteOut) revert SlippageExceeded(quoteOut, minQuoteOut);

        _sendEth(treasury, fee);
        _sendEth(recipient, quoteOut);
        emit Trade(msg.sender, token, recipient, false, referred, gross, received - unsold, fee, 0);
    }

    /// @dev ETH is only accepted mid-trade (curve paying out a sell); stray transfers revert.
    receive() external payable {
        if (_lock != 2) revert UnexpectedEth();
    }

    /// @dev Buys on the curve and checks what `recipient` actually received (transfer-tax safe).
    function _buyOnCurve(IPonsCurve curve, address token, uint256 amount, uint256 minTokensOut, address recipient)
        internal
        returns (uint256 tokensOut)
    {
        uint256 before = IERC20Min(token).balanceOf(recipient);
        curve.buy{value: amount}(amount, minTokensOut, recipient);
        tokensOut = IERC20Min(token).balanceOf(recipient) - before;
        if (tokensOut < minTokensOut) revert SlippageExceeded(tokensOut, minTokensOut);
    }

    /// @dev If the curve returned ETH (graduation cap), re-derive the fee on the ETH actually spent and
    ///      the refund owed to the payer. Everything held above `ethBefore` is the withheld fee + returns.
    function _settleRefund(uint256 value, uint256 fee, uint256 ethBefore, uint256 bps)
        internal
        view
        returns (uint256 finalFee, uint256 refund)
    {
        uint256 returned = address(this).balance - ethBefore - fee;
        if (returned == 0) return (fee, 0);
        uint256 spent = value - fee - returned;
        finalFee = (spent * bps) / (10_000 - bps); // finalFee / (spent + finalFee) == bps / 10_000, rounded down
        refund = value - spent - finalFee;
    }

    function _curveOf(address token) internal view returns (IPonsCurve curve) {
        (address launched, address c) = factory.getLaunchedToken(token);
        if (c == address(0) || launched != token) revert UnknownCurve(token);
        curve = IPonsCurve(c);
        if (curve.graduated()) revert CurveGraduated(token);
    }

    function _sendEth(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert EthTransferFailed();
    }

    /// @dev Token call tolerant of non-standard ERC20s that return no data.
    function _call(address token, bytes memory data) internal {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TokenCallFailed();
    }
}
