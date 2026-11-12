// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {RushrCurveRouter, IPonsFactory} from "../src/RushrCurveRouter.sol";
import {MockToken, MockCurve, MockFactory, RejectingTreasury} from "./Mocks.sol";

contract RushrCurveRouterTest is Test {
    MockToken token;
    MockCurve curve;
    MockFactory factory;
    RushrCurveRouter router;
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    uint256 deadline;

    function setUp() public {
        token = new MockToken();
        curve = new MockCurve{value: 10 ether}(token, 2 ether, 1e27);
        token.mint(address(curve), 1e27);
        factory = new MockFactory();
        factory.set(address(token), address(curve));
        router = new RushrCurveRouter(IPonsFactory(address(factory)), treasury, 100);
        vm.deal(alice, 100 ether);
        deadline = block.timestamp + 300;
    }

    function test_constructorValidates() public {
        vm.expectRevert(RushrCurveRouter.FeeTooHigh.selector);
        new RushrCurveRouter(IPonsFactory(address(factory)), treasury, 301);
        vm.expectRevert(RushrCurveRouter.ZeroAddress.selector);
        new RushrCurveRouter(IPonsFactory(address(factory)), address(0), 100);
        vm.expectRevert(RushrCurveRouter.ZeroAddress.selector);
        new RushrCurveRouter(IPonsFactory(address(0)), treasury, 100);
    }

    function test_buyTakesFeeFromInput() public {
        vm.prank(alice);
        uint256 out = router.buy{value: 1 ether}(address(token), 0, alice, deadline);
        assertEq(treasury.balance, 0.01 ether, "fee = 1% of input");
        assertEq(token.balanceOf(alice), out);
        // Curve received exactly input - fee.
        uint256 net = 0.99 ether - (0.99 ether * 225) / 10_000;
        assertEq(out, (1e27 * net) / (2 ether + net));
        assertEq(address(router).balance, 0, "router holds nothing");
        assertEq(token.balanceOf(address(router)), 0);
    }

    function test_buySlippage() public {
        vm.prank(alice);
        vm.expectRevert();
        router.buy{value: 1 ether}(address(token), type(uint256).max, alice, deadline);
    }

    function test_buyChecksReceivedAfterTransferTax() public {
        token.setTax(500, address(0)); // 5% on every transfer
        uint256 net = 0.99 ether - (0.99 ether * 225) / 10_000;
        uint256 curveOut = (1e27 * net) / (2 ether + net);
        // minOut between what the curve sends and what alice gets: must revert on the router's check.
        uint256 min = (curveOut * 9_700) / 10_000;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RushrCurveRouter.SlippageExceeded.selector, curveOut - (curveOut * 500) / 10_000, min));
        router.buy{value: 1 ether}(address(token), min, alice, deadline);
    }

    function test_sellTakesFeeFromOutput() public {
        vm.startPrank(alice);
        uint256 bought = router.buy{value: 1 ether}(address(token), 0, alice, deadline);
        uint256 feeBefore = treasury.balance;
        uint256 ethBefore = alice.balance;
        token.approve(address(router), bought);
        uint256 out = router.sell(address(token), bought, 0, alice, deadline);
        vm.stopPrank();
        uint256 fee = treasury.balance - feeBefore;
        assertEq(alice.balance - ethBefore, out);
        assertEq(fee, ((out + fee) * 100) / 10_000, "fee = 1% of gross output");
        assertEq(token.allowance(address(router), address(curve)), 0, "approval reset");
        assertEq(address(router).balance, 0);
    }

    function test_sellWithTransferTaxSellsWhatArrived() public {
        vm.startPrank(alice);
        uint256 bought = router.buy{value: 1 ether}(address(token), 0, alice, deadline);
        vm.stopPrank();
        token.setTax(1_000, address(curve)); // 10% on user->router; curve transfers exempt
        vm.startPrank(alice);
        token.approve(address(router), bought);
        router.sell(address(token), bought, 0, alice, deadline);
        vm.stopPrank();
        assertEq(token.balanceOf(address(router)), 0, "nothing stuck in the router");
    }

    function test_sellSlippageOnNet() public {
        vm.startPrank(alice);
        uint256 bought = router.buy{value: 1 ether}(address(token), 0, alice, deadline);
        token.approve(address(router), bought);
        vm.expectRevert();
        router.sell(address(token), bought, 10 ether, alice, deadline);
        vm.stopPrank();
    }

    function test_unknownAndGraduatedCurves() public {
        MockToken other = new MockToken();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RushrCurveRouter.UnknownCurve.selector, address(other)));
        router.buy{value: 1 ether}(address(other), 0, alice, deadline);

        curve.setGraduated(true);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RushrCurveRouter.CurveGraduated.selector, address(token)));
        router.buy{value: 1 ether}(address(token), 0, alice, deadline);
    }

    function test_deadlineAndZeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(RushrCurveRouter.DeadlinePassed.selector);
        router.buy{value: 1 ether}(address(token), 0, alice, block.timestamp - 1);
        vm.prank(alice);
        vm.expectRevert(RushrCurveRouter.ZeroAmount.selector);
        router.buy{value: 0}(address(token), 0, alice, deadline);
        vm.prank(alice);
        vm.expectRevert(RushrCurveRouter.ZeroAddress.selector);
        router.buy{value: 1 ether}(address(token), 0, address(0), deadline);
    }

    function test_rejectsStrayEth() public {
        vm.prank(alice);
        (bool ok,) = address(router).call{value: 1 ether}("");
        assertFalse(ok);
    }

    function test_reentrancyBlocked() public {
        curve.setReenter(address(router), abi.encodeCall(RushrCurveRouter.buy, (address(token), 0, alice, deadline)));
        vm.prank(alice);
        vm.expectRevert(RushrCurveRouter.Reentrancy.selector);
        router.buy{value: 1 ether}(address(token), 0, alice, deadline);
    }

    function test_failingTreasuryRevertsTrade() public {
        RushrCurveRouter r = new RushrCurveRouter(IPonsFactory(address(factory)), address(new RejectingTreasury()), 100);
        vm.prank(alice);
        vm.expectRevert(RushrCurveRouter.EthTransferFailed.selector);
        r.buy{value: 1 ether}(address(token), 0, alice, deadline);
    }

    function test_zeroFee() public {
        RushrCurveRouter r = new RushrCurveRouter(IPonsFactory(address(factory)), treasury, 0);
        vm.prank(alice);
        r.buy{value: 1 ether}(address(token), 0, alice, deadline);
        assertEq(treasury.balance, 0);
    }

    function testFuzz_buyFeeExact(uint96 value, uint16 bps) public {
        bps = uint16(bound(bps, 0, 300));
        uint256 v = bound(value, 1e9, 50 ether);
        RushrCurveRouter r = new RushrCurveRouter(IPonsFactory(address(factory)), treasury, bps);
        uint256 before = treasury.balance;
        vm.prank(alice);
        r.buy{value: v}(address(token), 0, alice, deadline);
        assertEq(treasury.balance - before, (v * bps) / 10_000);
    }
}
