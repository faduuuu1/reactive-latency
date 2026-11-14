// node --test harness/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { percentile, summarize, derive, analyse, skewNote, SampleError } from './stats.mjs';
import { build } from './report.mjs';

const FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/samples.synthetic.json', import.meta.url), 'utf8')
);

// --- percentiles ---

test('percentile uses nearest rank, so it only ever returns an observed value', () => {
  const values = [10, 20, 30, 40];
  // Interpolating p50 here would give 25, a latency nobody measured.
  assert.equal(percentile(values, 0.5), 20);
  for (const q of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99, 1]) {
    assert.ok(values.includes(percentile(values, q)), `p${q * 100} was not an observed value`);
  }
});

test('percentile is order-independent and handles the ends', () => {
  const shuffled = [40, 10, 30, 20];
  assert.equal(percentile(shuffled, 0.5), 20);
  assert.equal(percentile(shuffled, 0), 10);
  assert.equal(percentile(shuffled, 1), 40);
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([7], 0.9), 7);
});

test('percentiles are withheld until there are enough samples to mean anything', () => {
  const nine = summarize(Array.from({ length: 9 }, (_, i) => i));
  assert.equal(nine.p90, undefined, 'p90 of 9 samples should not be reported');
  assert.equal(nine.p99, undefined);
  assert.ok(nine.p50 !== undefined, 'a median is fine at 9');

  const ten = summarize(Array.from({ length: 10 }, (_, i) => i));
  assert.ok(ten.p90 !== undefined, 'p90 should appear at 10');
  assert.equal(ten.p99, undefined, 'p99 of 10 samples is the maximum wearing a hat');

  const hundred = summarize(Array.from({ length: 100 }, (_, i) => i));
  assert.ok(hundred.p99 !== undefined, 'p99 should appear at 100');
});

// --- per-sample derivation ---

const good = () => ({
  seq: 1,
  triggered: true,
  origin: { blockNumber: 1000, blockTimestamp: 500_000, sentAtMs: 1_000_000 },
  reaction: { blockNumber: 50, blockTimestamp: 499_998, originBlock: 1000, observedAtMs: 1_002_000 },
  execution: { blockNumber: 1015, blockTimestamp: 500_003, observedAtMs: 1_004_000 },
});

test('a reaction that names the wrong origin block is rejected, not averaged in', () => {
  const s = good();
  s.reaction.originBlock = 999;
  assert.throws(() => derive(s), SampleError);
  // The message has to say which block it expected, or the failure is unactionable.
  assert.match(
    (() => {
      try {
        derive(s);
      } catch (e) {
        return e.message;
      }
    })(),
    /999.*1000|1000.*999/
  );
});

test('end-to-end uses only origin-chain timestamps', () => {
  const s = good();
  const d = derive(s);
  assert.equal(d.sameChain.endToEndSec, 3); // 500_003 - 500_000
  assert.equal(d.sameChain.originBlocks, 15);

  // Move Lasna's clock by an hour. The cross-chain leg must move with it and
  // the end-to-end figure must not; that is the whole claim of this report.
  const skewed = good();
  skewed.reaction.blockTimestamp += 3600;
  const ds = derive(skewed);
  assert.equal(ds.sameChain.endToEndSec, 3, 'end-to-end must be immune to Lasna clock skew');
  assert.equal(
    ds.crossChain.originToReactionSec - d.crossChain.originToReactionSec,
    3600,
    'the cross-chain leg must absorb the whole offset'
  );
});

test('an untriggered sample yields a reaction leg and no execution figures', () => {
  const s = good();
  s.triggered = false;
  s.execution = null;
  const d = derive(s);
  assert.equal(d.crossChain.originToReactionSec, -2);
  assert.equal(d.sameChain.endToEndSec, undefined);
  assert.equal(d.wallMs.sentToExecutionSeen, undefined);
  assert.ok(typeof d.wallMs.sentToReactionSeen === 'number');
});

test('a collection failure is reported by the stage it failed at', () => {
  const err = (() => {
    try {
      derive({ index: 7, seq: 7, failed: 'no-reaction' });
    } catch (e) {
      return e;
    }
  })();
  assert.ok(err instanceof SampleError);
  assert.match(err.message, /no-reaction/);
});

// --- skew detection ---

test('a negative median proves a clock offset and bounds it from below', () => {
  const note = skewNote({ n: 20, p50: -3 });
  assert.equal(note.detected, true);
  assert.equal(note.impliedMinOffsetSec, 3);
  assert.match(note.note, /cannot precede its cause/);
});

test('no negative median is not a claim that the clocks agree', () => {
  const note = skewNote({ n: 20, p50: 2 });
  assert.equal(note.detected, false);
  assert.match(note.note, /unprovable offset is not an absent one/);
});

// --- the whole pipeline, against a fixture with known ground truth ---

test('analysis recovers the end-to-end distribution that was put in', () => {
  const truth = FIXTURE._groundTruth;
  const r = analyse(FIXTURE.samples);

  assert.equal(r.counts.executed, truth.triggered);
  assert.equal(r.endToEndSec.n, truth.triggered);

  // Computed from the ground-truth list, which derive() and analyse() never see.
  assert.equal(r.endToEndSec.p50, percentile(truth.endToEndSecTrue, 0.5));
  assert.equal(r.endToEndSec.p90, percentile(truth.endToEndSecTrue, 0.9));
  assert.equal(r.endToEndSec.p99, percentile(truth.endToEndSecTrue, 0.99));
  assert.equal(r.endToEndSec.min, Math.min(...truth.endToEndSecTrue));
  assert.equal(r.endToEndSec.max, Math.max(...truth.endToEndSecTrue));
});

test('the implied clock offset is a genuine lower bound on the real one', () => {
  const truth = FIXTURE._groundTruth;
  const r = analyse(FIXTURE.samples);

  assert.equal(r.clockSkew.detected, true, 'a 5s offset should be visible in the data');

  const realOffset = Math.abs(truth.lasnaClockOffsetSec);
  assert.ok(
    r.clockSkew.impliedMinOffsetSec <= realOffset,
    `implied ${r.clockSkew.impliedMinOffsetSec}s must not exceed the real ${realOffset}s`
  );
  assert.ok(r.clockSkew.impliedMinOffsetSec > 0);
});

test('mispaired and failed samples are counted and listed, never silently dropped', () => {
  const truth = FIXTURE._groundTruth;
  const r = analyse(FIXTURE.samples);

  assert.equal(
    r.counts.rejected,
    truth.mismatched + truth.collectionFailures,
    'every unusable sample must appear in the rejected count'
  );
  assert.equal(r.rejected.length, r.counts.rejected);
  assert.equal(r.counts.collected, r.counts.usable + r.counts.rejected);
  assert.ok(
    r.rejected.some((x) => /origin block/.test(x.reason)),
    'the mispaired sample should say so'
  );
});

test('the report renders, and leads with the skew-free figure', () => {
  const { markdown } = build(FIXTURE);
  assert.match(markdown, /# Cross-chain stop-loss: latency report/);
  assert.match(markdown, /end-to-end \(origin block -> execution block\)/);
  assert.match(markdown, /cannot precede its cause/);

  // The headline section must come before the cross-chain one, so the number
  // that means what it says is the one a skim-reader takes away.
  assert.ok(
    markdown.indexOf('The number that means what it says') <
      markdown.indexOf('Cross-chain legs, which carry clock offset')
  );
  assert.ok(!markdown.includes('undefined'), 'no undefined leaked into the report');
  assert.ok(!markdown.includes('NaN'), 'no NaN leaked into the report');
});

test('a report from a handful of samples withholds the percentiles it cannot justify', () => {
  const small = { ...FIXTURE, samples: FIXTURE.samples.slice(0, 6) };
  const { markdown } = build(small);
  assert.match(markdown, /Percentiles omitted for want of samples/);
  assert.match(markdown, /p90 \(needs 10 samples\)/);
  assert.match(markdown, /p99 \(needs 100 samples\)/);
});

test('an empty run reports nothing rather than dividing by zero', () => {
  const empty = { ...FIXTURE, samples: [], _groundTruth: undefined };
  const r = analyse([]);
  assert.equal(r.counts.collected, 0);
  assert.equal(r.endToEndSec.n, 0);
  assert.equal(r.clockSkew, null);
  const { markdown } = build(empty);
  assert.ok(!markdown.includes('NaN'));
});
