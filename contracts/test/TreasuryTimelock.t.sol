// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {TreasuryTimelock} from "../src/TreasuryTimelock.sol";
import {RushrPonsRouter, IPonsFactory} from "../src/RushrPonsRouter.sol";
import {RushrRouter, IUniversalRouter} from "../src/RushrRouter.sol";
import {MockToken, MockCurve, MockFactory} from "./Mocks.sol";

/// @notice Treasury changes: guardian queues, anyone activates after the delay, guardian cancels.
///         No owner and no instant path. Fees follow the treasury after activation.
contract TreasuryTimelockTest is Test {
    event TreasuryQueued(address indexed treasury, uint256 eta);
    event TreasuryChanged(address indexed previous, address indexed treasury);
    event TreasuryCancelled(address indexed treasury);

    // The treasury (currently a single EOA, moving to a Safe) and a stand-in for that Safe.
    address constant TREASURY_EOA = 0x447a590b70cd55Cc6B62CEaf79D4c6c09A955E40;
    address safe = makeAddr("safe");
    address guardian = makeAddr("guardian");
    address alice = makeAddr("alice");
    uint256 constant DELAY = 1 days;

    MockToken token;
    MockCurve curve;
    MockFactory factory;
    RushrPonsRouter pons;
    RushrRouter router;

    function setUp() public {
        token = new MockToken();
        curve = new MockCurve{value: 10 ether}(token, 2 ether, 1e27);
        token.mint(address(curve), 1e27);
        factory = new MockFactory();
        factory.set(address(token), address(curve));
        pons = new RushrPonsRouter(IPonsFactory(address(factory)), TREASURY_EOA, 50, 45, guardian, DELAY);
        address[] memory hooks = new address[](0);
        router = new RushrRouter(
            IUniversalRouter(address(0xBEEF)), address(0xE7), TREASURY_EOA, 50, 45, guardian, guardian, DELAY, hooks
        );
        vm.deal(alice, 10 ether);
    }

    function _routers() internal view returns (TreasuryTimelock[2] memory r) {
        r[0] = pons;
        r[1] = router;
    }

    function test_startsAtTreasuryEoa() public view {
        TreasuryTimelock[2] memory rs = _routers();
        for (uint256 i; i < 2; ++i) {
            assertEq(rs[i].treasury(), TREASURY_EOA);
            assertEq(rs[i].guardian(), guardian);
            assertEq(rs[i].delay(), DELAY);
            assertEq(rs[i].pendingTreasury(), address(0));
        }
    }

    function test_onlyGuardianQueuesAndCancels() public {
        TreasuryTimelock[2] memory rs = _routers();
        for (uint256 i; i < 2; ++i) {
            vm.prank(alice);
            vm.expectRevert(TreasuryTimelock.NotGuardian.selector);
            rs[i].queueTreasury(alice);

            vm.prank(guardian);
            vm.expectRevert(TreasuryTimelock.ZeroAddress.selector);
            rs[i].queueTreasury(address(0));

            vm.prank(guardian);
            vm.expectRevert(TreasuryTimelock.NoPendingTreasury.selector);
            rs[i].cancelTreasury();
        }
    }

    function test_queueActivateAfterDelay() public {
        TreasuryTimelock[2] memory rs = _routers();
        for (uint256 i; i < 2; ++i) {
            uint256 snap = vm.snapshotState();
            uint256 eta = block.timestamp + DELAY;
            vm.expectEmit(true, false, false, true, address(rs[i]));
            emit TreasuryQueued(safe, eta);
            vm.prank(guardian);
            rs[i].queueTreasury(safe);
            assertEq(rs[i].pendingTreasury(), safe);
            assertEq(rs[i].pendingTreasuryEta(), eta);
            assertEq(rs[i].treasury(), TREASURY_EOA, "no instant change");

            vm.expectRevert(abi.encodeWithSelector(TreasuryTimelock.TreasuryTooEarly.selector, eta));
            rs[i].activateTreasury();
            vm.warp(eta - 1);
            vm.expectRevert(abi.encodeWithSelector(TreasuryTimelock.TreasuryTooEarly.selector, eta));
            rs[i].activateTreasury();

            vm.warp(eta);
            vm.expectEmit(true, true, false, false, address(rs[i]));
            emit TreasuryChanged(TREASURY_EOA, safe);
            vm.prank(alice); // anyone can activate once the delay has passed
            rs[i].activateTreasury();
            assertEq(rs[i].treasury(), safe);
            assertEq(rs[i].pendingTreasury(), address(0));
            assertEq(rs[i].pendingTreasuryEta(), 0);

            vm.expectRevert(TreasuryTimelock.NoPendingTreasury.selector);
            rs[i].activateTreasury();
            vm.revertToState(snap);
        }
    }

    function test_cancelAndRequeueRestartsDelay() public {
        TreasuryTimelock[2] memory rs = _routers();
        for (uint256 i; i < 2; ++i) {
            vm.prank(guardian);
            rs[i].queueTreasury(alice);
            vm.expectEmit(true, false, false, false, address(rs[i]));
            emit TreasuryCancelled(alice);
            vm.prank(guardian);
            rs[i].cancelTreasury();
            vm.warp(block.timestamp + DELAY);
            vm.expectRevert(TreasuryTimelock.NoPendingTreasury.selector);
            rs[i].activateTreasury();
            assertEq(rs[i].treasury(), TREASURY_EOA);

            // A new queue replaces the old one and restarts the clock.
            vm.prank(guardian);
            rs[i].queueTreasury(alice);
            vm.warp(block.timestamp + DELAY / 2);
            vm.prank(guardian);
            rs[i].queueTreasury(safe);
            vm.warp(block.timestamp + DELAY / 2);
            vm.expectRevert(
                abi.encodeWithSelector(TreasuryTimelock.TreasuryTooEarly.selector, block.timestamp + DELAY / 2)
            );
            rs[i].activateTreasury();
            vm.warp(block.timestamp + DELAY / 2);
            rs[i].activateTreasury();
            assertEq(rs[i].treasury(), safe);
        }
    }

    function test_feesFollowTheTreasuryAfterActivation() public {
        uint256 eoaBefore = TREASURY_EOA.balance;
        vm.prank(alice);
        uint256 bought = pons.buy{value: 1 ether}(address(token), 0, alice, block.timestamp + 60, false);
        assertEq(TREASURY_EOA.balance - eoaBefore, 0.005 ether, "fee to the EOA before the change");

        vm.prank(guardian);
        pons.queueTreasury(safe);
        // While queued, fees still go to the current treasury.
        vm.prank(alice);
        pons.buy{value: 1 ether}(address(token), 0, alice, block.timestamp + 60, false);
        assertEq(TREASURY_EOA.balance - eoaBefore, 0.01 ether);
        assertEq(safe.balance, 0);

        vm.warp(block.timestamp + DELAY);
        pons.activateTreasury();
        vm.prank(alice);
        pons.buy{value: 1 ether}(address(token), 0, alice, block.timestamp + 60, false);
        assertEq(safe.balance, 0.005 ether, "buy fee to the new treasury");
        assertEq(TREASURY_EOA.balance - eoaBefore, 0.01 ether, "old treasury gets nothing more");

        vm.startPrank(alice);
        token.approve(address(pons), bought);
        uint256 out = pons.sell(address(token), bought, 0, alice, block.timestamp + 60, false);
        vm.stopPrank();
        uint256 sellFee = safe.balance - 0.005 ether;
        assertEq(sellFee, ((out + sellFee) * 50) / 10_000, "sell fee to the new treasury");
    }

    function test_constructorRejectsBadTimelockParams() public {
        vm.expectRevert(TreasuryTimelock.DelayTooShort.selector);
        new RushrPonsRouter(IPonsFactory(address(factory)), TREASURY_EOA, 50, 45, guardian, 5 minutes);
        vm.expectRevert(TreasuryTimelock.ZeroAddress.selector);
        new RushrPonsRouter(IPonsFactory(address(factory)), TREASURY_EOA, 50, 45, address(0), DELAY);
        vm.expectRevert(TreasuryTimelock.ZeroAddress.selector);
        new RushrPonsRouter(IPonsFactory(address(factory)), address(0), 50, 45, guardian, DELAY);
    }
}
