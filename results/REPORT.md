# Cross-chain stop-loss: latency report

Run started `2026-11-14T03:35:52.109Z`, finished `2026-11-14T03:44:12.200Z`.

| | |
|---|---|
| origin chain | `84532` |
| price feed | `0x700723a306d1873880a41bC958A802F9C2ce07F3` |
| executor | `0x74E382Ef93473cD5e47c09a68E653EE841c7F9aE` |
| reactive chain | `5318007` |
| reactor | `0x16aE7374dCc682959565498Be69aEcA26549D53A` |
| floor | `2000000000000000000000` |
| poll interval | 250ms |

**60 pushes · 60 usable · 30 crossed the floor · 30 callbacks landed.**

## The number that means what it says

End-to-end is the origin block timestamp subtracted from the execution block timestamp. **Both come from the same chain**, so whatever offset exists between the two networks' clocks cancels exactly. Nothing else in this report has that property.

| metric | n | min | p50 | p90 | p99 | max | mean |
|---|---:|---:|---:|---:|---:|---:|---:|
| end-to-end (origin block -> execution block) | 30 | 1s | 2s | 2s | - | 3s | 1.6s |
| origin blocks elapsed | 30 | 5 | 7 | 10 | - | 18 | 7.8 |

> Block timestamps are whole seconds while Base Sepolia produces blocks about every 200ms, so a `0s` end-to-end means *within the same second*, not instant, and the resolution here is ±1s. The block count in the second row is the finer measure of the same interval.

## The callback leg, on a single clock

Both ends of this figure are observations by the same process, so it carries no cross-chain offset either. It is an upper bound rather than the latency: each end can be late by up to one poll interval (250ms).

| metric | n | min | p50 | p90 | p99 | max | mean |
|---|---:|---:|---:|---:|---:|---:|---:|
| reaction seen -> execution seen | 30 | 216ms | 312ms | 701ms | - | 2313ms | 455.3ms |

## Observer wall clock

Measured from the moment the push was handed to `cast` until the event was visible over RPC. Includes transaction propagation, inclusion, the poll gap and the RPC round trip. One clock throughout, so no skew - but an upper bound on every stage it spans.

| metric | n | min | p50 | p90 | p99 | max | mean |
|---|---:|---:|---:|---:|---:|---:|---:|
| push sent -> reaction seen | 60 | 2698ms | 4825ms | 7908ms | - | 12148ms | 5212.1ms |
| push sent -> execution seen | 30 | 2927ms | 5001ms | 8156ms | - | 14461ms | 5642.1ms |

## Cross-chain legs, which carry clock offset

These two subtract a timestamp on one chain from a timestamp on another. Nothing synchronises those clocks, so each figure is the true latency plus the networks' offset, and that offset is unknown and can be of either sign. Their **spread** survives this - a constant offset shifts the centre and leaves the variance alone - so read the min-to-max range, not the median.

| metric | n | min | p50 | p90 | p99 | max | mean |
|---|---:|---:|---:|---:|---:|---:|---:|
| origin -> reaction | 60 | -1s | 0s | 0s | - | 1s | -0.3s |
| reaction -> execution | 30 | 2s | 2s | 2s | - | 2s | 2s |

> No negative cross-chain median, so no clock offset is provable from this run. An unprovable offset is not an absent one: the legs may still be shifted by an unknown constant. Only the end-to-end figure is skew-free.

### Measuring the offset instead of inferring it

`reaction -> execution` appears twice in this report: once from block timestamps across a chain boundary, once from two observations by a single process. The latency is the same in both. The difference between them is therefore the clock offset, with the latency cancelling out.

| | |
|---|---|
| samples | 30 |
| **estimated offset** | **1.69s**, reactive chain behind origin |
| range across samples | -0.31s to 1.78s |

With that removed, the legs read:

| leg | as measured | offset removed |
|---|---:|---:|
| origin -> reaction | 0s | **1.7s** |
| reaction -> execution | 2s | **0.3s** |

> Cross-chain legs with the estimated 1.69s offset removed. Derived, not measured: the offset is itself an estimate, so treat these as accurate to about half a second.

**This is the case the negative-median test cannot see.** It reports no offset, because no cross-chain leg came out negative — yet the offset is 1.69s. The two cancelled: the true origin-to-reaction latency is close to the offset, so the measured leg sits near zero and looks innocuous. A reaction arriving in the same second as its cause is not plausible at these block times, and that implausibility is the only hint the first test leaves behind.

## Every sample

| seq | fired | end-to-end | origin blocks | origin->reaction | reaction->exec | sent->reaction seen | sent->exec seen |
|---:|:---:|---:|---:|---:|---:|---:|---:|
| 5 | no | - | - | -1s | - | 8115ms | - |
| 6 | yes | 1s | 6 | -1s | 2s | 3107ms | 3331ms |
| 7 | no | - | - | 0s | - | 3828ms | - |
| 8 | yes | 2s | 8 | 0s | 2s | 3882ms | 4197ms |
| 9 | no | - | - | -1s | - | 4613ms | - |
| 10 | yes | 1s | 5 | -1s | 2s | 2876ms | 3099ms |
| 11 | no | - | - | 0s | - | 3382ms | - |
| 12 | yes | 1s | 8 | -1s | 2s | 3949ms | 4426ms |
| 13 | no | - | - | 0s | - | 4552ms | - |
| 14 | yes | 3s | 18 | 1s | 2s | 7908ms | 8156ms |
| 15 | no | - | - | 0s | - | 4309ms | - |
| 16 | yes | 2s | 8 | 0s | 2s | 4438ms | 5001ms |
| 17 | no | - | - | 0s | - | 3341ms | - |
| 18 | yes | 2s | 8 | 0s | 2s | 3581ms | 4282ms |
| 19 | no | - | - | 0s | - | 3236ms | - |
| 20 | yes | 1s | 7 | -1s | 2s | 2809ms | 3140ms |
| 21 | no | - | - | 0s | - | 7702ms | - |
| 22 | yes | 1s | 7 | -1s | 2s | 6150ms | 6434ms |
| 23 | no | - | - | -1s | - | 8725ms | - |
| 24 | yes | 2s | 6 | 0s | 2s | 12148ms | 14461ms |
| 25 | no | - | - | 0s | - | 6810ms | - |
| 26 | yes | 1s | 5 | -1s | 2s | 5388ms | 5700ms |
| 27 | no | - | - | -1s | - | 5949ms | - |
| 28 | yes | 2s | 7 | 0s | 2s | 3737ms | 4016ms |
| 29 | no | - | - | -1s | - | 7636ms | - |
| 30 | yes | 2s | 10 | 0s | 2s | 9302ms | 10399ms |
| 31 | no | - | - | 0s | - | 3344ms | - |
| 32 | yes | 2s | 10 | 0s | 2s | 5490ms | 5883ms |
| 33 | no | - | - | 0s | - | 6768ms | - |
| 34 | yes | 1s | 6 | -1s | 2s | 8356ms | 8962ms |
| 35 | no | - | - | 0s | - | 5341ms | - |
| 36 | yes | 1s | 7 | -1s | 2s | 6233ms | 6463ms |
| 37 | no | - | - | 0s | - | 4219ms | - |
| 38 | yes | 2s | 10 | 0s | 2s | 5515ms | 5789ms |
| 39 | no | - | - | 0s | - | 8303ms | - |
| 40 | yes | 1s | 8 | -1s | 2s | 4372ms | 4901ms |
| 41 | no | - | - | -1s | - | 6787ms | - |
| 42 | yes | 2s | 9 | 0s | 2s | 5905ms | 6171ms |
| 43 | no | - | - | 0s | - | 4596ms | - |
| 44 | yes | 2s | 9 | 0s | 2s | 4211ms | 4784ms |
| 45 | no | - | - | 0s | - | 4864ms | - |
| 46 | yes | 1s | 5 | -1s | 2s | 2698ms | 2927ms |
| 47 | no | - | - | -1s | - | 3473ms | - |
| 48 | yes | 2s | 8 | 0s | 2s | 2910ms | 3410ms |
| 49 | no | - | - | -1s | - | 4988ms | - |
| 50 | yes | 1s | 5 | -1s | 2s | 7280ms | 7522ms |
| 51 | no | - | - | -1s | - | 3394ms | - |
| 52 | yes | 2s | 7 | 0s | 2s | 3994ms | 4210ms |
| 53 | no | - | - | 0s | - | 5192ms | - |
| 54 | yes | 2s | 7 | 0s | 2s | 5433ms | 5874ms |
| 55 | no | - | - | 0s | - | 4684ms | - |
| 56 | yes | 2s | 10 | 0s | 2s | 6379ms | 7101ms |
| 57 | no | - | - | 0s | - | 3359ms | - |
| 58 | yes | 2s | 6 | 0s | 2s | 3061ms | 3297ms |
| 59 | no | - | - | 0s | - | 4825ms | - |
| 60 | yes | 2s | 9 | 0s | 2s | 3738ms | 4113ms |
| 61 | no | - | - | -1s | - | 5441ms | - |
| 62 | yes | 2s | 9 | 0s | 2s | 5498ms | 5729ms |
| 63 | no | - | - | 0s | - | 5345ms | - |
| 64 | yes | 1s | 5 | -1s | 2s | 5255ms | 5484ms |

_Percentiles omitted for want of samples: p99 (needs 100 samples). A p99 drawn from twenty samples is the maximum wearing a hat, so it is left blank rather than printed._

