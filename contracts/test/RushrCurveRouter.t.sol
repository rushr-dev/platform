// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {RushrCurveRouter, IPonsFactory} from "../src/RushrCurveRouter.sol";
import {MockToken, MockCurve, MockFactory, RejectingTreasury} from "./Mocks.sol";

contract RushrCurveRouterTest is Test {
    uint16 constant FEE = 50; // 0.5%
    uint16 constant REF_FEE = 45; // 0.45% for referred traders

    MockToken token;
    MockCurve curve;
    MockFactory factory;
    RushrCurveRouter router;
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    uint256 deadline;

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

    function setUp() public {
        token = new MockToken();
        curve = new MockCurve{value: 10 ether}(token, 2 ether, 1e27);
        token.mint(address(curve), 1e27);
        factory = new MockFactory();
        factory.set(address(token), address(curve));
        router = new RushrCurveRouter(IPonsFactory(address(factory)), treasury, FEE, REF_FEE);
        vm.deal(alice, 100 ether);
        deadline = block.timestamp + 300;
    }

    function _curveOut(uint256 toCurve) internal view returns (uint256) {
        uint256 net = toCurve - (toCurve * curve.feeBps()) / 10_000;
        return (curve.tokenReserve() * net) / (curve.quoteReserve() + net);
    }

    // ---------------------------------------------------------------- construction

    function test_constructorValidates() public {
        vm.expectRevert(RushrCurveRouter.FeeTooHigh.selector);
        new RushrCurveRouter(IPonsFactory(address(factory)), treasury, 301, 0);
        vm.expectRevert(RushrCurveRouter.FeeTooHigh.selector);
        new RushrCurveRouter(IPonsFactory(address(factory)), treasury, 50, 51); // referral rate above base
        vm.expectRevert(RushrCurveRouter.ZeroAddress.selector);
        new RushrCurveRouter(IPonsFactory(address(factory)), address(0), 50, 45);
        vm.expectRevert(RushrCurveRouter.ZeroAddress.selector);
        new RushrCurveRouter(IPonsFactory(address(0)), treasury, 50, 45);
        assertEq(router.feeBps(), 50);
        assertEq(router.referralFeeBps(), 45);
        assertEq(router.treasury(), treasury);
    }

    // ---------------------------------------------------------------- exact fee math

    function test_buyTakesFeeFromInput() public {
        uint256 expectedOut = _curveOut(1 ether - 0.005 ether);
        vm.expectEmit(true, true, true, true, address(router));
        emit Trade(alice, address(token), alice, true, false, 1 ether, expectedOut, 0.005 ether, 0);
        vm.prank(alice);
        uint256 out = router.buy{value: 1 ether}(address(token), 0, alice, deadline, false);
        assertEq(out, expectedOut);
        assertEq(treasury.balance, 0.005 ether, "fee = 0.5% of input");
        assertEq(token.balanceOf(alice), out);
        assertEq(alice.balance, 99 ether);
        assertEq(address(router).balance, 0, "router holds nothing");
        assertEq(token.balanceOf(address(router)), 0);
    }

    function test_referredBuyPaysReferralRate() public {
        vm.prank(alice);
        router.buy{value: 1 ether}(address(token), 0, alice, deadline, true);
        assertEq(treasury.balance, 0.0045 ether, "fee = 0.45% of input");
    }

    function test_sellTakesFeeFromOutput() public {
        vm.startPrank(alice);
        uint256 bought = router.buy{value: 1 ether}(address(token), 0, alice, deadline, false);
        uint256 feeBefore = treasury.balance;
        uint256 ethBefore = alice.balance;
        token.approve(address(router), bought);
        uint256 out = router.sell(address(token), bought, 0, alice, deadline, false);
        vm.stopPrank();
        uint256 fee = treasury.balance - feeBefore;
        assertEq(alice.balance - ethBefore, out);
        assertEq(fee, ((out + fee) * FEE) / 10_000, "fee = 0.5% of gross output");
        assertEq(token.allowance(address(router), address(curve)), 0, "approval reset");
        assertEq(address(router).balance, 0);
        assertEq(token.balanceOf(alice), 0);
    }

    function test_referredSellPaysReferralRate() public {
        vm.startPrank(alice);
        uint256 bought = router.buy{value: 1 ether}(address(token), 0, alice, deadline, true);
        uint256 feeBefore = treasury.balance;
        token.approve(address(router), bought);
        uint256 out = router.sell(address(token), bought, 0, alice, deadline, true);
        vm.stopPrank();
        uint256 fee = treasury.balance - feeBefore;
        assertEq(fee, ((out + fee) * REF_FEE) / 10_000);
    }

    function testFuzz_buyFeeExact(uint96 value, uint16 bps, bool referred) public {
        bps = uint16(bound(bps, 0, 300));
        uint16 refBps = bps / 2;
        uint256 v = bound(value, 1e9, 50 ether);
        RushrCurveRouter r = new RushrCurveRouter(IPonsFactory(address(factory)), treasury, bps, refBps);
        uint256 before = treasury.balance;
        vm.prank(alice);
        r.buy{value: v}(address(token), 0, alice, deadline, referred);
        assertEq(treasury.balance - before, (v * (referred ? refBps : bps)) / 10_000);
        assertEq(address(r).balance, 0);
    }

    // ---------------------------------------------------------------- refunds (graduation cap)

    function test_graduatingBuyRefundsUnusedEthAndChargesFeeOnSpentOnly() public {
        // Room for 1 ETH of net quote before graduation; send 5 ETH.
        curve.setThreshold(1.5 ether, 0.5 ether);
        uint256 aliceBefore = alice.balance;
        vm.prank(alice);
        uint256 out = router.buy{value: 5 ether}(address(token), 0, alice, deadline, false);
        assertTrue(curve.graduated());
        assertGt(out, 0);

        uint256 room = 1 ether;
        uint256 keep = 10_000 - curve.feeBps();
        uint256 spentOnCurve = (room * 10_000 + keep - 1) / keep;
        uint256 fee = (spentOnCurve * FEE) / (10_000 - FEE);
        assertEq(treasury.balance, fee, "fee only on ETH actually spent");
        assertEq(aliceBefore - alice.balance, spentOnCurve + fee, "user pays spent + fee, rest refunded");
        assertEq(address(router).balance, 0, "no ETH left behind");
        // Effective rate on what the user actually paid stays at (or 1 wei under) 0.5%.
        assertApproxEqAbs(fee, ((spentOnCurve + fee) * FEE) / 10_000, 1);
    }

    function testFuzz_graduatingBuyNeverStrandsEth(uint96 value, uint64 room) public {
        uint256 v = bound(value, 0.01 ether, 50 ether);
        uint256 r = bound(room, 0.001 ether, 20 ether);
        curve.setThreshold(0.5 ether + r, 0.5 ether);
        uint256 aliceBefore = alice.balance;
        vm.prank(alice);
        router.buy{value: v}(address(token), 0, alice, deadline, false);
        uint256 paid = aliceBefore - alice.balance;
        assertEq(address(router).balance, 0);
        assertLe(treasury.balance, (paid * FEE) / 10_000 + 1);
        assertLe(paid, v);
    }

    // ---------------------------------------------------------------- slippage

    function test_buySlippage() public {
        uint256 expected = _curveOut(0.995 ether);
        vm.prank(alice);
        vm.expectRevert(); // curve or router check
        router.buy{value: 1 ether}(address(token), expected + 1, alice, deadline, false);
        vm.prank(alice);
        router.buy{value: 1 ether}(address(token), expected, alice, deadline, false); // exact minimum passes
    }

    function test_buyChecksReceivedAfterTransferTax() public {
        token.setTax(500, address(0)); // 5% on every transfer
        uint256 curveOut = _curveOut(0.995 ether);
        uint256 min = (curveOut * 9_700) / 10_000; // between what the curve sends and what alice gets
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RushrCurveRouter.SlippageExceeded.selector, curveOut - (curveOut * 500) / 10_000, min));
        router.buy{value: 1 ether}(address(token), min, alice, deadline, false);
    }

    function test_sellSlippageOnNet() public {
        vm.startPrank(alice);
        uint256 bought = router.buy{value: 1 ether}(address(token), 0, alice, deadline, false);
        token.approve(address(router), bought);
        uint256 snap = vm.snapshotState();
        uint256 out = router.sell(address(token), bought, 0, alice, deadline, false);
        vm.revertToState(snap);
        vm.expectRevert(abi.encodeWithSelector(RushrCurveRouter.SlippageExceeded.selector, out, out + 1));
        router.sell(address(token), bought, out + 1, alice, deadline, false);
        router.sell(address(token), bought, out, alice, deadline, false); // net minimum exactly met
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- token edge cases

    function test_sellWithTransferTaxSellsWhatArrived() public {
        vm.prank(alice);
        uint256 bought = router.buy{value: 1 ether}(address(token), 0, alice, deadline, false);
        token.setTax(1_000, address(curve)); // 10% on user->router; curve transfers exempt
        vm.startPrank(alice);
        token.approve(address(router), bought);
        router.sell(address(token), bought, 0, alice, deadline, false);
        vm.stopPrank();
        assertEq(token.balanceOf(address(router)), 0, "nothing stuck in the router");
    }

    function test_unsoldTokensReturnToSeller() public {
        vm.prank(alice);
        uint256 bought = router.buy{value: 1 ether}(address(token), 0, alice, deadline, false);
        curve.setMaxSell(bought / 4);
        vm.startPrank(alice);
        token.approve(address(router), bought);
        router.sell(address(token), bought, 0, alice, deadline, false);
        vm.stopPrank();
        assertEq(token.balanceOf(alice), bought - bought / 4);
        assertEq(token.balanceOf(address(router)), 0);
    }

    // ---------------------------------------------------------------- guards

    function test_unknownAndGraduatedCurves() public {
        MockToken other = new MockToken();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RushrCurveRouter.UnknownCurve.selector, address(other)));
        router.buy{value: 1 ether}(address(other), 0, alice, deadline, false);

        curve.setGraduated(true);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RushrCurveRouter.CurveGraduated.selector, address(token)));
        router.buy{value: 1 ether}(address(token), 0, alice, deadline, false);
    }

    function test_deadlineZeroAmountZeroRecipient() public {
        vm.prank(alice);
        vm.expectRevert(RushrCurveRouter.DeadlinePassed.selector);
        router.buy{value: 1 ether}(address(token), 0, alice, block.timestamp - 1, false);
        vm.prank(alice);
        vm.expectRevert(RushrCurveRouter.ZeroAmount.selector);
        router.buy{value: 0}(address(token), 0, alice, deadline, false);
        vm.prank(alice);
        vm.expectRevert(RushrCurveRouter.ZeroAddress.selector);
        router.buy{value: 1 ether}(address(token), 0, address(0), deadline, false);
        vm.prank(alice);
        vm.expectRevert(RushrCurveRouter.ZeroAmount.selector);
        router.sell(address(token), 0, 0, alice, deadline, false);
    }

    function test_sellWithoutApprovalReverts() public {
        vm.prank(alice);
        uint256 bought = router.buy{value: 1 ether}(address(token), 0, alice, deadline, false);
        vm.prank(alice);
        vm.expectRevert(RushrCurveRouter.TokenCallFailed.selector);
        router.sell(address(token), bought, 0, alice, deadline, false);
    }

    function test_rejectsStrayEth() public {
        vm.prank(alice);
        (bool ok,) = address(router).call{value: 1 ether}("");
        assertFalse(ok);
    }

    function test_reentrancyBlocked() public {
        curve.setReenter(address(router), abi.encodeCall(RushrCurveRouter.buy, (address(token), 0, alice, deadline, false)));
        vm.prank(alice);
        vm.expectRevert(RushrCurveRouter.Reentrancy.selector);
        router.buy{value: 1 ether}(address(token), 0, alice, deadline, false);
    }

    function test_failingTreasuryRevertsTrade() public {
        RushrCurveRouter r = new RushrCurveRouter(IPonsFactory(address(factory)), address(new RejectingTreasury()), FEE, REF_FEE);
        vm.prank(alice);
        vm.expectRevert(RushrCurveRouter.EthTransferFailed.selector);
        r.buy{value: 1 ether}(address(token), 0, alice, deadline, false);
    }

    function test_zeroFee() public {
        RushrCurveRouter r = new RushrCurveRouter(IPonsFactory(address(factory)), treasury, 0, 0);
        vm.prank(alice);
        r.buy{value: 1 ether}(address(token), 0, alice, deadline, false);
        assertEq(treasury.balance, 0);
    }
}
