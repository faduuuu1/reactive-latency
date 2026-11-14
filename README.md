# Cross-chain stop-loss, with the latency actually measured

A stop-loss that watches a price feed on Base Sepolia, decides on Reactive
Lasna, and executes back on Base Sepolia — plus a harness that measures how
long that round trip takes and is careful about what the measurement means.

Built for the Reactive Omni Buildathon, **Every Second Counts**.

The contracts are the easy half. The interesting half is that cross-chain
latency is harder to measure than it looks, and most numbers quoted for it are
measuring something other than what they claim.

---

## The loop

| | Contract | Chain | Role |
|---|---|---|---|
| **t0** | [`PriceFeed`](src/PriceFeed.sol) | Base Sepolia | emits `PriceUpdated` |
| **t1** | [`StopLossReactor`](src/StopLossReactor.sol) | Reactive Lasna | subscribes; below a floor, requests a callback |
| **t2** | [`StopLossExecutor`](src/StopLossExecutor.sol) | Base Sepolia | receives the callback, records the moment |

Every update carries a monotonic `seq` that travels the whole loop. Without it,
pairing a callback with the update that caused it would mean matching on
timestamps — which is the quantity being measured, so it cannot be used to
establish itself.

The feed is ours rather than a live pool because **latency has to be sampled,
not witnessed once**. A pool emits when it emits; driving the origin lets the
harness fire a hundred updates and report a distribution instead of an
anecdote. The reactor subscribes by `(chainId, address, topic0)`, so pointing
it at a real pool is a change of constructor arguments, not of code.

---

## What makes the measurement honest

### Most cross-chain latency figures secretly include clock skew

The obvious way to time this is `t1 - t0`: the reaction's block timestamp minus
the origin event's. But those two timestamps come from **different chains**, and
nothing synchronises their clocks. What you get is

```
(true latency) + (Lasna's clock offset from Base Sepolia's)
```

and the offset is unknown, unbounded, and can be of either sign. A negative
result is not a bug — it is the skew becoming visible.

`t2 - t0` is different in kind. Both timestamps come from Base Sepolia, so the
offset cancels **exactly**. That is the only block-timestamp figure in this
repo that measures latency and nothing else, and it is the one the report
leads with. The per-leg figures are still reported, labelled, and read for
their *spread* rather than their centre: a constant offset shifts the median
and leaves the variance alone.

The harness also derives the callback leg from two observations made by the
same process — `reaction seen → execution seen` — which is skew-free for the
same reason, at the cost of being an upper bound.

When the median cross-chain leg comes out negative, the report says so and
converts it into a **lower bound on the clock offset**, because a reaction
cannot precede its cause. [A test](harness/stats.test.mjs) injects a known 5s
offset into synthetic data and checks the analysis recovers a bound that is
genuinely below it.

### Second-granular timestamps on a 200ms chain

Base Sepolia produces a block every 200 ms, but block timestamps are whole
seconds. Several blocks share a timestamp, so `0s` end-to-end means *within the
same second*, not *instant*. The report says so next to the number, and carries
a **block count** alongside it, which resolves the same interval five times
more finely.

### What is physically possible here, stated up front

Measured from the live chains on 2026-11-14:

| Chain | Block time |
|---|---|
| Base Sepolia | **200 ms** |
| Reactive Lasna | **~1066 ms** |

Which bounds the loop before a single sample is taken:

| Stage | Bounded by | Best case |
|---|---|---|
| push included | one origin block | ≤ 200 ms |
| reactor reacts | **one Lasna block** | ~1.07 s |
| callback included | one origin block | ≤ 200 ms |
| **end to end** | | **~1.5 s** |

Sub-second end-to-end is not achievable on this pair of chains however the
contracts are written. Writing that down beforehand is what makes the result a
measurement rather than a demo.

### Percentiles that are not invented

Nearest-rank, no interpolation, so every figure printed is a latency that
actually occurred. `p90` is withheld below 10 samples and `p99` below 100 — a
p99 drawn from twenty samples is the maximum wearing a hat.

### Failures are counted, not dropped

A sample whose reaction names a different origin block than the push landed in
is **rejected and listed**, never averaged in. A run where half the pairings
failed is not a smaller run, it is a broken measurement, and silently dropping
them would make the first look like the second.

---

## Running it

```bash
git clone --recurse-submodules <this repo>
```

`reactive-lib-omni` is a submodule pinned at v0.1.0, so a plain `git clone`
leaves `lib/reactive-lib-omni` empty and the build fails on the imports.
`git submodule update --init` repairs an existing clone.

> The pin matters. The library everyone finds first,
> [`reactive-lib`](https://github.com/Reactive-Network/reactive-lib), is the
> **Legacy** one: its `AbstractReactive` hardcodes the old system address,
> carries a `bool internal vm`, and guards with `vmOnly`. Code written against
> it compiles, deploys, and never reacts on Omni. See [NOTES.md](NOTES.md).

```bash
cp .env.example .env
```

Fill in a throwaway key, or set up a keystore. Then buy testnet lREACT with
Base Sepolia ETH, at 1 ETH → 100 lREACT:

```bash
./script/buy-lreact.sh 0.1
```

> Base Sepolia ETH is needed **twice over**: once to buy lREACT for the
> reactor, and again to fund the executor, which the callback proxy bills in
> the destination chain's native token.

```bash
./script/deploy.sh
```

```bash
node harness/collect.mjs --samples 40
```

```bash
node harness/report.mjs results/samples-latest.json
```

### The deploy order is not a preference

The executor's authorised sender is immutable, and so is the reactor's executor
address — each constructor wants the other's address. The way out is that a
CREATE address depends only on the deployer and its nonce, **never on the
constructor arguments**, so the reactor's address on Lasna can be computed
before anything exists. `deploy.sh` does that, hands it to the executor, and
the reactive deploy then asserts that the address it really got matches. A
mismatch fails during simulation, so nothing is broadcast.

The executor goes first because the reactor subscribes inside its constructor:
from the instant it exists it receives events and pays for them. An executor
waiting for a reactor costs nothing; a reactor firing at an address with no
code burns funds and reports success.

---

## Layout

```
src/                     the three contracts
test/                    15 Solidity tests
script/
  deploy.sh              orchestrates both chains in the one order that works
  buy-lreact.sh          testnet funding, with the 5 ETH cap enforced
harness/
  collect.mjs            drives the loop, writes raw samples
  report.mjs             samples -> report. No network: re-analysable later
  stats.mjs              the arithmetic, pure and tested
  rpc.mjs                JSON-RPC in sixty lines
  events.json            event signatures, shared with the Solidity tests
  stats.test.mjs         15 tests, no gas required
NOTES.md                 what the research established, and how
```

**No npm dependencies.** The harness is `fetch` and four JSON-RPC methods;
signing is handed to `cast`, which is already the toolchain and already holds
the key.

---

## Tests

```bash
forge test
```

```bash
node --test harness/stats.test.mjs
```

Two are worth singling out.

[`EventSignatures.t.sol`](test/EventSignatures.t.sol) checks
`harness/events.json` against topic0 as captured by `vm.recordLogs()` — the
hash the EVM actually emitted, not a restatement of the same assumption. Add a
field to `Reacted` and everything still compiles, deploys and runs; only the
harness goes quiet, filtering on a topic that no longer exists and reporting a
run in which nothing ever reacted. That reads as a dead loop rather than a
stale filter.

[`stats.test.mjs`](harness/stats.test.mjs) runs the whole analysis against
[synthetic data with known ground truth](harness/fixtures/make-synthetic.mjs).
Real testnet data cannot test the skew claim, because with real data the offset
is exactly the thing nobody knows.

---

## Deployed

Live on testnet, source verified on Sourcify (`exact_match` on all three,
including the one on Lasna):

| Contract | Chain | Address |
|---|---|---|
| `PriceFeed` | Base Sepolia (84532) | [`0x700723a306d1873880a41bC958A802F9C2ce07F3`](https://sepolia.basescan.org/address/0x700723a306d1873880a41bC958A802F9C2ce07F3) |
| `StopLossExecutor` | Base Sepolia (84532) | [`0x74E382Ef93473cD5e47c09a68E653EE841c7F9aE`](https://sepolia.basescan.org/address/0x74E382Ef93473cD5e47c09a68E653EE841c7F9aE) |
| `StopLossReactor` | Reactive Lasna (5318007) | [`0x16aE7374dCc682959565498Be69aEcA26549D53A`](https://lasna.reactscan.net/address/0x16aE7374dCc682959565498Be69aEcA26549D53A) |

The nonce prediction held: the reactor landed on the address computed before
the executor existed, so the executor's immutable `_CALLBACK_SENDER` points at
it. Both were read back off their respective chains to confirm it, rather than
assumed from the deploy succeeding.

### What it actually cost

Measured, not estimated. The two chains are priced very differently and it
decides everything about how a run is budgeted:

| | Base Sepolia | Reactive Lasna |
|---|---|---|
| gas price | 0.006 gwei | **100 gwei** |

A factor of about 16,700, so the reactive side is essentially the whole bill
and origin gas is a rounding error. Per sample, measured over a four-sample
run: **0.0136 lREACT**, against 0.0145 predicted from gas prices beforehand.
Twenty callbacks cost the executor 1.5e-6 ETH in total.

## Status

Contracts, deploy scripts and harness are written, tested, deployed and
verified. Any report under `results/` is either a real measurement or clearly
marked synthetic; there are no placeholder figures anywhere in this repo.
