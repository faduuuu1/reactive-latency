// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { Script } from "forge-std/Script.sol";
import { console } from "forge-std/console.sol";
import { IPayable } from "@reactive/src/interfaces/IPayable.sol";

import { PriceFeed } from "../src/PriceFeed.sol";
import { StopLossExecutor } from "../src/StopLossExecutor.sol";

/// @title DeployOrigin
/// @notice Deploys the two origin-chain contracts: the feed that starts the
///         loop and the executor that ends it.
///
/// ## Why this runs before the reactor, and how the circle is broken
///
/// The executor's authorised sender is immutable, and so is the reactor's
/// executor address. Each constructor wants the other's address, which looks
/// like a deadlock.
///
/// It is not, because a CREATE address depends only on the deployer and its
/// nonce — **not on the constructor arguments**. So the reactor's address on
/// Lasna can be computed before the reactor, or even the executor, exists:
///
/// ```
/// cast compute-address $DEPLOYER --nonce $(cast nonce $DEPLOYER --rpc-url $LASNA)
/// ```
///
/// That prediction comes in as `EXPECTED_REACTOR`, and `DeployReactive` asserts
/// the address it actually gets matches it. If the Lasna nonce moves in between,
/// the reactive deploy fails in simulation and nothing is broadcast.
///
/// This direction of the circle is the safe one. The reactor subscribes in its
/// constructor, so the moment it exists it starts receiving events and paying
/// for them. Deploying it last means it goes live only once there is something
/// for its callbacks to reach. An executor waiting for a reactor costs nothing;
/// a reactor firing at an address with no code burns funds silently.
contract DeployOrigin is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address payable proxy = payable(vm.envAddress("CALLBACK_PROXY"));
        address expectedReactor = vm.envAddress("EXPECTED_REACTOR");
        uint256 funding = vm.envOr("EXECUTOR_FUNDING_WEI", uint256(0.005 ether));

        require(expectedReactor != address(0), "EXPECTED_REACTOR is unset");

        // The proxy address is chain-specific and silently wrong if copied from
        // another network's docs. An executor bound to an address with no code
        // can never be called, and nothing about it looks broken until the
        // first callback fails to arrive.
        require(proxy.code.length > 0, "CALLBACK_PROXY has no code on this chain");

        address deployer = vm.addr(pk);
        console.log("deployer     ", deployer);
        console.log("chain id     ", block.chainid);
        console.log("proxy        ", proxy);
        console.log("reactor (predicted)", expectedReactor);

        vm.startBroadcast(pk);

        PriceFeed feed = new PriceFeed();

        // Funded at construction: the proxy bills this contract in the
        // destination chain's native token, and an unfunded executor rejects
        // callbacks that the reactor has already paid to send.
        StopLossExecutor executor =
            new StopLossExecutor{ value: funding }(IPayable(proxy), expectedReactor);

        vm.stopBroadcast();

        console.log("PriceFeed          ", address(feed));
        console.log("StopLossExecutor   ", address(executor));
        console.log("executor funded wei", funding);

        string memory key = "origin";
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeAddress(key, "deployer", deployer);
        vm.serializeAddress(key, "callbackProxy", proxy);
        vm.serializeAddress(key, "priceFeed", address(feed));
        vm.serializeAddress(key, "executor", address(executor));
        vm.serializeUint(key, "topic0", feed.priceUpdatedTopic0());
        string memory json = vm.serializeAddress(key, "expectedReactor", expectedReactor);

        vm.writeJson(json, "./deployments/origin.json");
        console.log("wrote deployments/origin.json");
    }
}
