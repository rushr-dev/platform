// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {RushrCurveRouter, IPonsFactory, IPonsCurve, IERC20Min} from "../src/RushrCurveRouter.sol";

interface IPonsCurveViews {
    function realQuoteReserve() external view returns (uint256);
    function graduationThreshold() external view returns (uint256);
    function sellableTokens() external view returns (uint256);
}

/// @notice Against a local fork of Robinhood Chain (state read lazily; nothing is broadcast).
///         Skipped unless ROBINHOOD_RPC_URL is set:  ROBINHOOD_RPC_URL=... forge test --match-contract Fork -vv
///         PONS_CURVE_TOKEN overrides the token (must still be on its curve).
contract RushrCurveRouterForkTest is Test {
    IPonsFactory constant PONS_FACTORY = IPonsFactory(0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e);
    address treasury = makeAddr("treasury");
    address trader = makeAddr("trader");
    RushrCurveRouter router;
    address token;
    address curve;
    bool noFork;

    function setUp() public {
        string memory rpc = vm.envOr("ROBINHOOD_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            noFork = true;
            return;
        }
        vm.createSelectFork(rpc);
        token = vm.envOr("PONS_CURVE_TOKEN", address(0x89964D7fCd9cDeE7c1e4FdC17b997Bb979B05525));
        (, curve) = PONS_FACTORY.getLaunchedToken(token);
        router = new RushrCurveRouter(PONS_FACTORY, treasury, 50, 45);
        vm.deal(trader, 100 ether);
    }

    function test_fork_buyThenSellExactFees() public {
        if (noFork) return;
        assertTrue(curve != address(0), "token has a curve");
        vm.startPrank(trader);
        uint256 bought = router.buy{value: 0.01 ether}(token, 1, trader, block.timestamp + 60, false);
        assertGt(bought, 0);
        assertEq(treasury.balance, 0.00005 ether, "0.5% of 0.01 ETH");
        assertEq(IERC20Min(token).balanceOf(trader), bought);

        IERC20Min(token).approve(address(router), bought);
        uint256 ethBefore = trader.balance;
        uint256 out = router.sell(token, bought, 1, trader, block.timestamp + 60, false);
        vm.stopPrank();
        uint256 sellFee = treasury.balance - 0.00005 ether;
        assertEq(trader.balance - ethBefore, out);
        assertEq(sellFee, ((out + sellFee) * 50) / 10_000, "0.5% of gross output");
        assertEq(address(router).balance, 0);
        assertEq(IERC20Min(token).balanceOf(address(router)), 0);
        emit log_named_uint("tokens bought", bought);
        emit log_named_uint("eth back", out);
    }

    function test_fork_referredBuy() public {
        if (noFork) return;
        vm.prank(trader);
        router.buy{value: 0.01 ether}(token, 1, trader, block.timestamp + 60, true);
        assertEq(treasury.balance, 0.000045 ether, "0.45% of 0.01 ETH");
    }

    function test_fork_slippageRevertsOnRealCurve() public {
        if (noFork) return;
        uint256 snap = vm.snapshotState();
        vm.prank(trader);
        uint256 out = router.buy{value: 0.01 ether}(token, 1, trader, block.timestamp + 60, false);
        vm.revertToState(snap);
        vm.prank(trader);
        vm.expectRevert();
        router.buy{value: 0.01 ether}(token, out + 1, trader, block.timestamp + 60, false);
    }

    function test_fork_graduatingBuyRefunds() public {
        if (noFork) return;
        uint256 real = IPonsCurveViews(curve).realQuoteReserve();
        uint256 threshold = IPonsCurveViews(curve).graduationThreshold();
        uint256 sellable = IPonsCurveViews(curve).sellableTokens();
        assertLt(real, threshold);
        uint256 before = trader.balance;
        vm.prank(trader);
        uint256 out = router.buy{value: 20 ether}(token, 1, trader, block.timestamp + 60, false);
        uint256 paid = before - trader.balance;

        assertEq(out, sellable, "bought every token left on the curve");
        assertTrue(IPonsCurve(curve).graduated(), "token graduated in the same tx");
        assertLt(paid, 20 ether, "unused ETH refunded");
        assertEq(address(router).balance, 0, "no ETH stranded in the router");
        assertApproxEqAbs(treasury.balance, (paid * 50) / 10_000, 1, "fee 0.5% of what was actually paid");
        emit log_named_uint("paid", paid);
        emit log_named_uint("fee", treasury.balance);
    }
}
