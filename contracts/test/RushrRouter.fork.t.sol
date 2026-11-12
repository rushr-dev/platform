// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {RushrRouter, IUniversalRouter, IERC20R} from "../src/RushrRouter.sol";

interface IPositionManager {
    function poolKeys(bytes25 id) external view returns (address, address, uint24, int24, address);
}

/// @notice End-to-end against a local fork of Robinhood Chain: real Universal Router v2.1.2, real
///         Uniswap v2/v3/v4 pools (PONS) and a lift.fun-hooked v4 pool. Nothing is broadcast.
///         Skipped unless ROBINHOOD_RPC_URL is set.
contract RushrRouterForkTest is Test {
    IUniversalRouter constant UR = IUniversalRouter(0x204FAca1764B154221e35c0d20aBb3c525710498);
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant PONS = 0x39dBED3a2bd333467115dE45665cC57F813C4571;
    address constant LIFT_TOKEN = 0x8801A9F7f9F08bA843f1Af0E9832026201D60087;
    bytes32 constant LIFT_POOL = 0x849aa6e22c39445c22e2478de1bcfb77d0feeb3fde738511fc08405e7cf5929c;
    address constant POSM = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;
    address constant LIFT_HOOK = 0x2c668601193e4A081DD82604785e436AFf6a2aCC;

    RushrRouter router;
    address treasury = makeAddr("treasury");
    address guardian = makeAddr("guardian");
    address operator = makeAddr("operator");
    address trader = makeAddr("trader");
    bool noFork;

    function setUp() public {
        string memory rpc = vm.envOr("ROBINHOOD_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            noFork = true;
            return;
        }
        vm.createSelectFork(rpc);
        address[] memory hooks = new address[](1);
        hooks[0] = address(0);
        router = new RushrRouter(UR, WETH, treasury, 50, 45, guardian, operator, 1 hours, hooks);
        vm.deal(trader, 10 ether);
    }

    function _r(RushrRouter.Kind kind, address token, address quote, uint24 fee, int24 ts, address hooks)
        internal
        pure
        returns (RushrRouter.Route memory)
    {
        return RushrRouter.Route({kind: kind, token: token, quote: quote, fee: fee, tickSpacing: ts, hooks: hooks});
    }

    function _routes() internal pure returns (RushrRouter.Route[3] memory rs) {
        rs[0] = _r(RushrRouter.Kind.V3, PONS, WETH, 3000, 0, address(0));
        rs[1] = _r(RushrRouter.Kind.V2, PONS, WETH, 0, 0, address(0));
        rs[2] = _r(RushrRouter.Kind.V4, PONS, address(0), 3000, 60, address(0));
    }

    function _allow(RushrRouter.Route memory r) internal {
        bytes32 key = router.poolKeyOf(r);
        vm.prank(operator);
        router.queueSellPool(key);
        vm.warp(block.timestamp + 1 hours);
        router.activateSellPool(key);
    }

    /// Buy then sell through each pool family, with exact fees and nothing left behind.
    function test_fork_buyAndSellEveryKind() public {
        if (noFork) return;
        RushrRouter.Route[3] memory rs = _routes();
        for (uint256 i; i < rs.length; ++i) {
            uint256 snap = vm.snapshotState();
            _roundTrip(rs[i], false);
            vm.revertToState(snap);
        }
    }

    function test_fork_referredRates() public {
        if (noFork) return;
        _roundTrip(_routes()[0], true);
    }

    function _roundTrip(RushrRouter.Route memory r, bool referred) internal {
        uint256 bps = referred ? 45 : 50;
        uint256 urToken0 = IERC20R(r.token).balanceOf(address(UR));
        uint256 urWeth0 = IERC20R(WETH).balanceOf(address(UR));
        uint256 urEth0 = address(UR).balance;

        vm.prank(trader);
        uint256 bought = router.buy{value: 0.01 ether}(r, 1, block.timestamp + 60, referred);
        assertGt(bought, 0, "bought");
        assertEq(IERC20R(r.token).balanceOf(trader), bought, "tokens to trader");
        assertEq(treasury.balance, (0.01 ether * bps) / 10_000, "buy fee exact");
        assertEq(trader.balance, 10 ether - 0.01 ether, "trader paid exactly the input");

        _allow(r);
        vm.startPrank(trader);
        (bool ok,) = r.token.call(abi.encodeWithSignature("approve(address,uint256)", address(router), bought));
        assertTrue(ok);
        uint256 feeBefore = treasury.balance;
        uint256 ethBefore = trader.balance;
        uint256 out = router.sell(r, bought, 1, block.timestamp + 60, referred);
        vm.stopPrank();
        uint256 sellFee = treasury.balance - feeBefore;
        assertEq(trader.balance - ethBefore, out, "ETH to trader");
        assertEq(sellFee, ((out + sellFee) * bps) / 10_000, "sell fee exact");
        assertGt(out, 0.0095 ether, "round trip loses only fees and impact");

        // Nothing stays in our router, and the Universal Router ends where it started.
        assertEq(address(router).balance, 0);
        assertEq(IERC20R(r.token).balanceOf(address(router)), 0);
        assertEq(IERC20R(r.token).balanceOf(address(UR)), urToken0);
        assertEq(IERC20R(WETH).balanceOf(address(UR)), urWeth0);
        assertEq(address(UR).balance, urEth0);
    }

    function test_fork_minOutEnforcedOnBuyAndSell() public {
        if (noFork) return;
        RushrRouter.Route memory r = _routes()[0];
        uint256 snap = vm.snapshotState();
        vm.prank(trader);
        uint256 out = router.buy{value: 0.01 ether}(r, 1, block.timestamp + 60, false);
        vm.revertToState(snap);
        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(RushrRouter.SlippageExceeded.selector, out, out + 1));
        router.buy{value: 0.01 ether}(r, out + 1, block.timestamp + 60, false);

        vm.prank(trader);
        uint256 bought = router.buy{value: 0.01 ether}(r, out, block.timestamp + 60, false);
        vm.startPrank(trader);
        (bool ok,) = PONS.call(abi.encodeWithSignature("approve(address,uint256)", address(router), bought));
        assertTrue(ok);
        vm.expectRevert(); // far above any possible output
        router.sellAnyPool(r, bought, 1 ether, block.timestamp + 60, false);
        vm.stopPrank();
    }

    /// The server-signer path can't sell into a pool that hasn't cleared the timelock; the user path can.
    function test_fork_sellAllowlistAndUserExit() public {
        if (noFork) return;
        RushrRouter.Route memory r = _routes()[1];
        vm.startPrank(trader);
        uint256 bought = router.buy{value: 0.01 ether}(r, 1, block.timestamp + 60, false);
        (bool ok,) = PONS.call(abi.encodeWithSignature("approve(address,uint256)", address(router), bought));
        assertTrue(ok);
        vm.expectRevert(abi.encodeWithSelector(RushrRouter.PoolNotAllowed.selector, router.poolKeyOf(r)));
        router.sell(r, bought, 1, block.timestamp + 60, false);
        vm.stopPrank();

        vm.prank(guardian);
        router.setPaused(true);
        vm.prank(trader);
        uint256 out = router.sellAnyPool(r, bought, 1, block.timestamp + 60, false);
        assertGt(out, 0, "user can always exit, even while paused");
    }

    /// v4 pool with a launchpad hook: refused until the hook clears the timelock, then works.
    function test_fork_hookedPoolNeedsAllowlistedHook() public {
        if (noFork) return;
        (address c0, address c1, uint24 fee, int24 ts, address hooks) =
            IPositionManager(POSM).poolKeys(bytes25(LIFT_POOL));
        assertEq(hooks, LIFT_HOOK);
        address quote = c0 == LIFT_TOKEN ? c1 : c0;
        RushrRouter.Route memory r = _r(RushrRouter.Kind.V4, LIFT_TOKEN, quote, fee, ts, hooks);
        assertEq(router.poolKeyOf(r), LIFT_POOL, "route maps to the live pool id");

        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(RushrRouter.HookNotAllowed.selector, LIFT_HOOK));
        router.buy{value: 0.01 ether}(r, 1, block.timestamp + 60, false);

        vm.prank(operator);
        router.queueHook(LIFT_HOOK);
        vm.warp(block.timestamp + 1 hours);
        router.activateHook(LIFT_HOOK);

        vm.prank(trader);
        uint256 bought = router.buy{value: 0.01 ether}(r, 1, block.timestamp + 60, false);
        assertEq(IERC20R(LIFT_TOKEN).balanceOf(trader), bought);
        assertEq(treasury.balance, 0.00005 ether);

        vm.startPrank(trader);
        (bool ok,) = LIFT_TOKEN.call(abi.encodeWithSignature("approve(address,uint256)", address(router), bought));
        assertTrue(ok);
        uint256 out = router.sellAnyPool(r, bought, 1, block.timestamp + 60, false);
        vm.stopPrank();
        assertGt(out, 0);
        assertEq(address(router).balance, 0);
    }
}
