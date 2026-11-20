# The reactor cannot pay its own debt — 20 Nov 2026

## What happened

A 115-sample `--pattern all-trigger` run was started to collect the 100
completed callbacks that `stats.mjs` requires before it will report `p99`.

The run completed 30 samples and then stopped reacting. Diagnosis, in order:

1. `reactions()` on the reactor froze at **114**, `triggers()` at **82**, and
   `executions()` on the executor at **82**. All three agree, so the loop did
   not break — it stopped being driven.
2. The reactor's Lasna balance had fallen from **0.437 to 0.0136 lREACT**:
   roughly **0.013 lREACT per reaction**, far more than was budgeted.
3. `SYSTEM.debt(reactor)` returns **0.0136659 lREACT**. The reactor ran out
   mid-reaction and accrued a debt, and a reactive contract in debt is
   suspended.

## Why funding it did not fix it

Sending 0.40 lREACT directly to the reactor did not resume it. Nor did
sending 0.02 lREACT to the system contract from the deployer EOA: `debt()`
was unchanged at 0.0136659 afterwards.

The reason is in `AbstractPayer`:

- `pay(uint256)` is `onlyServiceProvider`, so only the system contract at
  `0x8888888888888888888888888888888888888888` may call it.
- `_coverDebt()` is `internal`, and `StopLossReactor` never exposes it.
- `IPayable.receive()` is documented as "Allows contracts to pay their debts
  and resume subscriptions" — but the debt is keyed to `msg.sender`, so the
  payment has to come **from the reactor**, and the reactor has no function
  that sends value anywhere.

So the contract holds 0.4136 lREACT it cannot spend, owes 0.0137 it cannot
pay, and has no path back to being subscribed.

## The lesson, which belongs in the README

**A reactive contract must expose a public way to cover its own debt.** The
Reactive examples that do this declare:

```solidity
function coverDebt() external {
    _coverDebt();
}
```

`StopLossReactor` does not, and that single omission is the difference
between a contract that can be topped up and one that is bricked. The
constructor being `payable` is not sufficient: funding the contract is
useless if nothing can move the funds to the system contract.

A second, cheaper guard is to expose the balance and debt in the harness's
preflight, so a run refuses to start when the reactor cannot afford it.

## Both fixes have landed

**In the contract** — `StopLossReactor.coverDebt()` and `debt()`, with four
tests in `test/StopLoss.t.sol` covering the exact amount paid, that anyone may
call it, and that an underfunded call reverts rather than part-paying. It is
permissionless deliberately: an owner-gated version adds a key that can be
lost, and losing it reintroduces the failure the function exists to undo.

**In the harness** — `harness/budget.mjs`, wired into `collect.mjs`:

- a preflight that reads balance and debt and **refuses to push at all** when
  the reactor is already suspended, instead of spending origin gas on events
  that can no longer be delivered;
- a projection of how many reactions the balance affords, warning when the run
  requested is larger;
- a per-sample check that stops at a three-reaction reserve rather than at
  zero, and stops at once if debt appears;
- a cost estimate that follows the measured burn **upward only**, since an
  estimate that is too low is the only direction that does damage;
- the reactor's closing balance and debt written into the results file, so
  "what state did this run leave the contract in" is answerable afterwards.

Pointed at this reactor it prints the debt, the stranded balance and the
`cast send … coverDebt()` command that would fix a contract that had one, then
stops. Verified against the live suspended contract, not a mock.

Two further things that run exposed, both now fixed in `collect.mjs`:

- **79 of the 115 samples recorded a failed push with no reason.** `cast` puts
  its diagnosis on stderr and the collector kept only `err.message`, which is
  just the command line that failed. The reason is now kept.
- **It kept pushing anyway**, 79 times at a 3s interval. A run that cannot
  send a transaction is measuring nothing, so five consecutive failures now
  stop it.
- Samples are flushed after each one rather than once past the end of the
  loop, so an interrupted run keeps what it measured.

## What the salvaged samples were worth

The 30 completed callbacks turned out to be the most useful thing the run
produced. Collected under an all-trigger pattern six days after the original
alternate-pattern run, they agree with it to within one origin block on median
and p90 — and comparing the two is what caught the README reporting its mean
under the median's name. See "Reproduced on a second run" in the README.

## State as of now

| | |
|---|---|
| reactor `0x16aE7374dCc682959565498Be69aEcA26549D53A` | suspended, 0.4136 lREACT stranded, 0.0136659 owed |
| executor `0x74E382Ef93473cD5e47c09a68E653EE841c7F9aE` | healthy, 0.01595 ETH, 82 executions |
| feed `0x700723a306d1873880a41bC958A802F9C2ce07F3` | healthy |
| `results/samples-latest.json` | untouched — the 60-sample run the submission quotes |

Every transaction hash in the submission is historic and still verifiable.
What no longer works is driving a **new** loop against this deployment.

## Redeploying is more disruptive than it first looks

Worth writing down, because the obvious fix is not one.

`AbstractCallback._CALLBACK_SENDER` is **immutable**. The deployed executor
authorises exactly one reactor address, so callbacks from a new reactor are
rejected on arrival — after being paid for. A new reactor therefore needs a
**new executor** too, and the old executor's 0.0159 ETH is then stranded by
the same argument that stranded the reactor's lREACT.

`script/deploy.sh` goes further still: `DeployOrigin` always constructs a
fresh `PriceFeed`, so a full redeploy replaces **all three** addresses and
resets the feed's sequence counter to zero. Every published hash is keyed to a
sequence number from the current feed.

So a redeploy costs three new addresses, re-verification on Sourcify, edits to
the README, `deployments/*.json` and the DoraHacks submission, and leaves a
demo video on YouTube showing addresses that no longer matter. What it buys is
a testnet contract with gas in it.

The measurements do not need it: 60 completed callbacks are already on disk,
each with three verifiable transaction hashes. Documenting the outage costs
nothing and keeps the record straight, where swapping the addresses would
leave the video disagreeing with the repo.

A redeploy is worth doing if the loop has to be **demonstrated live** again.
It is not worth doing to make the numbers look tidier.
