# Reactive Omni — what the research established

Everything below was read off the live docs and the library source, not from
memory or tutorials. Two findings would have cost days if discovered later.

## 1. The buildathon is on Omni, and Omni broke the contract model

Almost every tutorial, demo and blog post describes **Legacy** Reactive Network.
A contract written that way compiles, deploys, and does nothing here.

| | Legacy | **Omni (what we need)** |
|---|---|---|
| System contract | `0x…00fffFfF` | **`0x8888888888888888888888888888888888888888`** |
| React signature | `react(LogRecord calldata log)` | `react(LogRecord memory log_)` |
| Guard | `vmOnly` | **`onlySystem`** |
| Dual state | `bool internal vm` | gone — no RVM |
| Callback | `emit Callback(...)` | **`SYSTEM.requestCallbackV_1_0(...)`** |

## 2. The public `reactive-lib` is the LEGACY library

`github.com/Reactive-Network/reactive-lib` last shipped **April 2025** and is
Legacy — its `AbstractReactive` hardcodes `SERVICE_ADDR = 0x…00fffFfF`, carries
`bool internal vm`, and exposes `vmOnly()`. It is the first result for anyone
searching, and it is the wrong one.

The one to use is **`github.com/Reactive-Network/reactive-lib-omni`**, confirmed
by reading its source: `SYSTEM = 0x8888…8888`, `onlySystem`, no `vm` flag.

Its layout is `src/base/` and `src/interfaces/`, which matches the import paths
in the docs. (The legacy repo uses `src/abstract-base/`, so a path copied from
one will not resolve against the other.)

```
forge install Reactive-Network/reactive-lib-omni
# remapping: @reactive/=lib/reactive-lib-omni/
```

## Networks

| Chain | Chain ID | Callback proxy |
|---|---|---|
| Reactive Lasna (testnet) | **5318007** | `0x8888888888888888888888888888888888888888` |
| Reactive Mainnet | 1597 | — |
| Base Sepolia | **84532** | `0x476F44b11F5C942c58f4c8E3d0300E5710743585` |
| Unichain Sepolia | 1301 | `0x775c9B990ADe401060B78D0e98684eEf8d2466C1` |
| Ethereum Sepolia | 11155111 | `0xAa14d9Cd0f788Ca23d11805986C1d8bd035D23b4` |

- Lasna RPC: `https://lasna-rpc.rnk.dev/` · explorer `https://lasna.reactscan.net/`
- **Testnet origin requires a testnet destination.** They cannot be mixed.

### Funding

Testnet lREACT comes from sending Sepolia ETH to a faucet contract, 1 ETH → 100 lREACT:

```bash
cast send 0x2afaFD298b23b62760711756088F75B7409f5967 \
  --rpc-url $BASE_SEPOLIA_RPC --private-key $PRIVATE_KEY \
  "request(address)" $WALLET_ADDR --value 0.1ether
```

Never send more than 5 ETH in one transaction — anything above is lost, not refunded.

So Base Sepolia ETH is needed **twice over**: once to buy lREACT, and again to
fund the callback contract, which the proxy bills in the destination chain's
native token.

## The contract model

**Reactive contract** (on Lasna) — inherits `AbstractReactive`:

- `SYSTEM.subscribe(chainId, contract, topic0, REACTIVE_IGNORE × 3)` in the constructor
- `function react(LogRecord memory log_) external onlySystem`
- must hold a balance: reactive transactions are billed to the contract
- requests work elsewhere via `SYSTEM.requestCallbackV_1_0({chainId, recipient, gasLimit, payload})`

**Callback contract** (on Base Sepolia) — inherits `AbstractCallback(proxy, sender)`:

- first parameter **must** be `address`: the proxy overwrites the first 160 bits
  of the payload with the calling reactive contract's address, whatever you name it
- guard with **both** `onlyServiceProvider` and `onlyCallbackSender(reactive_)`
- must hold a balance in the destination chain's native token

**A contract cannot be both.** `AbstractPayer` holds one immutable
`_SERVICE_PROVIDER`; `AbstractReactive` pins it to `SYSTEM` and
`AbstractCallback` pins it to the proxy, so inheriting both will not compile.

### Subscriptions

Equality matching only — no ranges, no OR within one subscription. One
`subscribe()` call per combination. Wildcards: `chainId=0`, `contract=address(0)`,
`topic=REACTIVE_IGNORE`. At least one criterion must be specific. Subscriptions
live in the node, not in contract storage, so they cannot be read back on-chain.

### LogRecord

```solidity
struct LogRecord {
    uint256 chainId; address contractAddress;
    uint256 topic0; uint256 topic1; uint256 topic2; uint256 topic3;
    bytes data;           // ABI-encoded NON-indexed params only
    uint256 blockNumber;  // origin block — no timestamp
    uint256 opCode;       // how many topics the original log had
    uint256 blockHash; uint256 txHash; uint256 logIndex;
}
```

`blockHash` and `txHash` are `uint256`, not `bytes32`. Check `opCode` before
decoding `data`, since its layout depends on which parameters were indexed.

## What this means for measuring latency

**`LogRecord` carries `blockNumber` but no timestamp.** So the origin timestamp
has to be resolved off-chain by looking the block up over RPC. The three stages
to capture:

| Stage | Where it comes from |
|---|---|
| t0 — origin event | `eth_getBlockByNumber(log.blockNumber)` on Base Sepolia |
| t1 — reaction | `block.timestamp` recorded inside `react()` on Lasna |
| t2 — callback executed | `block.timestamp` recorded in the callback on Base Sepolia |

One caveat to design around: **Base Sepolia produces 200ms blocks** since the
Denim upgrade, while block timestamps are second-granular. Several blocks can
share a timestamp, so t0 alone cannot resolve sub-second differences. The
harness should record wall-clock observation times alongside block timestamps
and report both, rather than quietly presenting second-granular data as
millisecond precision.

The buildathon's ground rules make the same point from the other side: *"use
timestamps rather than block counts for any timers, cooldowns"* — at 200ms a
block count means something different than it used to.

## Tooling

Foundry (`forge`, `cast`) is the documented toolchain and the library ships
Foundry remappings. **Not currently installed on this machine**; `winget` and
`cargo` are both available.

Verification is Sourcify:

```bash
forge verify-contract --verifier sourcify --chain-id 5318007 $ADDR $NAME
```

## Sources

- https://dev.reactive.network/ — Getting Started, incl. the Legacy→Omni diff
- https://dev.reactive.network/reactive-contracts
- https://dev.reactive.network/callback-contracts
- https://dev.reactive.network/reactive-mainnet
- https://dev.reactive.network/origins-and-destinations
- https://github.com/Reactive-Network/reactive-lib-omni

## Measured block times (2026-11-14, from the live chains)

```
cast block $N --field timestamp   # over a 5000-block span
```

| Chain | Block time | Source |
|---|---|---|
| Base Sepolia | **200 ms** | 1000s over 5000 blocks |
| Reactive Lasna | **~1066 ms** | 5329s over 5000 blocks |

This sets the floor on anything the loop can do, and it is worth stating before
the first measurement rather than discovering it afterwards:

| Stage | Bounded by | Best case |
|---|---|---|
| push included on Base Sepolia | one origin block | ≤ 200 ms |
| reactor reacts on Lasna | **one Lasna block** | ~1.07 s |
| callback included on Base Sepolia | one origin block | ≤ 200 ms |
| **end to end** | | **~1.5 s** |

So sub-second end-to-end is not achievable on this pair of chains no matter how
the contracts are written — the reactive leg alone cannot be quicker than one
Lasna block. A submission claiming otherwise would be measuring something else.

It also settles the harness's poll interval: 250 ms is well inside Lasna's
block time, so polling is not what limits the resolution of the reaction leg.
