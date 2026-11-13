// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.26;

/// @title TreasuryTimelock
/// @notice Fee recipient that can change only through a timelock run by an immutable guardian (a
///         multisig). There is no owner and no instant path:
///         1. the guardian queues a new treasury (`queueTreasury`), which emits `TreasuryQueued` with its eta;
///         2. after the immutable `delay`, anyone activates it (`activateTreasury`), emitting `TreasuryChanged`;
///         3. until then the guardian can cancel (`cancelTreasury`).
///         Lets the treasury move from a single EOA to a Safe without redeploying, while every change
///         is public for the whole delay.
abstract contract TreasuryTimelock {
    uint256 public constant MIN_DELAY = 10 minutes;

    address public immutable guardian;
    uint256 public immutable delay;

    /// @notice Current fee recipient.
    address public treasury;
    /// @notice Queued fee recipient (address(0) if none) and the earliest activation time.
    address public pendingTreasury;
    uint256 public pendingTreasuryEta;

    event TreasuryQueued(address indexed treasury, uint256 eta);
    event TreasuryChanged(address indexed previous, address indexed treasury);
    event TreasuryCancelled(address indexed treasury);

    error ZeroAddress();
    error DelayTooShort();
    error NotGuardian();
    error NoPendingTreasury();
    error TreasuryTooEarly(uint256 eta);

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert NotGuardian();
        _;
    }

    constructor(address treasury_, address guardian_, uint256 delay_) {
        if (treasury_ == address(0) || guardian_ == address(0)) revert ZeroAddress();
        if (delay_ < MIN_DELAY) revert DelayTooShort();
        treasury = treasury_;
        guardian = guardian_;
        delay = delay_;
        emit TreasuryChanged(address(0), treasury_);
    }

    /// @notice Guardian: queue a new treasury (replaces any pending one and restarts the delay).
    function queueTreasury(address next) external onlyGuardian {
        if (next == address(0)) revert ZeroAddress();
        uint256 eta = block.timestamp + delay;
        pendingTreasury = next;
        pendingTreasuryEta = eta;
        emit TreasuryQueued(next, eta);
    }

    /// @notice Anyone: activate the queued treasury once its delay has passed.
    function activateTreasury() external {
        address next = pendingTreasury;
        if (next == address(0)) revert NoPendingTreasury();
        if (block.timestamp < pendingTreasuryEta) revert TreasuryTooEarly(pendingTreasuryEta);
        address previous = treasury;
        treasury = next;
        delete pendingTreasury;
        delete pendingTreasuryEta;
        emit TreasuryChanged(previous, next);
    }

    /// @notice Guardian: cancel the queued treasury.
    function cancelTreasury() external onlyGuardian {
        address next = pendingTreasury;
        if (next == address(0)) revert NoPendingTreasury();
        delete pendingTreasury;
        delete pendingTreasuryEta;
        emit TreasuryCancelled(next);
    }
}
