// node --test harness/budget.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ReactorBudget, encodeDebtCall, formatEther, DEFAULT_COST_WEI } from './budget.mjs';

const ETH = 10n ** 18n;

/** A stand-in for Rpc exposing only what the budget reads, both settable. */
class FakeRpc {
  constructor(balance, debt = 0n) {
    this.balance = balance;
    this.debt = debt;
    this.calls = 0;
  }
  async getBalance() {
    this.calls += 1;
    return this.balance;
  }
  async ethCall() {
    return '0x' + this.debt.toString(16).padStart(64, '0');
  }
}

const REACTOR = '0x16aE7374dCc682959565498Be69aEcA26549D53A';

// --- the call the guard makes ---

test('the debt call is abi-encoded for debt(address), lower-cased and left-padded', () => {
  const data = encodeDebtCall(REACTOR);
  assert.equal(data.slice(0, 10), '0x9b6c56ec');
  assert.equal(data.length, 10 + 64);
  assert.ok(data.endsWith('16ae7374dcc682959565498be69aeca26549d53a'));
  assert.equal(data.slice(10, 34), '0'.repeat(24), 'address must be right-aligned in the word');
});

test('formatEther prints wei as a decimal without a trailing-zero tail', () => {
  assert.equal(formatEther(0n), '0');
  assert.equal(formatEther(ETH), '1');
  assert.equal(formatEther(13_000_000_000_000_000n), '0.013');
  assert.equal(formatEther(413_632_500_000_000_000n), '0.4136325');
});

// --- preflight ---

test('a healthy reactor projects how many reactions it can afford', async () => {
  // 1 lREACT at 0.013 and a three-reaction reserve: (1 - 0.039) / 0.013 = 73.
  const budget = new ReactorBudget(new FakeRpc(ETH), REACTOR);
  const pre = await budget.preflight(40);
  assert.equal(pre.ok, true);
  assert.equal(pre.fatal, false);
  assert.equal(pre.affordable, 73);
  assert.equal(pre.lines.length, 1, 'no warning when the run fits');
});

test('a run larger than the budget is warned about but still allowed to start', async () => {
  const budget = new ReactorBudget(new FakeRpc(ETH / 2n), REACTOR);
  const pre = await budget.preflight(115);
  assert.equal(pre.ok, true, 'partial data is better than none, so it may start');
  assert.equal(pre.fatal, false);
  assert.ok(pre.affordable < 115);
  assert.match(pre.lines.join('\n'), /115 samples requested, about \d+ affordable/);
});

// This is the case that cost a deployment. Pushing here spends origin-chain
// gas on events that can no longer be delivered, so it has to be fatal rather
// than a warning.
test('an indebted reactor is fatal, and the message says why funding it will not help', async () => {
  const budget = new ReactorBudget(new FakeRpc(413_632_500_000_000_000n, 13_665_900_000_000_000n), REACTOR);
  const pre = await budget.preflight(1);
  assert.equal(pre.ok, false);
  assert.equal(pre.fatal, true);
  assert.equal(pre.affordable, 0);
  const text = pre.lines.join('\n');
  assert.match(text, /owes 0\.0136659/);
  assert.match(text, /only the reactor can pay its own debt/);
  assert.match(text, /coverDebt\(\)/);
});

test('a reactor below its own reserve cannot start a run at all', async () => {
  const budget = new ReactorBudget(new FakeRpc(DEFAULT_COST_WEI), REACTOR);
  const pre = await budget.preflight(10);
  assert.equal(pre.fatal, true, 'one reaction of balance is inside the reserve');
  assert.equal(pre.affordable, 0);
});

// --- in-run checks ---

test('the run stops at the reserve rather than at zero', async () => {
  // 0.1 lREACT, so the drawdown below stays under the 0.013 estimate and the
  // reserve stays put. The next test covers what happens when it does not.
  const rpc = new FakeRpc(100_000_000_000_000_000n);
  const budget = new ReactorBudget(rpc, REACTOR);
  await budget.preflight(4);
  assert.equal(budget.reserveWei, 39_000_000_000_000_000n);

  let r = await budget.check(1);
  assert.equal(r.stop, false);

  rpc.balance = budget.reserveWei + 1n;
  r = await budget.check(5);
  assert.equal(budget.costWei, DEFAULT_COST_WEI, 'estimate unchanged, so the reserve is too');
  assert.equal(r.stop, false, 'one wei above the reserve is still runnable');

  rpc.balance = budget.reserveWei;
  r = await budget.check(6);
  assert.equal(r.stop, true, 'at the reserve it stops');
  assert.match(r.reason, /reached the .* reserve/);
  assert.match(r.reason, /before it goes into debt/);
});

// Found by the test above, and worth keeping deliberately: the reserve is
// three times the *current* cost estimate, and the estimate tracks the
// measured burn upward. So a run burning far faster than predicted stops while
// its raw balance still looks comfortable. That is the intended order of
// events -- the reserve exists to absorb the events already in flight, and a
// steeper burn means each of those costs more.
test('a steep burn widens the reserve and can stop a run that still looks funded', async () => {
  const rpc = new FakeRpc(10n * ETH);
  const budget = new ReactorBudget(rpc, REACTOR);
  await budget.preflight(500);

  rpc.balance = 5n * ETH; // half of it gone in two reactions: 2.5 each
  const r = await budget.check(2);

  assert.equal(budget.costWei, 2_500_000_000_000_000_000n);
  assert.equal(budget.reserveWei, 7_500_000_000_000_000_000n);
  assert.equal(r.stop, true, '5 lREACT is below a 7.5 lREACT reserve');
});

test('debt appearing mid-run stops it immediately, whatever the balance says', async () => {
  const rpc = new FakeRpc(ETH);
  const budget = new ReactorBudget(rpc, REACTOR);
  await budget.preflight(100);

  rpc.debt = 1n; // balance is still a whole lREACT
  const stopped = await budget.check(5);
  assert.equal(stopped.stop, true);
  assert.match(stopped.reason, /suspended/);
});

// The estimate being too low is the only direction that does damage, so a
// measurement above it replaces it. The first live run under-budgeted and had
// no mechanism to notice.
test('a measured cost above the estimate raises the estimate and the reserve with it', async () => {
  const rpc = new FakeRpc(ETH);
  const budget = new ReactorBudget(rpc, REACTOR);
  await budget.preflight(100);
  const reserveBefore = budget.reserveWei;

  // Ten reactions have cost 0.5 lREACT: 0.05 each, four times the estimate.
  rpc.balance = ETH / 2n;
  const r = await budget.check(10);

  assert.equal(r.spent, ETH / 2n);
  assert.equal(r.measuredWei, 50_000_000_000_000_000n);
  assert.equal(budget.costWei, 50_000_000_000_000_000n, 'estimate follows the measurement up');
  assert.ok(budget.reserveWei > reserveBefore, 'and the reserve widens with it');
});

test('a measured cost below the estimate is ignored, so the reserve never shrinks', async () => {
  const rpc = new FakeRpc(ETH);
  const budget = new ReactorBudget(rpc, REACTOR);
  await budget.preflight(100);

  rpc.balance = ETH - 1_000_000_000_000_000n; // 0.001 for ten reactions
  await budget.check(10);
  assert.equal(budget.costWei, DEFAULT_COST_WEI, 'a cheap stretch must not relax the guard');
});
