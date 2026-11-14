// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { Test } from "forge-std/Test.sol";
import { Vm } from "forge-std/Vm.sol";
import { IPayable } from "@reactive/src/interfaces/IPayable.sol";
import { IReactive } from "@reactive/src/interfaces/IReactive.sol";

import { MockSystem } from "./StopLoss.t.sol";
import { PriceFeed } from "../src/PriceFeed.sol";
import { StopLossReactor } from "../src/StopLossReactor.sol";
import { StopLossExecutor } from "../src/StopLossExecutor.sol";

/// @title EventSignaturesTest
/// @notice Checks `harness/events.json` against the events the contracts emit.
///
/// The harness finds its data with `eth_getLogs` filtered on topic0, and it
/// takes those signatures from a JSON file because recomputing a keccak hash
/// in two languages is a good way to end up with two answers.
///
/// The failure this guards against is specific and nasty. Add a field to
/// `Reacted`, and nothing breaks: the contracts compile, the Solidity tests
/// pass, the deploy succeeds, the reactor reacts. Only the harness goes quiet,
/// filtering on a topic0 that no longer exists and reporting a run in which
/// nothing ever reacted. That reads as a dead loop rather than a stale filter,
/// and it would be chased on-chain for hours.
///
/// Comparing against `vm.recordLogs()` rather than against a restated
/// signature string is the point: the right-hand side here is the hash the EVM
/// actually put in topic0, not a second copy of the same assumption.
contract EventSignaturesTest is Test {
    address internal constant SYSTEM_ADDR = 0x8888888888888888888888888888888888888888;
    uint256 internal constant ORIGIN_CHAIN = 84532;
    uint256 internal constant FLOOR = 2_000e18;
    bytes32 internal constant PAIR = bytes32("ETH/USD");

    PriceFeed internal feed;
    StopLossReactor internal reactor;
    StopLossExecutor internal executor;

    address payable internal proxy = payable(makeAddr("callbackProxy"));
    string internal manifest;

    function setUp() public {
        vm.etch(SYSTEM_ADDR, type(MockSystem).runtimeCode);

        feed = new PriceFeed();
        executor = new StopLossExecutor(IPayable(proxy), address(this));
        reactor = new StopLossReactor(
            ORIGIN_CHAIN, address(feed), ORIGIN_CHAIN, address(executor), FLOOR
        );

        manifest = vm.readFile("harness/events.json");
    }

    /// @dev The hash the harness will filter on, taken from the shared manifest.
    function _fromManifest(string memory name) internal view returns (bytes32) {
        string memory signature = vm.parseJsonString(manifest, string.concat(".", name));
        require(bytes(signature).length > 0, string.concat("events.json has no entry for ", name));
        return keccak256(bytes(signature));
    }

    /// @dev topic0 of the first recorded log emitted by `emitter`.
    function _topic0Of(Vm.Log[] memory logs, address emitter) internal pure returns (bytes32) {
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter == emitter) return logs[i].topics[0];
        }
        revert("no log from that address");
    }

    function _topic0Named(Vm.Log[] memory logs, address emitter, bytes32 expected)
        internal
        pure
        returns (bool found)
    {
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter == emitter && logs[i].topics[0] == expected) return true;
        }
        return false;
    }

    function test_priceUpdated_matchesTheManifest() public {
        vm.recordLogs();
        feed.push(PAIR, 2_500e18);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(
            _topic0Of(logs, address(feed)),
            _fromManifest("PriceUpdated"),
            "harness/events.json PriceUpdated does not match the emitted topic0"
        );
    }

    function test_reactedAndCallbackRequested_matchTheManifest() public {
        IReactive.LogRecord memory record = IReactive.LogRecord({
            chainId: ORIGIN_CHAIN,
            contractAddress: address(feed),
            topic0: uint256(keccak256("PriceUpdated(bytes32,uint256,uint256)")),
            topic1: uint256(PAIR),
            topic2: 0,
            topic3: 0,
            data: abi.encode(uint256(1_900e18), uint256(1)),
            blockNumber: 1234,
            opCode: 2,
            blockHash: 0,
            txHash: 0,
            logIndex: 0
        });

        vm.recordLogs();
        vm.prank(SYSTEM_ADDR);
        reactor.react(record);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        // A triggering price emits both, so one call covers both signatures.
        assertTrue(
            _topic0Named(logs, address(reactor), _fromManifest("Reacted")),
            "harness/events.json Reacted does not match any emitted topic0"
        );
        assertTrue(
            _topic0Named(logs, address(reactor), _fromManifest("CallbackRequested")),
            "harness/events.json CallbackRequested does not match any emitted topic0"
        );
    }

    function test_stopExecuted_matchesTheManifest() public {
        vm.recordLogs();
        vm.prank(proxy);
        executor.executeStop(address(this), PAIR, 1_900e18, 1);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(
            _topic0Of(logs, address(executor)),
            _fromManifest("StopExecuted"),
            "harness/events.json StopExecuted does not match the emitted topic0"
        );
    }

    /// @dev The harness reads `seq` out of topic1 to pair a reaction with the
    ///      update that caused it. If `seq` ever stopped being the first
    ///      indexed parameter it would land in a different topic, and the
    ///      filter would match nothing at all.
    function test_seqIsTheFirstIndexedParameter_inBothEvents() public {
        vm.recordLogs();
        vm.prank(SYSTEM_ADDR);
        reactor.react(
            IReactive.LogRecord({
                chainId: ORIGIN_CHAIN,
                contractAddress: address(feed),
                topic0: uint256(keccak256("PriceUpdated(bytes32,uint256,uint256)")),
                topic1: uint256(PAIR),
                topic2: 0,
                topic3: 0,
                data: abi.encode(uint256(1_900e18), uint256(77)),
                blockNumber: 1234,
                opCode: 2,
                blockHash: 0,
                txHash: 0,
                logIndex: 0
            })
        );
        Vm.Log[] memory reactorLogs = vm.getRecordedLogs();

        bytes32 reactedTopic = _fromManifest("Reacted");
        bool checked;
        for (uint256 i = 0; i < reactorLogs.length; ++i) {
            if (reactorLogs[i].topics[0] == reactedTopic) {
                assertEq(uint256(reactorLogs[i].topics[1]), 77, "Reacted: seq is not topic1");
                checked = true;
            }
        }
        assertTrue(checked, "no Reacted log found");

        vm.recordLogs();
        vm.prank(proxy);
        executor.executeStop(address(this), PAIR, 1_900e18, 77);
        Vm.Log[] memory execLogs = vm.getRecordedLogs();

        assertEq(uint256(execLogs[0].topics[1]), 77, "StopExecuted: seq is not topic1");
        assertEq(execLogs[0].topics[2], PAIR, "StopExecuted: pair is not topic2");
    }
}
