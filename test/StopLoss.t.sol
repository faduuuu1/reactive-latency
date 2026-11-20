// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { Test } from "forge-std/Test.sol";
import { ISystemContract } from "@reactive/src/interfaces/ISystemContract.sol";
import { IReactive } from "@reactive/src/interfaces/IReactive.sol";
import { IPayable } from "@reactive/src/interfaces/IPayable.sol";
import { AbstractCallback } from "@reactive/src/base/AbstractCallback.sol";

import { PriceFeed } from "../src/PriceFeed.sol";
import { StopLossReactor } from "../src/StopLossReactor.sol";
import { StopLossExecutor } from "../src/StopLossExecutor.sol";

/// @notice Stands in for the Reactive system contract at 0x8888…8888.
/// @dev The real one is a network precompile-like fixture that does not exist
///      in a local EVM, and `AbstractReactive` hardcodes its address, so there
///      is nothing to inject. `vm.etch` puts this code at that address instead,
///      which is the only way to exercise `react()` without a live network.
contract MockSystem {
    struct Request {
        uint256 chainId;
        address recipient;
        uint64 gasLimit;
        bytes payload;
    }

    Request[] public requests;
    uint256 public subscribeCalls;

    function subscribe(uint256, address, uint256, uint256, uint256, uint256) external {
        ++subscribeCalls;
    }

    function unsubscribe(uint256, address, uint256, uint256, uint256, uint256) external {}

    function requestCallbackV_1_0(ISystemContract.CallbackConfiguration_V_1_0 memory config_)
        external
    {
        requests.push(
            Request(config_.chainId, config_.recipient, config_.gasLimit, config_.payload)
        );
    }

    function requestCount() external view returns (uint256) {
        return requests.length;
    }

    function lastPayload() external view returns (bytes memory) {
        return requests[requests.length - 1].payload;
    }

    /// @notice Debt the mock reports, and what it has actually been paid.
    /// @dev Settable because the interesting states are the ones the real
    ///      network only reaches after a contract has run out of funds, and a
    ///      hardcoded zero can never reach them. `received` is asserted on
    ///      rather than inferred from balances, so a test cannot pass on a
    ///      transfer that went somewhere else.
    uint256 public debtOwed;
    uint256 public received;

    function setDebt(uint256 amount_) external {
        debtOwed = amount_;
    }

    function debt(address) external view returns (uint256) {
        return debtOwed;
    }

    receive() external payable {
        received += msg.value;
    }
}

contract StopLossTest is Test {
    address internal constant SYSTEM_ADDR = 0x8888888888888888888888888888888888888888;

    uint256 internal constant ORIGIN_CHAIN = 84532; // Base Sepolia
    uint256 internal constant DEST_CHAIN = 84532;
    uint256 internal constant FLOOR = 2_000e18;
    bytes32 internal constant PAIR = bytes32("ETH/USD");

    PriceFeed internal feed;
    StopLossReactor internal reactor;
    StopLossExecutor internal executor;
    MockSystem internal system;

    address payable internal proxy = payable(makeAddr("callbackProxy"));

    function setUp() public {
        vm.etch(SYSTEM_ADDR, type(MockSystem).runtimeCode);
        system = MockSystem(payable(SYSTEM_ADDR));

        feed = new PriceFeed();
        executor = new StopLossExecutor(IPayable(proxy), address(this));
        reactor = new StopLossReactor(ORIGIN_CHAIN, address(feed), DEST_CHAIN, address(executor), FLOOR);
    }

    // --- the event signature the subscription depends on ---

    /// @dev The reactor hardcodes topic0 so it can be a constant. If the event
    ///      signature in PriceFeed ever changes, the subscription silently
    ///      matches nothing — no error, no events, just a reactor that never
    ///      fires. This test is the thing that would catch it.
    function test_topic0_matchesTheEventActuallyEmitted() public view {
        assertEq(
            reactor.PRICE_UPDATED_TOPIC_0(),
            feed.priceUpdatedTopic0(),
            "reactor subscribes to a topic the feed does not emit"
        );
        assertEq(
            reactor.PRICE_UPDATED_TOPIC_0(),
            uint256(keccak256("PriceUpdated(bytes32,uint256,uint256)"))
        );
    }

    function test_constructor_subscribesOnce() public view {
        assertEq(system.subscribeCalls(), 1);
    }

    function test_constructor_rejectsZeroAddresses() public {
        vm.expectRevert(abi.encodeWithSelector(StopLossReactor.ZeroAddress.selector, "originFeed"));
        new StopLossReactor(ORIGIN_CHAIN, address(0), DEST_CHAIN, address(executor), FLOOR);

        vm.expectRevert(abi.encodeWithSelector(StopLossReactor.ZeroAddress.selector, "executor"));
        new StopLossReactor(ORIGIN_CHAIN, address(feed), DEST_CHAIN, address(0), FLOOR);
    }

    // --- the feed ---

    function test_feed_assignsMonotonicSequence() public {
        assertEq(feed.push(PAIR, 2_500e18), 1);
        assertEq(feed.push(PAIR, 2_400e18), 2);
        assertEq(feed.push(PAIR, 2_300e18), 3);
        assertEq(feed.seq(), 3);
        assertEq(feed.priceOf(PAIR), 2_300e18);
    }

    // --- reacting ---

    /// @dev Deliberately makes no external calls. Building the record used to
    ///      read topic0 off the reactor, which is an external call, and
    ///      `vm.prank` only covers the *next* call - so the prank was spent on
    ///      the getter and `react()` arrived as the test contract. The failure
    ///      looked like a broken guard rather than a broken fixture.
    function _log(uint256 price_, uint256 seq_) internal view returns (IReactive.LogRecord memory) {
        return IReactive.LogRecord({
            chainId: ORIGIN_CHAIN,
            contractAddress: address(feed),
            topic0: uint256(keccak256("PriceUpdated(bytes32,uint256,uint256)")),
            topic1: uint256(PAIR),
            topic2: 0,
            topic3: 0,
            data: abi.encode(price_, seq_),
            blockNumber: 1234,
            opCode: 2, // LOG2: topic0 plus one indexed parameter
            blockHash: 0,
            txHash: 0,
            logIndex: 0
        });
    }

    function test_react_aboveFloor_doesNotCallBack() public {
        vm.prank(SYSTEM_ADDR);
        reactor.react(_log(2_500e18, 1));

        assertEq(reactor.reactions(), 1, "the reaction should still be recorded");
        assertEq(reactor.triggers(), 0, "but nothing should have fired");
        assertEq(system.requestCount(), 0);
    }

    function test_react_atFloor_doesCallBack() public {
        // The boundary is inclusive: `price <= FLOOR`. Pinning it here because
        // off-by-one at the trigger price is the kind of thing that only shows
        // up when a real position fails to close.
        vm.prank(SYSTEM_ADDR);
        reactor.react(_log(FLOOR, 7));

        assertEq(reactor.triggers(), 1);
        assertEq(system.requestCount(), 1);
    }

    function test_react_belowFloor_requestsWellFormedCallback() public {
        vm.prank(SYSTEM_ADDR);
        reactor.react(_log(1_900e18, 42));

        assertEq(system.requestCount(), 1);
        (uint256 chainId, address recipient, uint64 gasLimit,) = system.requests(0);
        assertEq(chainId, DEST_CHAIN);
        assertEq(recipient, address(executor));
        assertEq(gasLimit, reactor.CALLBACK_GAS_LIMIT());

        // The payload must match the executor's selector exactly, or the
        // callback lands and reverts on arrival having already been paid for.
        bytes memory payload = system.lastPayload();
        bytes4 selector;
        assembly { selector := mload(add(payload, 0x20)) }
        assertEq(
            selector,
            StopLossExecutor.executeStop.selector,
            "payload selector does not match the executor"
        );

        (, bytes32 pair, uint256 price, uint256 seq) =
            abi.decode(_stripSelector(payload), (address, bytes32, uint256, uint256));
        assertEq(pair, PAIR, "pair must survive the trip through topic1");
        assertEq(price, 1_900e18);
        assertEq(seq, 42, "seq is what matches a callback to its origin update");
    }

    function test_react_rejectsCallersOtherThanSystem() public {
        vm.expectRevert();
        reactor.react(_log(1_000e18, 1));

        vm.prank(makeAddr("attacker"));
        vm.expectRevert();
        reactor.react(_log(1_000e18, 1));
    }

    // --- the executor's two guards ---

    function test_executor_rejectsCallsNotFromTheProxy() public {
        vm.prank(makeAddr("attacker"));
        vm.expectRevert();
        executor.executeStop(address(this), PAIR, 1_900e18, 1);
    }

    function test_executor_rejectsAnotherReactorThroughTheSameProxy() public {
        // The proxy is shared infrastructure. Without onlyCallbackSender, any
        // reactive contract could drive this executor through it.
        vm.prank(proxy);
        vm.expectRevert(
            abi.encodeWithSelector(
                AbstractCallback.CallbackNotAuthorized.selector,
                makeAddr("otherReactor"),
                address(this)
            )
        );
        executor.executeStop(makeAddr("otherReactor"), PAIR, 1_900e18, 1);
    }

    function test_executor_acceptsTheAuthorisedPair() public {
        vm.prank(proxy);
        executor.executeStop(address(this), PAIR, 1_900e18, 99);

        assertEq(executor.executions(), 1);
        assertEq(executor.lastSeq(), 99);
    }

    function _stripSelector(bytes memory data_) internal pure returns (bytes memory out) {
        out = new bytes(data_.length - 4);
        for (uint256 i = 0; i < out.length; ++i) {
            out[i] = data_[i + 4];
        }
    }

    // --- debt recovery ---
    //
    // These four exist because the first live deployment died for want of the
    // function they cover. It ran out of lREACT mid-run, the network recorded
    // a debt against it and suspended the subscription, and nothing could
    // clear it: the system contract credits `msg.sender`, so paying from an
    // EOA credited the EOA, and `_coverDebt()` is `internal`, so only the
    // reactor could have paid -- through a function it did not have. It was
    // left holding 0.41 lREACT it could not spend against 0.0137 it owed.
    // NOTES-reactor-debt.md has the transaction-level account.

    function test_debt_reportsWhatTheNetworkSays() public {
        assertEq(reactor.debt(), 0, "nothing owed on a fresh reactor");
        system.setDebt(5 ether);
        assertEq(reactor.debt(), 5 ether, "the view must track the network");
    }

    function test_coverDebt_paysTheExactAmountOwed() public {
        vm.deal(address(reactor), 1 ether);
        system.setDebt(0.25 ether);

        reactor.coverDebt();

        assertEq(system.received(), 0.25 ether, "the system contract is paid the debt");
        assertEq(address(reactor).balance, 0.75 ether, "and not a wei more");
    }

    /// @dev The whole point is that recovery must not depend on a key. An
    ///      owner-gated version would reintroduce the failure it exists to
    ///      undo, so "anyone can call it" is the property under test rather
    ///      than an oversight.
    function test_coverDebt_isCallableByAnyone() public {
        vm.deal(address(reactor), 1 ether);
        system.setDebt(0.1 ether);

        vm.prank(makeAddr("a passer-by"));
        reactor.coverDebt();

        assertEq(system.received(), 0.1 ether, "a stranger can clear the debt");
    }

    /// @dev A partial payment does not resume the subscription, so there is
    ///      nothing to be gained by accepting one. Reverting says so.
    function test_coverDebt_revertsWhenTheBalanceCannotCoverIt() public {
        vm.deal(address(reactor), 0.05 ether);
        system.setDebt(0.2 ether);

        vm.expectRevert();
        reactor.coverDebt();

        assertEq(system.received(), 0, "no partial payment");
    }

}
