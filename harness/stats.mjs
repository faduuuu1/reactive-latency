// Pure analysis. No network, no clock, no filesystem — so the whole of it can
// be tested against fixtures without a single wei of gas.

/**
 * Nearest-rank percentile, no interpolation.
 *
 * Interpolating between two samples invents a latency that was never observed.
 * For a distribution this small and this lumpy that is worse than useless, so
 * every number this reports is a measurement that actually happened.
 */
export function percentile(values, q) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(q * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

/**
 * Percentiles are only reported once enough samples exist to mean anything.
 * p99 of twenty samples is the maximum wearing a hat.
 */
export function summarize(values) {
  const n = values.length;
  if (n === 0) return { n: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const out = {
    n,
    min: sorted[0],
    max: sorted[n - 1],
    mean: sum / n,
    p50: percentile(sorted, 0.5),
  };
  if (n >= 10) out.p90 = percentile(sorted, 0.9);
  if (n >= 100) out.p99 = percentile(sorted, 0.99);
  return out;
}

export class SampleError extends Error {}

/**
 * Derive the latencies of one sample.
 *
 * ## The thing that makes this honest
 *
 * t0 and t1 are block timestamps from *different chains*. Nothing synchronises
 * two chains' clocks, so `t1 - t0` is `(true latency) + (Lasna's clock offset
 * from Base Sepolia's)`. The offset is unknown and can be either sign — which
 * is why a negative leg is not a bug in the harness, it is the skew showing
 * through.
 *
 * `t2 - t0` is different in kind: both come from Base Sepolia, so the offset
 * cancels exactly. **That is the only block-timestamp figure here that measures
 * latency and nothing else**, and it is the one to quote.
 *
 * The legs are still worth reporting, because a constant offset shifts their
 * mean but leaves their *spread* intact. Their variance is real even when
 * their centre is not.
 */
export function derive(sample) {
  const { origin, reaction, execution } = sample;

  if (!origin || !reaction) {
    const who =
      sample.seq !== undefined ? `sample seq ${sample.seq}` : `sample #${sample.index}`;
    throw new SampleError(
      sample.failed
        ? `${who}: collection failed at stage "${sample.failed}"`
        : `${who}: missing origin or reaction`
    );
  }

  // The reactor echoes the origin block it reacted to. If that does not match
  // the block our push actually landed in, we have paired a reaction with the
  // wrong update and every number downstream is fiction.
  if (reaction.originBlock !== origin.blockNumber) {
    throw new SampleError(
      `sample ${sample.seq}: reaction reports origin block ${reaction.originBlock}, ` +
        `but the push landed in ${origin.blockNumber} — mismatched pairing`
    );
  }

  const d = {
    seq: sample.seq,
    triggered: sample.triggered,

    // Cross-chain. Carries clock skew. Spread is meaningful, centre is not.
    crossChain: {
      originToReactionSec: reaction.blockTimestamp - origin.blockTimestamp,
    },

    // Same chain at both ends. Skew-free. This is the headline.
    sameChain: {},

    // One observer, one clock, so no skew — but it includes RPC round-trips
    // and the poll interval, so it is an upper bound rather than the latency.
    wallMs: {
      sentToReactionSeen: reaction.observedAtMs - origin.sentAtMs,
    },

    reactiveBlocks: null,
  };

  if (execution) {
    d.crossChain.reactionToExecutionSec =
      execution.blockTimestamp - reaction.blockTimestamp;
    d.sameChain.endToEndSec = execution.blockTimestamp - origin.blockTimestamp;
    d.sameChain.originBlocks = execution.blockNumber - origin.blockNumber;
    d.wallMs.sentToExecutionSeen = execution.observedAtMs - origin.sentAtMs;

    // The same interval as crossChain.reactionToExecutionSec, measured the
    // other way. Both ends are observations by one process, so this one has
    // no cross-chain offset in it. Holding the two side by side is what
    // makes the offset itself measurable - see estimateClockOffset.
    d.wallMs.reactionToExecutionSeen =
      execution.observedAtMs - reaction.observedAtMs;
  }

  return d;
}

/**
 * Estimate the offset between the two chains' clocks.
 *
 * `reaction -> execution` can be measured two ways: by subtracting block
 * timestamps across a chain boundary, which carries the offset, and by
 * subtracting two observations made by one process, which does not. The
 * difference between them is the offset, with the latency cancelling out.
 *
 * ## Why this exists, when there is already a negative-median check
 *
 * That check only fires when a cross-chain leg reads negative, which proves
 * an offset because a reaction cannot precede its cause. It is a sufficient
 * condition, **not a necessary one** - and the first real run showed exactly
 * how it fails. Lasna read 1.69s behind Base Sepolia while the true
 * origin->reaction latency was also about 1.69s, so the two cancelled and
 * the leg measured 0.00s: no negative median, no detection, and an apparent
 * zero-latency reaction that is not physically possible.
 *
 * This estimator does not depend on the offset and the latency failing to
 * cancel, so it sees what the other check cannot.
 *
 * It is an estimate, not a reading. Block timestamps are whole seconds, so
 * each sample carries up to a second of quantisation, and the single-clock
 * side is inflated by up to one poll interval at each end. Both average down
 * over a run; neither disappears. Read it to the nearest half second.
 */
export function estimateClockOffset(derived) {
  const pairs = derived.filter(
    (d) =>
      typeof d.crossChain.reactionToExecutionSec === 'number' &&
      typeof d.wallMs.reactionToExecutionSeen === 'number'
  );
  if (pairs.length === 0) return null;

  const offsets = pairs.map(
    (d) => d.crossChain.reactionToExecutionSec - d.wallMs.reactionToExecutionSeen / 1000
  );
  const summary = summarize(offsets);

  return {
    n: pairs.length,
    medianSec: summary.p50,
    minSec: summary.min,
    maxSec: summary.max,
    // Positive means the reactive chain's clock reads behind the origin's.
    direction: summary.p50 > 0 ? 'reactive chain behind origin' : 'reactive chain ahead of origin',
  };
}

/**
 * Fold a run of samples into a report.
 *
 * Samples that fail their pairing check are not quietly dropped: they are
 * counted and listed, because a run where half the pairings failed is not a
 * run with fewer samples, it is a broken measurement.
 */
export function analyse(samples) {
  const derived = [];
  const rejected = [];

  for (const s of samples) {
    try {
      derived.push(derive(s));
    } catch (err) {
      if (!(err instanceof SampleError)) throw err;
      rejected.push({ seq: s.seq, reason: err.message });
    }
  }

  const triggered = derived.filter((d) => d.triggered);
  const withExecution = derived.filter((d) => d.sameChain.endToEndSec !== undefined);

  const pick = (arr, path) =>
    arr.map((d) => path.split('.').reduce((o, k) => o?.[k], d)).filter((v) => typeof v === 'number');

  const report = {
    counts: {
      collected: samples.length,
      usable: derived.length,
      rejected: rejected.length,
      triggered: triggered.length,
      executed: withExecution.length,
    },
    rejected,

    endToEndSec: summarize(pick(withExecution, 'sameChain.endToEndSec')),
    originBlocks: summarize(pick(withExecution, 'sameChain.originBlocks')),

    originToReactionSec: summarize(pick(derived, 'crossChain.originToReactionSec')),
    reactionToExecutionSec: summarize(pick(withExecution, 'crossChain.reactionToExecutionSec')),

    sentToReactionSeenMs: summarize(pick(derived, 'wallMs.sentToReactionSeen')),
    sentToExecutionSeenMs: summarize(pick(withExecution, 'wallMs.sentToExecutionSeen')),

    samples: derived,
  };

  report.clockSkew = skewNote(report.originToReactionSec);
  report.clockOffset = estimateClockOffset(derived);

  // With an offset estimate in hand, the cross-chain legs can be stated the
  // way they would read if the clocks agreed. These are corrected figures,
  // kept apart from the measured ones rather than quietly replacing them.
  if (report.clockOffset) {
    const off = report.clockOffset.medianSec;
    report.corrected = {
      note:
        `Cross-chain legs with the estimated ${off.toFixed(2)}s offset removed. ` +
        `Derived, not measured: the offset is itself an estimate, so treat these ` +
        `as accurate to about half a second.`,
      originToReactionSec:
        report.originToReactionSec.n > 0 ? report.originToReactionSec.p50 + off : null,
      reactionToExecutionSec:
        report.reactionToExecutionSec.n > 0 ? report.reactionToExecutionSec.p50 - off : null,
    };
  }

  return report;
}

/**
 * A negative median on a cross-chain leg is physically impossible as a latency:
 * the reaction cannot be observed before the event that caused it. So it is
 * direct evidence of clock offset, and its magnitude is a lower bound on that
 * offset. Saying so is more useful than printing a negative latency and hoping
 * nobody reads it.
 */
export function skewNote(originToReaction) {
  if (!originToReaction || originToReaction.n === 0) return null;
  const median = originToReaction.p50;
  if (median < 0) {
    return {
      detected: true,
      impliedMinOffsetSec: -median,
      note:
        `Median origin→reaction is ${median}s. A reaction cannot precede its cause, ` +
        `so Lasna's clock reads at least ${-median}s behind Base Sepolia's. The ` +
        `cross-chain legs below are shifted by that offset; the end-to-end figure is not.`,
    };
  }
  return {
    detected: false,
    note:
      'No negative cross-chain median, so no clock offset is provable from this run. ' +
      'An unprovable offset is not an absent one: the legs may still be shifted by ' +
      'an unknown constant. Only the end-to-end figure is skew-free.',
  };
}
