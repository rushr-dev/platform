// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {RushrCurveRouter, IPonsFactory, IERC20Min} from "../src/RushrCurveRouter.sol";

/// @notice Runs against a local fork of Robinhood Chain (state is read lazily; nothing is broadcast).
///         Skipped unless ROBINHOOD_RPC_URL is set:  ROBINHOOD_RPC_URL=... forge test --match-contract Fork
contract RushrCurveRouterForkTest is Test {
    IPonsFactory constant PONS_FACTORY = IPonsFactory(0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e);
    address treasury = makeAddr("treasury");
    address trader = makeAddr("trader");
    RushrCurveRouter router;
    address token;
    bool noFork;

    function setUp() public {
        string memory rpc = vm.envOr("ROBINHOOD_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            noFork = true;
            return;
        }
        vm.createSelectFork(rpc);
        token = vm.envOr("PONS_CURVE_TOKEN", address(0x89964D7fCd9cDeE7c1e4FdC17b997Bb979B05525));
        router = new RushrCurveRouter(PONS_FACTORY, treasury, 100);
        vm.deal(trader, 1 ether);
    }

    function test_fork_buyThenSellOnRealCurve() public {
        if (noFork) return;
        (, address curve) = PONS_FACTORY.getLaunchedToken(token);
        assertTrue(curve != address(0), "token has a curve");

        vm.startPrank(trader);
        uint256 bought = router.buy{value: 0.01 ether}(token, 1, trader, block.timestamp + 60);
        assertGt(bought, 0);
        assertEq(treasury.balance, 0.0001 ether, "1% of 0.01 ETH");
        assertEq(IERC20Min(token).balanceOf(trader), bought);

        IERC20Min(token).approve(address(router), bought);
        uint256 ethBefore = trader.balance;
        uint256 out = router.sell(token, bought, 1, trader, block.timestamp + 60);
        vm.stopPrank();

        assertEq(trader.balance - ethBefore, out);
        assertGt(out, 0.0090 ether, "round trip loses only fees and impact");
        assertEq(address(router).balance, 0);
        assertEq(IERC20Min(token).balanceOf(address(router)), 0);
        emit log_named_uint("tokens bought", bought);
        emit log_named_uint("eth back", out);
        emit log_named_uint("treasury", treasury.balance);
    }
}
