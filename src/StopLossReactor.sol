// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { ISystemContract } from "@reactive/src/interfaces/ISystemContract.sol";
import { IReactive } from "@reactive/src/interfaces/IReactive.sol";
import { AbstractReactive } from "@reactive/src/base/AbstractReactive.sol";

/// @title StopLossReactor
/// @notice Lives on Reactive Lasna. Watches `PriceUpdated` on the origin chain
///         and, when the price crosses a floor, asks the network to call the
///         executor on the destination chain.
///
/// This is the middle of the loop and the only part that has to be fast. The
/// origin emits whenever the market moves; the executor does whatever it does
/// once called. Between them sits exactly one decision — has the floor been
/// crossed — and the time to make it is the thing being measured.
///
/// The contract pays for its own reactive transactions, so it must hold a
/// balance before the first event arrives. The constructor is payable for that
/// reason.
///
/// Topping it up later is necessary but not sufficient, and the difference is
/// the sharpest thing this build learned. If the balance reaches zero while
/// events are still arriving, the network records the shortfall as a debt
/// against this address and suspends the subscription. Sending more funds does
/// not clear it: the system contract credits `msg.sender`, so paying from an
/// EOA credits the EOA, and `AbstractPayer._coverDebt()` is `internal`. Only
/// this contract can pay what this contract owes, so a reactor with no way to
/// call it is finished at any balance -- which is exactly what happened to the
/// first deployment, recorded in NOTES-reactor-debt.md. Hence `coverDebt()`
/// below.
contract StopLossReactor is AbstractReactive {
    /// @notice Reaction recorded on the reactive network.
    /// @dev `reactedAt` is t1 of the measurement. `originBlock` comes from the
    ///      LogRecord, which carries a block number but no timestamp, so the
    ///      origin time has to be resolved off-chain by looking that block up.
    event Reacted(
        uint256 indexed seq,
        uint256 price,
        uint256 originBlock,
        uint256 reactedAt,
        bool triggered
    );

    /// @notice Emitted when a callback has been requested, before it is delivered.
    event CallbackRequested(uint256 indexed seq, uint256 price);

    /// @notice Emitted when this contract has paid off its debt to the network.
    /// @param amount Debt cleared, in the reactive network native token.
    event DebtCovered(uint256 amount);

    /// @notice Origin chain being watched.
    uint256 public immutable ORIGIN_CHAIN_ID;

    /// @notice Destination chain for callbacks.
    uint256 public immutable DESTINATION_CHAIN_ID;

    /// @notice The price feed being watched on the origin chain.
    address public immutable ORIGIN_FEED;

    /// @notice The executor being called on the destination chain.
    address public immutable EXECUTOR;

    /// @notice Price at or below which the stop fires.
    uint256 public immutable FLOOR;

    /// @notice Gas forwarded to the callback.
    uint64 public constant CALLBACK_GAS_LIMIT = 300_000;

    /// @notice `keccak256("PriceUpdated(bytes32,uint256,uint256)")`.
    uint256 public constant PRICE_UPDATED_TOPIC_0 =
        uint256(keccak256("PriceUpdated(bytes32,uint256,uint256)"));

    /// @notice Number of reactions seen, triggered or not.
    uint256 public reactions;

    /// @notice Number of callbacks requested.
    uint256 public triggers;

    /// @notice A constructor address was zero.
    /// @dev Worth rejecting rather than tolerating: both addresses are
    ///      immutable, so a zero one cannot be corrected afterwards, and the
    ///      failure is silent. A zero feed subscribes to a contract that emits
    ///      nothing, and a zero executor sends every callback into nowhere
    ///      while the reactor keeps paying for them and reporting success.
    error ZeroAddress(string field);

    /// @param originChainId_ Chain the feed lives on.
    /// @param originFeed_ The PriceFeed address.
    /// @param destinationChainId_ Chain the executor lives on.
    /// @param executor_ The StopLossExecutor address.
    /// @param floor_ Price at or below which to fire.
    constructor(
        uint256 originChainId_,
        address originFeed_,
        uint256 destinationChainId_,
        address executor_,
        uint256 floor_
    ) payable {
        if (originFeed_ == address(0)) revert ZeroAddress("originFeed");
        if (executor_ == address(0)) revert ZeroAddress("executor");

        ORIGIN_CHAIN_ID = originChainId_;
        ORIGIN_FEED = originFeed_;
        DESTINATION_CHAIN_ID = destinationChainId_;
        EXECUTOR = executor_;
        FLOOR = floor_;

        // One subscription: this feed, this event. Topics 1-3 stay open, so
        // every pair the feed publishes arrives and the filtering happens in
        // react(). Narrowing topic1 to a single pair would be cheaper per
        // event, but it would also mean a redeploy to watch a second pair.
        SYSTEM.subscribe(
            originChainId_,
            originFeed_,
            PRICE_UPDATED_TOPIC_0,
            REACTIVE_IGNORE,
            REACTIVE_IGNORE,
            REACTIVE_IGNORE
        );
    }

    /// @inheritdoc IReactive
    function react(LogRecord calldata log_) external onlySystem {
        // `data` holds the non-indexed parameters only: price and seq. `pair`
        // was indexed, so it is in topic1 rather than in data.
        (uint256 price, uint256 seq) = abi.decode(log_.data, (uint256, uint256));

        bool triggered = price <= FLOOR;
        unchecked { ++reactions; }

        emit Reacted(seq, price, log_.blockNumber, block.timestamp, triggered);

        if (!triggered) return;

        unchecked { ++triggers; }
        emit CallbackRequested(seq, price);

        // The first argument of the callback is overwritten by the proxy with
        // this contract's address, so it is declared and passed as a
        // placeholder. Anything put there is discarded.
        bytes memory payload = abi.encodeWithSignature(
            "executeStop(address,bytes32,uint256,uint256)",
            address(0),
            bytes32(log_.topic1),
            price,
            seq
        );

        SYSTEM.requestCallbackV_1_0(
            ISystemContract.CallbackConfiguration_V_1_0({
                chainId: DESTINATION_CHAIN_ID,
                recipient: EXECUTOR,
                gasLimit: CALLBACK_GAS_LIMIT,
                payload: payload
            })
        );
    }

    /// @notice The outstanding debt this contract owes the reactive network.
    /// @dev Zero in normal operation. Any other value means reactive
    ///      transactions have gone unpaid and the subscription is suspended,
    ///      so no further events arrive until `coverDebt()` clears it.
    ///      Exposed because the off-chain harness has to be able to see this
    ///      coming: a view is the difference between stopping a run early and
    ///      finding out afterwards that the deployment is gone.
    function debt() external view returns (uint256) {
        return _SERVICE_PROVIDER.debt(address(this));
    }

    /// @notice Pay off the outstanding debt and resume the subscription.
    /// @dev Permissionless on purpose, and worth saying why, because an access
    ///      check looks like the safer default here.
    ///
    ///      The amount is read from the service provider rather than supplied
    ///      by the caller, and the recipient is the immutable
    ///      `_SERVICE_PROVIDER`. So all a caller can do is move this
    ///      contract funds to the one address they were always destined for,
    ///      in the exact amount already owed. No choice is left to abuse.
    ///
    ///      An owner-gated version would be strictly worse: it adds a key that
    ///      can be lost, and losing it reintroduces the very failure this
    ///      function exists to undo.
    ///
    ///      Reverts with `InsufficientFunds` if the balance cannot cover the
    ///      debt. That is the honest outcome -- a partial payment does not
    ///      resume the subscription, so there is nothing to gain by taking one.
    function coverDebt() external {
        // Emitted before the transfer, not after. `_coverDebt()` calls out to
        // the service provider, and a log written after an external call can
        // be reordered relative to whatever that call emits. A revert in the
        // transfer rolls this event back with it, so emitting first costs
        // nothing in correctness and keeps the ordering unambiguous.
        uint256 amount = _SERVICE_PROVIDER.debt(address(this));
        emit DebtCovered(amount);
        _coverDebt();
    }
}
