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
  backfill-hashes.mjs    recovers tx hashes for a run, checking as it goes
  stats.test.mjs         19 tests, no gas required
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

### The loop, on chain

Three complete loops from the 60-sample run — the fastest, the median and the
slowest — each one origin event, reactive transaction, and callback:

| | origin push | reactive transaction | callback |
|---|---|---|---|
| **1.0s** (5 blocks) | [`0x0ba20e14…`](https://sepolia.basescan.org/tx/0x0ba20e144727c535e3cb05bd24b9d62909957d9af65113ab242942307117bff8) | [`0x3ef85842…`](https://lasna.reactscan.net/tx/0x3ef858425cb27e076a08e70e1112703f747588f0cbe80fe8eaba6c4995a1d876) | [`0x8b6e794a…`](https://sepolia.basescan.org/tx/0x8b6e794ae6344c2c27ae1314d63054ccf6f6d74e67fa1284bd93a57e7b29ec66) |
| **1.6s** (8 blocks) | [`0x5ce63482…`](https://sepolia.basescan.org/tx/0x5ce63482fe96ff9329faa303eca1298df4ef4ddf07396f4b11e55f91c56e5c0c) | [`0x0a1bb957…`](https://lasna.reactscan.net/tx/0x0a1bb957b0f3bfb740f97fa06e9431232a6f1bed62c4a4e80aaa050e764f5ae6) | [`0x9bec3bec…`](https://sepolia.basescan.org/tx/0x9bec3becf6f1f627b55590106da50da4fdba03b549934d3ad392dd2b3068128f) |
| **3.6s** (18 blocks) | [`0xe5751b5b…`](https://sepolia.basescan.org/tx/0xe5751b5ba1c842d54a868e6add5e4d9c754778f90007c480ad0fd0b015b9629e) | [`0xb220b629…`](https://lasna.reactscan.net/tx/0xb220b62935df7d8d8ec26a6ba43f89ed0aa5e2a6d9baad50540003a4998b99e7) | [`0x4cb8af87…`](https://sepolia.basescan.org/tx/0x4cb8af8795c94de16c14984299cc39327777218895db426603a8d559dc54e86e) |

Reading one across: the push calls `PriceFeed`; the reactive transaction on
Lasna is addressed to the Omni system contract
`0x8888888888888888888888888888888888888888`, which is what a
`requestCallbackV_1_0` looks like from outside; the callback arrives on Base
Sepolia from Reactive's callback sender `0xF7E8…1DDb`, addressed to the proxy
`0x476F44b1…`, which then calls `StopLossExecutor`. The executor is not the
`to` of that transaction and never is — it is called *by* the proxy, which is
why its authorised sender is the proxy rather than the reactor.

All three hashes for all 60 samples are in
[`results/samples-latest.json`](results/samples-latest.json).

> The first run recorded only the origin hash; the other two were recovered
> afterwards by [`harness/backfill-hashes.mjs`](harness/backfill-hashes.mjs),
> which refetches each log by block and sequence number and **refuses to write
> unless the log agrees with the sample** on every field the run already
> claimed. A hash attached to a sample it does not belong to would be worse
> than no hash at all. The collector records all three now.

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

## Results

60 samples, 30 of them crossing the floor. **No failures, no rejected
pairings.** Full report: [`results/REPORT.md`](results/REPORT.md); raw samples
beside it.

| | |
|---|---|
| **end to end, median** | **2s** by block timestamp, **8 origin blocks = 1.6s** |
| best / worst | 5 blocks (1.0s) / 18 blocks (3.6s) |
| reaction to execution, one clock | 312ms median, 216ms best |

The block count is the figure to read. Both numbers describe the same
interval, but timestamps are whole seconds while Base Sepolia blocks are
200ms, so the block count resolves it five times more finely.

### Where the time goes

| leg | as measured | offset removed |
|---|---:|---:|
| origin → reaction | 0s | **~1.7s** |
| reaction → execution | 2s | **~0.3s** |

Reaching the reactive chain is nearly all of it. Once the reactor has decided,
the callback lands in about 300ms.

### The clocks are 1.7s apart, and it nearly went unnoticed

`origin → reaction` measured **0.00s**. Not small — *zero*, as a median over
60 samples. A reaction arriving in the same second as the event that caused it
is not possible at these block times, so the number is an artefact.

Reactive Lasna's clock reads **1.69s behind** Base Sepolia's, and the true
reaction latency is also about 1.7s. They cancelled almost exactly.

This defeated the detector this repo shipped with. That test fires on a
*negative* cross-chain median, on the reasoning that a reaction cannot precede
its cause — sound, but a sufficient condition rather than a necessary one.
Here the offset and the latency were the same size, so the leg landed on zero
instead of going negative, and the check stayed quiet.

What catches it is measuring the offset rather than inferring it:
`reaction → execution` is recorded **twice**, once across the chain boundary
and once from two observations by a single process. The latency is identical
in both, so subtracting them cancels the latency and leaves the offset. The
harness now reports that, the report says plainly when the two methods
disagree, and [a test](harness/stats.test.mjs) reconstructs this exact
cancellation to keep the blind spot closed.

### Where the prediction was wrong

Before deploying, this README predicted a **~1.5s floor** from block times
alone. The median came in at 1.6s, which looks like a hit, but the *minimum*
was 1.0s — below a floor, which is not something a floor permits.

The reasoning was faulty. One Lasna block is 1.07s, but a transaction does not
wait a whole block: it waits for the *next* one, which is uniform on
0 to 1.07s. The true floor is near zero and the *expected* wait is about half
a block. The estimate was right about the median and wrong about what kind of
number it was, and two errors — overstating the block wait, ignoring the
network's own processing — happened to cancel.

## Status

Contracts, deploy scripts and harness are written, tested, deployed, verified
and measured. Any report under `results/` is either a real measurement or
clearly marked synthetic; there are no placeholder figures anywhere in this
repo.
