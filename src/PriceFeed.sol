// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @title PriceFeed
/// @notice The origin of the loop: a price source on Base Sepolia whose updates
///         the reactive contract watches.
///
/// In production this role is played by whatever already emits the price — a
/// pool's `Swap`, an oracle's `AnswerUpdated`. It is a contract we control here
/// for one reason: **latency has to be sampled, not witnessed once.** A real
/// pool emits when it emits, so measuring a distribution would mean waiting
/// around and taking whatever arrives. Driving the origin ourselves means the
/// harness can fire a hundred updates and report percentiles instead of an
/// anecdote.
///
/// Nothing downstream depends on this being ours. The reactive contract
/// subscribes by (chainId, address, topic0), so pointing it at a real pool is a
/// change of constructor arguments, not of code.
contract PriceFeed {
    /// @notice A new price for `pair`.
    /// @dev `seq` is the measurement hook. Every update carries a monotonic
    ///      number that travels the whole loop — origin event, reaction,
    ///      callback — so a callback can be matched to the exact update that
    ///      caused it. Without it, matching means guessing by timestamp, which
    ///      is precisely the quantity being measured and so cannot be used to
    ///      establish itself.
    event PriceUpdated(bytes32 indexed pair, uint256 price, uint256 seq);

    /// @notice Number of updates pushed so far.
    uint256 public seq;

    /// @notice Last price seen for a pair.
    mapping(bytes32 => uint256) public priceOf;

    /// @notice Publish a price.
    /// @param pair_ Identifier of the pair, e.g. `bytes32("ETH/USD")`.
    /// @param price_ The price, in whatever fixed-point scale the deployment uses.
    /// @return seq_ The sequence number assigned to this update.
    function push(bytes32 pair_, uint256 price_) external returns (uint256 seq_) {
        seq_ = ++seq;
        priceOf[pair_] = price_;
        emit PriceUpdated(pair_, price_, seq_);
    }

    /// @notice The topic0 a subscriber needs. Exposed so deployment scripts read
    ///         it from the contract rather than recomputing the hash and risking
    ///         a signature that drifts from this source file.
    function priceUpdatedTopic0() external pure returns (uint256) {
        return uint256(keccak256("PriceUpdated(bytes32,uint256,uint256)"));
    }
}
