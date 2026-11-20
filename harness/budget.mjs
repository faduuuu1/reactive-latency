// Keeps a run from killing the contract it is measuring.
//
// A reactive contract pays the network for every event delivered to it. The
// failure mode that matters is not "the run stops when the money runs out" --
// it is worse than that, and asymmetric in a way that is easy to miss until it
// has already happened:
//
//   * While the balance lasts, each delivered event debits the reactor.
//   * When an event arrives that the balance cannot cover, the network records
//     the shortfall as a *debt* against the reactor's address and suspends its
//     subscription. No further events arrive.
//   * Paying the debt resumes the subscription -- but only the reactor itself
//     can pay it. `IPayable.receive()` credits `msg.sender`, so funding from an
//     EOA credits the EOA, and `AbstractPayer._coverDebt()` is `internal`. A
//     reactor that does not expose it is finished, at any balance.
//
// So the cost of overrunning the budget is not a truncated dataset, it is the
// deployment. On 20 Nov 2026 this harness proved that on the real thing: a
// 115-sample run drained the first reactor and left it holding 0.41 lREACT
// against 0.0137 owed, with no way to spend the one on the other.
// NOTES-reactor-debt.md has the account. `StopLossReactor.coverDebt()` is the
// contract-side fix; this module is the harness-side one, and both are wanted.
// The contract fix only helps a contract that has it, and a guard that stops
// the run early is cheaper than a recovery that needs a transaction.

export const SYSTEM_CONTRACT = '0x8888888888888888888888888888888888888888';

/** `debt(address)` on the system contract. */
const DEBT_SELECTOR = '0x9b6c56ec';

/** Measured on Lasna, 20 Nov 2026: ~0.013 lREACT per delivered event. */
export const DEFAULT_COST_WEI = 13_000_000_000_000_000n;

export const encodeDebtCall = (address) =>
  DEBT_SELECTOR + address.replace(/^0x/, '').toLowerCase().padStart(64, '0');

export const formatEther = (wei) => {
  const neg = wei < 0n;
  const v = neg ? -wei : wei;
  const s = (v / 10n ** 18n).toString();
  const frac = (v % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${s}${frac ? '.' + frac : ''}`;
};

export class ReactorBudget {
  /**
   * @param {import('./rpc.mjs').Rpc} rpc  Reactive-network RPC.
   * @param {string} reactor               Reactor address.
   * @param {{costWei?: bigint, reserveReactions?: number}} opts
   */
  constructor(rpc, reactor, { costWei = DEFAULT_COST_WEI, reserveReactions = 3 } = {}) {
    this.rpc = rpc;
    this.reactor = reactor;
    this.costWei = costWei;
    // The cost of the next event is only known after it has been billed, so
    // the floor has to leave room for events already in flight. Three is not
    // a deep result; it is one for the event being delivered, one for a
    // trigger costing more than a plain reaction, and one for being wrong.
    this.reserveReactions = reserveReactions;
    this.startBalance = null;
    this.reactionsBilled = 0;
  }

  get reserveWei() {
    return this.costWei * BigInt(this.reserveReactions);
  }

  async read() {
    const [balance, debtRaw] = await Promise.all([
      this.rpc.getBalance(this.reactor),
      this.rpc.ethCall(SYSTEM_CONTRACT, encodeDebtCall(this.reactor)),
    ]);
    return { balance, debt: BigInt(debtRaw) };
  }

  /**
   * Called once before the first push.
   * @returns {Promise<{ok: boolean, fatal: boolean, affordable: number, lines: string[]}>}
   */
  async preflight(samples) {
    const { balance, debt } = await this.read();
    this.startBalance = balance;
    const lines = [];

    if (debt > 0n) {
      // Not a warning. Every push after this point costs origin-chain gas and
      // produces nothing, because the subscription is already suspended.
      return {
        ok: false,
        fatal: true,
        affordable: 0,
        lines: [
          `reactor ${this.reactor} owes ${formatEther(debt)} to the network and is suspended.`,
          `It holds ${formatEther(balance)}, which it cannot spend: only the reactor can pay its own debt.`,
          `If it exposes coverDebt(), call it:  cast send ${this.reactor} 'coverDebt()' --rpc-url $REACTIVE_RPC_URL`,
          'If it does not, the deployment is unrecoverable. See NOTES-reactor-debt.md.',
        ],
      };
    }

    const spendable = balance - this.reserveWei;
    const affordable = spendable > 0n ? Number(spendable / this.costWei) : 0;

    lines.push(
      `reactor budget ${formatEther(balance)} at ~${formatEther(this.costWei)}/reaction ` +
        `=> ~${affordable} reactions before the reserve, reserve ${formatEther(this.reserveWei)}`
    );

    if (affordable < samples) {
      lines.push(
        `! ${samples} samples requested, about ${affordable} affordable. The run will stop ` +
          'when the reserve is reached rather than push the reactor into debt.'
      );
    }
    return { ok: affordable > 0, fatal: affordable <= 0, affordable, lines };
  }

  /**
   * Called before each sample, so that every exit path is covered without
   * having to thread a check through each one.
   * @param {number} reactionsBilled Reactions the network has billed so far.
   * @returns {Promise<{balance: bigint, debt: bigint, spent: bigint, measuredWei: bigint|null, stop: boolean, reason: string|null}>}
   */
  async check(reactionsBilled) {
    const { balance, debt } = await this.read();
    this.reactionsBilled = reactionsBilled;
    const spent = this.startBalance === null ? 0n : this.startBalance - balance;
    const measuredWei =
      reactionsBilled > 0 && spent > 0n ? spent / BigInt(reactionsBilled) : null;

    // Trust the measurement once it disagrees upward: an estimate that is too
    // low is the one that does damage, and the first live run under-budgeted
    // by a factor the estimate never saw.
    if (measuredWei && measuredWei > this.costWei) this.costWei = measuredWei;

    if (debt > 0n) {
      return {
        balance,
        debt,
        spent,
        measuredWei,
        stop: true,
        reason: `reactor went into debt (${formatEther(debt)}) -- subscription suspended`,
      };
    }
    if (balance <= this.reserveWei) {
      return {
        balance,
        debt,
        spent,
        measuredWei,
        stop: true,
        reason:
          `reactor balance ${formatEther(balance)} reached the ` +
          `${formatEther(this.reserveWei)} reserve -- stopping before it goes into debt`,
      };
    }
    return { balance, debt, spent, measuredWei, stop: false, reason: null };
  }
}
