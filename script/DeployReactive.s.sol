// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { Script } from "forge-std/Script.sol";
import { console } from "forge-std/console.sol";

import { StopLossReactor } from "../src/StopLossReactor.sol";

/// @title DeployReactive
/// @notice Deploys the reactor on Reactive Lasna. Run second: the reactor
///         subscribes in its constructor, so it is live the instant it exists.
contract DeployReactive is Script {
    function run() external {
        uint256 originChainId = vm.envUint("ORIGIN_CHAIN_ID");
        address originFeed = vm.envAddress("ORIGIN_FEED");
        uint256 destinationChainId = vm.envUint("DESTINATION_CHAIN_ID");
        address executor = vm.envAddress("EXECUTOR");
        uint256 floor = vm.envUint("FLOOR_WEI");
        uint256 funding = vm.envOr("REACTOR_FUNDING_WEI", uint256(5 ether));
        address expectedReactor = vm.envAddress("EXPECTED_REACTOR");

        // The signer comes from the forge CLI (--account for a keystore,
        // --private-key for a raw key), not from the environment. Reading
        // PRIVATE_KEY here would force the key into the environment even when
        // a keystore is in use, which is the thing a keystore exists to avoid.
        address deployer = msg.sender;

        console.log("deployer    ", deployer);
        console.log("chain id    ", block.chainid);
        console.log("origin feed ", originFeed);
        console.log("executor    ", executor);
        console.log("floor       ", floor);
        console.log("nonce here  ", vm.getNonce(deployer));

        // A reactor watching a feed that is not there, or calling back to an
        // address with no code, looks healthy and does nothing. Both are only
        // checkable from the chain the contract lives on, which is not this
        // one, so the deploy script cannot verify them -- deploy.sh does it
        // over RPC before this script runs.
        require(executor != address(0), "EXECUTOR is unset");
        require(originFeed != address(0), "ORIGIN_FEED is unset");
        require(funding > 0, "reactor must be funded: it pays for its own reactions");

        vm.startBroadcast();
        StopLossReactor reactor = new StopLossReactor{ value: funding }(
            originChainId, originFeed, destinationChainId, executor, floor
        );
        vm.stopBroadcast();

        // The executor on the origin chain already has an immutable
        // `_CALLBACK_SENDER` set to the predicted address. If the real one
        // differs, every callback this reactor sends will be rejected on
        // arrival after being paid for. Failing here keeps that from
        // happening: the assertion runs during simulation, so a mismatch
        // aborts before anything is broadcast.
        require(
            address(reactor) == expectedReactor,
            "reactor address != EXPECTED_REACTOR -- the Lasna nonce moved after prediction; re-predict and redeploy the executor"
        );

        console.log("StopLossReactor    ", address(reactor));
        console.log("reactor funded wei ", funding);

        string memory key = "reactive";
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeAddress(key, "deployer", deployer);
        vm.serializeAddress(key, "reactor", address(reactor));
        vm.serializeUint(key, "originChainId", originChainId);
        vm.serializeAddress(key, "originFeed", originFeed);
        vm.serializeUint(key, "destinationChainId", destinationChainId);
        vm.serializeAddress(key, "executor", executor);
        vm.serializeUint(key, "topic0", reactor.PRICE_UPDATED_TOPIC_0());
        string memory json = vm.serializeUint(key, "floor", floor);

        vm.writeJson(json, "./deployments/reactive.json");
        console.log("wrote deployments/reactive.json");
    }
}
