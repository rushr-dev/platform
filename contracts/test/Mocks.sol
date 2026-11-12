// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @dev ERC20 with an optional transfer tax (bps, sent to address(0xdead)) for fee-on-transfer tests.
contract MockToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public taxBps;
    address public taxExempt;

    function setTax(uint256 bps, address exempt) external {
        taxBps = bps;
        taxExempt = exempt;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "allowance");
        allowance[from][msg.sender] = a - amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        uint256 tax = (from == taxExempt || to == taxExempt) ? 0 : (amount * taxBps) / 10_000;
        balanceOf[to] += amount - tax;
        balanceOf[address(0xdead)] += tax;
    }
}

/// @dev Constant-product curve shaped like PONS: fees (bps) taken from the ETH side.
contract MockCurve {
    MockToken public immutable token;
    uint256 public quoteReserve;
    uint256 public tokenReserve;
    uint256 public feeBps = 225;
    bool public graduated;
    /// @dev PONS-style cap: when > 0, a buy stops at this real quote reserve, refunds the rest to
    ///      msg.sender and graduates the curve.
    uint256 public threshold;
    uint256 public realQuote;
    /// @dev When > 0, sells take at most this many tokens (to exercise unsold-token returns).
    uint256 public maxSellTokens;
    bool public reenter;
    address public reenterTarget;
    bytes public reenterData;

    constructor(MockToken t, uint256 q, uint256 tr) payable {
        token = t;
        quoteReserve = q;
        tokenReserve = tr;
    }

    function setGraduated(bool g) external {
        graduated = g;
    }

    function setThreshold(uint256 t, uint256 real) external {
        threshold = t;
        realQuote = real;
    }

    function setMaxSell(uint256 m) external {
        maxSellTokens = m;
    }

    function setReenter(address target, bytes calldata data) external {
        reenter = true;
        reenterTarget = target;
        reenterData = data;
    }

    function buy(uint256 quoteIn, uint256 minOut, address recipient) external payable returns (uint256 out) {
        require(msg.value == quoteIn, "value");
        if (reenter) {
            (bool ok, bytes memory ret) = reenterTarget.call(reenterData);
            if (!ok) assembly { revert(add(ret, 32), mload(ret)) }
        }
        uint256 used = quoteIn;
        uint256 net = quoteIn - (quoteIn * feeBps) / 10_000;
        if (threshold != 0 && realQuote + net > threshold) {
            net = threshold - realQuote;
            used = (net * 10_000 + (10_000 - feeBps) - 1) / (10_000 - feeBps);
            graduated = true;
        }
        out = (tokenReserve * net) / (quoteReserve + net);
        require(out >= minOut, "curve slippage");
        quoteReserve += net;
        realQuote += net;
        tokenReserve -= out;
        token.transfer(recipient, out);
        if (used < quoteIn) {
            (bool ok,) = msg.sender.call{value: quoteIn - used}("");
            require(ok, "refund");
        }
    }

    function sell(uint256 tokensIn, uint256 minOut, address recipient) external returns (uint256 out) {
        if (maxSellTokens != 0 && tokensIn > maxSellTokens) tokensIn = maxSellTokens;
        token.transferFrom(msg.sender, address(this), tokensIn);
        uint256 gross = (quoteReserve * tokensIn) / (tokenReserve + tokensIn);
        out = gross - (gross * feeBps) / 10_000;
        require(out >= minOut, "curve slippage");
        quoteReserve -= gross;
        tokenReserve += tokensIn;
        (bool ok,) = recipient.call{value: out}("");
        require(ok, "eth");
    }
}

contract MockFactory {
    mapping(address => address) public curveOf;

    function set(address token, address curve) external {
        curveOf[token] = curve;
    }

    function getLaunchedToken(address token) external view returns (address, address) {
        address c = curveOf[token];
        return (c == address(0) ? address(0) : token, c);
    }
}

/// @dev Treasury that rejects ETH, to prove a failing fee transfer reverts the whole trade.
contract RejectingTreasury {
    receive() external payable {
        revert("no");
    }
}
