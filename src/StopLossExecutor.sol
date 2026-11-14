// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { IPayable } from "@reactive/src/interfaces/IPayable.sol";
import { AbstractCallback } from "@reactive/src/base/AbstractCallback.sol";

/// @title StopLossExecutor
/// @notice The end of the loop, on the destination chain. Receives the callback
///         the reactor requested and records the moment it landed.
///
/// In a real deployment this is where the position would actually be closed.
/// Here it records, because the point of this build is the measurement: what
/// matters is the timestamp of the block that executed this call, which is t2
/// and the end of the latency being measured. A swap in this function would add
/// its own variable cost to every sample and muddy the number.
///
/// The callback proxy bills this contract in the destination chain's native
/// token, so it must hold a balance. The constructor is payable for that;
/// `receive()` is inherited if it needs topping up later.
contract StopLossExecutor is AbstractCallback {
    /// @notice A stop executed.
    /// @dev `executedAt` is t2 of the measurement. `seq` matches it to the
    ///      origin update that caused it, which is what makes per-sample
    ///      latency computable rather than inferred.
    event StopExecuted(
        uint256 indexed seq,
        bytes32 indexed pair,
        uint256 price,
        uint256 executedAt
    );

    /// @notice Number of stops executed.
    uint256 public executions;

    /// @notice Sequence number of the most recent execution.
    uint256 public lastSeq;

    /// @param callbackProxy_ Callback proxy for this chain. Becomes the service
    ///        provider that bills this contract, and is immutable.
    /// @param reactor_ The StopLossReactor authorised to trigger callbacks here.
    constructor(IPayable callbackProxy_, address reactor_)
        payable
        AbstractCallback(callbackProxy_, reactor_)
    {}

    /// @notice Called by the proxy when the reactor's stop condition fires.
    /// @dev Two guards, both needed and guarding different things.
    ///      `onlyServiceProvider` checks that the *proxy* is calling, so an
    ///      arbitrary address cannot invoke this directly. `onlyCallbackSender`
    ///      checks *which reactive contract* asked, so another team's reactor
    ///      cannot drive this one through the same proxy. Dropping either one
    ///      leaves the function open to a different attacker.
    ///
    ///      `reactor_` is not a parameter the caller controls: the proxy
    ///      overwrites the first 160 bits of the payload with the requesting
    ///      reactive contract's address, whatever the reactor put there.
    /// @param reactor_ Injected by the proxy. Checked, never trusted.
    /// @param pair_ The pair whose price crossed.
    /// @param price_ The price that triggered the stop.
    /// @param seq_ Sequence number of the origin update.
    function executeStop(address reactor_, bytes32 pair_, uint256 price_, uint256 seq_)
        external
        onlyServiceProvider
        onlyCallbackSender(reactor_)
    {
        unchecked { ++executions; }
        lastSeq = seq_;
        emit StopExecuted(seq_, pair_, price_, block.timestamp);
    }
}
