#!/usr/bin/env node
// Turns a sample file into a report. Reads, computes, writes - and does no
// network of its own, so a run can be re-analysed years later, or the analysis
// can be argued with without re-spending the gas that produced it.
//
// Usage:
//   node harness/report.mjs results/samples-latest.json [--out results/REPORT.md]

import { readFileSync, writeFileSync } from 'node:fs';
import { analyse, summarize } from './stats.mjs';

const UNITS = { sec: 's', ms: 'ms', blocks: '' };

function fmt(v, unit) {
  if (v === null || v === undefined) return '-';
  const n = typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(1) : String(v);
  return unit === 'blocks' ? n : `${n}${UNITS[unit] ?? ''}`;
}

function summaryRow(label, s, unit) {
  if (!s || s.n === 0) return `| ${label} | 0 | - | - | - | - | - | - |`;
  return (
    `| ${label} | ${s.n} | ${fmt(s.min, unit)} | ${fmt(s.p50, unit)} | ` +
    `${fmt(s.p90, unit)} | ${fmt(s.p99, unit)} | ${fmt(s.max, unit)} | ${fmt(s.mean, unit)} |`
  );
}

const HEAD = '| metric | n | min | p50 | p90 | p99 | max | mean |\n|---|---:|---:|---:|---:|---:|---:|---:|';

/**
 * Concatenate several runs of the same deployment into one analysable run.
 *
 * Worth doing rather than quoting two tables side by side: percentile gates
 * are counts, and two thirty-callback runs clear a gate that neither clears
 * alone. Worth doing *carefully*, because concatenation is also the easiest
 * way to manufacture a number nobody measured. Hence the two refusals below.
 *
 * Combining runs from different deployments would be meaningless, and
 * combining the same run twice would halve every percentile gate for free.
 * Both are rejected rather than warned about -- a warning in a report nobody
 * reads line by line is not a safeguard.
 */
export function mergeRuns(entries) {
  if (entries.length === 0) throw new Error('no runs to merge');
  if (entries.length === 1) return entries[0].run;

  const deployment = (r) =>
    JSON.stringify({
      originChainId: r.origin?.chainId,
      priceFeed: r.origin?.priceFeed,
      executor: r.origin?.executor,
      reactiveChainId: r.reactive?.chainId,
      reactor: r.reactive?.reactor,
      floor: r.reactive?.floor,
    });

  const first = deployment(entries[0].run);
  for (const e of entries.slice(1)) {
    if (deployment(e.run) !== first) {
      throw new Error(
        `${e.file} measures a different deployment from ${entries[0].file}; ` +
          'latencies from different contracts are not samples of one population'
      );
    }
  }

  // Same run passed twice, or overlapping files. The feed's sequence number is
  // monotonic per deployment, so a repeated seq can only mean a repeated
  // sample.
  const seen = new Map();
  for (const e of entries) {
    for (const x of e.run.samples) {
      if (x.seq === undefined) continue;
      if (seen.has(x.seq)) {
        throw new Error(
          `seq ${x.seq} appears in both ${seen.get(x.seq)} and ${e.file}; ` +
            'the same sample cannot be counted twice'
        );
      }
      seen.set(x.seq, e.file);
    }
  }

  const polls = [...new Set(entries.map((e) => e.run.options?.poll))];
  const started = entries.map((e) => e.run.startedAt).filter(Boolean).sort();
  const finished = entries.map((e) => e.run.finishedAt).filter(Boolean).sort();

  return {
    ...entries[0].run,
    startedAt: started[0],
    finishedAt: finished[finished.length - 1],
    samples: entries.flatMap((e) => e.run.samples),
    // Provenance travels with the merged run, so the report can show which
    // files produced it instead of asserting a total.
    sources: entries.map((e) => {
      const a = analyse(e.run.samples);
      return {
        file: e.file,
        startedAt: e.run.startedAt,
        pattern: e.run.options?.pattern ?? '?',
        poll: e.run.options?.poll,
        pushes: a.counts.collected,
        callbacks: a.counts.executed,
      };
    }),
    // Only meaningful if every run observed at the same resolution. Recorded
    // either way; the report says so when they differ.
    mixedPollIntervals: polls.length > 1 ? polls : null,
  };
}

function build(run) {
  const r = analyse(run.samples);
  const L = [];

  // The callback leg, measured on one clock. Both numbers come from the same
  // observer, so their difference has no cross-chain offset in it at all -
  // which makes this the only per-leg figure here that is skew-free. It is
  // still an upper bound, because each end carries up to one poll interval.
  const callbackLegMs = r.samples
    .filter((d) => typeof d.wallMs.sentToExecutionSeen === 'number')
    .map((d) => d.wallMs.sentToExecutionSeen - d.wallMs.sentToReactionSeen);
  const callbackLeg = summarize(callbackLegMs);

  const stages = {};
  for (const s of run.samples) if (s.failed) stages[s.failed] = (stages[s.failed] ?? 0) + 1;

  L.push('# Cross-chain stop-loss: latency report');
  L.push('');
  if (run.sources) {
    L.push(
      `**${run.sources.length} independent runs of the same deployment, combined.** ` +
        `Earliest started \`${run.startedAt}\`, latest finished \`${run.finishedAt ?? 'incomplete'}\`.`
    );
    L.push('');
    L.push('| source | started | pattern | pushes | callbacks |');
    L.push('|---|---|---|---:|---:|');
    for (const x of run.sources) {
      L.push(
        `| \`${x.file}\` | ${x.startedAt} | ${x.pattern} | ${x.pushes} | ${x.callbacks} |`
      );
    }
    L.push('');
    L.push(
      'Separate runs, days apart, under different trigger patterns. That makes the ' +
        'agreement between them evidence rather than arithmetic: a median reproduced ' +
        'on a second run is a stronger claim than the same median from one run twice ' +
        'the size.'
    );
    L.push('');
    if (run.mixedPollIntervals) {
      L.push(
        `> These runs observed at different poll intervals (${run.mixedPollIntervals.join('ms, ')}ms). ` +
          'The end-to-end figure is built from block timestamps and is unaffected, but ' +
          'every wall-clock row below mixes two resolutions and should be read as the ' +
          'coarser of them.'
      );
      L.push('');
    }
  } else {
    L.push(`Run started \`${run.startedAt}\`, finished \`${run.finishedAt ?? 'incomplete'}\`.`);
    L.push('');
  }
  L.push('| | |');
  L.push('|---|---|');
  L.push(`| origin chain | \`${run.origin?.chainId}\` |`);
  L.push(`| price feed | \`${run.origin?.priceFeed}\` |`);
  L.push(`| executor | \`${run.origin?.executor}\` |`);
  L.push(`| reactive chain | \`${run.reactive?.chainId}\` |`);
  L.push(`| reactor | \`${run.reactive?.reactor}\` |`);
  L.push(`| floor | \`${run.reactive?.floor}\` |`);
  L.push(`| poll interval | ${run.options?.poll}ms |`);
  L.push('');
  L.push(
    `**${r.counts.collected} pushes · ${r.counts.usable} usable · ` +
      `${r.counts.triggered} crossed the floor · ${r.counts.executed} callbacks landed.**`
  );
  L.push('');

  if (run.stoppedEarly) {
    L.push(
      `> **This run stopped early:** ${run.stoppedEarly} The samples above are every ` +
        'one it completed, not a truncated view of more.'
    );
    L.push('');
  }

  if (Object.keys(stages).length) {
    L.push('Collection failures by stage: ' +
      Object.entries(stages).map(([k, v]) => `\`${k}\` ×${v}`).join(', ') + '.');
    L.push('');
  }

  L.push('## The number that means what it says');
  L.push('');
  L.push(
    'End-to-end is the origin block timestamp subtracted from the execution block ' +
      'timestamp. **Both come from the same chain**, so whatever offset exists between ' +
      "the two networks' clocks cancels exactly. Nothing else in this report has that " +
      'property.'
  );
  L.push('');
  L.push(HEAD);
  L.push(summaryRow('end-to-end (origin block -> execution block)', r.endToEndSec, 'sec'));
  L.push(summaryRow('origin blocks elapsed', r.originBlocks, 'blocks'));
  L.push('');
  L.push(
    '> Block timestamps are whole seconds while Base Sepolia produces blocks about ' +
      'every 200ms, so a `0s` end-to-end means *within the same second*, not instant, ' +
      'and the resolution here is ±1s. The block count in the second row is the finer ' +
      'measure of the same interval.'
  );
  L.push('');

  L.push('## The callback leg, on a single clock');
  L.push('');
  L.push(
    'Both ends of this figure are observations by the same process, so it carries no ' +
      'cross-chain offset either. It is an upper bound rather than the latency: each ' +
      `end can be late by up to one poll interval (${run.options?.poll}ms).`
  );
  L.push('');
  L.push(HEAD);
  L.push(summaryRow('reaction seen -> execution seen', callbackLeg, 'ms'));
  L.push('');

  L.push('## Observer wall clock');
  L.push('');
  L.push(
    'Measured from the moment the push was handed to `cast` until the event was ' +
      'visible over RPC. Includes transaction propagation, inclusion, the poll gap and ' +
      'the RPC round trip. One clock throughout, so no skew - but an upper bound on ' +
      'every stage it spans.'
  );
  L.push('');
  L.push(HEAD);
  L.push(summaryRow('push sent -> reaction seen', r.sentToReactionSeenMs, 'ms'));
  L.push(summaryRow('push sent -> execution seen', r.sentToExecutionSeenMs, 'ms'));
  L.push('');

  L.push('## Cross-chain legs, which carry clock offset');
  L.push('');
  L.push(
    'These two subtract a timestamp on one chain from a timestamp on another. Nothing ' +
      "synchronises those clocks, so each figure is the true latency plus the networks' " +
      'offset, and that offset is unknown and can be of either sign. Their **spread** ' +
      'survives this - a constant offset shifts the centre and leaves the variance ' +
      'alone - so read the min-to-max range, not the median.'
  );
  L.push('');
  L.push(HEAD);
  L.push(summaryRow('origin -> reaction', r.originToReactionSec, 'sec'));
  L.push(summaryRow('reaction -> execution', r.reactionToExecutionSec, 'sec'));
  L.push('');
  if (r.clockSkew) {
    L.push(`> ${r.clockSkew.note}`);
    L.push('');
  }

  if (r.clockOffset) {
    const o = r.clockOffset;
    L.push('### Measuring the offset instead of inferring it');
    L.push('');
    L.push(
      '`reaction -> execution` appears twice in this report: once from block ' +
        'timestamps across a chain boundary, once from two observations by a single ' +
        'process. The latency is the same in both. The difference between them is ' +
        'therefore the clock offset, with the latency cancelling out.'
    );
    L.push('');
    L.push('| | |');
    L.push('|---|---|');
    L.push(`| samples | ${o.n} |`);
    L.push(`| **estimated offset** | **${o.medianSec.toFixed(2)}s**, ${o.direction} |`);
    L.push(`| range across samples | ${o.minSec.toFixed(2)}s to ${o.maxSec.toFixed(2)}s |`);
    L.push('');
    if (r.corrected) {
      L.push('With that removed, the legs read:');
      L.push('');
      L.push('| leg | as measured | offset removed |');
      L.push('|---|---:|---:|');
      L.push(
        `| origin -> reaction | ${fmt(r.originToReactionSec.p50, 'sec')} | ` +
          `**${fmt(Number(r.corrected.originToReactionSec.toFixed(2)), 'sec')}** |`
      );
      L.push(
        `| reaction -> execution | ${fmt(r.reactionToExecutionSec.p50, 'sec')} | ` +
          `**${fmt(Number(r.corrected.reactionToExecutionSec.toFixed(2)), 'sec')}** |`
      );
      L.push('');
      L.push(`> ${r.corrected.note}`);
      L.push('');
    }
    if (!r.clockSkew.detected && Math.abs(o.medianSec) > 0.5) {
      L.push(
        `**This is the case the negative-median test cannot see.** It reports no ` +
          `offset, because no cross-chain leg came out negative — yet the offset is ` +
          `${o.medianSec.toFixed(2)}s. The two cancelled: the true origin-to-reaction ` +
          `latency is close to the offset, so the measured leg sits near zero and looks ` +
          `innocuous. A reaction arriving in the same second as its cause is not ` +
          `plausible at these block times, and that implausibility is the only hint the ` +
          `first test leaves behind.`
      );
      L.push('');
    }
  }

  if (r.rejected.length) {
    L.push('## Rejected samples');
    L.push('');
    L.push(
      'Listed rather than dropped. A run where many samples failed to pair is not a ' +
        'smaller run, it is a broken measurement, and hiding them would make it look ' +
        'like the former.'
    );
    L.push('');
    for (const x of r.rejected) L.push(`- ${x.reason}`);
    L.push('');
  }

  L.push('## Every sample');
  L.push('');
  L.push('| seq | fired | end-to-end | origin blocks | origin->reaction | reaction->exec | sent->reaction seen | sent->exec seen |');
  L.push('|---:|:---:|---:|---:|---:|---:|---:|---:|');
  for (const d of r.samples) {
    L.push(
      `| ${d.seq} | ${d.triggered ? 'yes' : 'no'} | ` +
        `${fmt(d.sameChain.endToEndSec, 'sec')} | ${fmt(d.sameChain.originBlocks, 'blocks')} | ` +
        `${fmt(d.crossChain.originToReactionSec, 'sec')} | ` +
        `${fmt(d.crossChain.reactionToExecutionSec, 'sec')} | ` +
        `${fmt(d.wallMs.sentToReactionSeen, 'ms')} | ${fmt(d.wallMs.sentToExecutionSeen, 'ms')} |`
    );
  }
  L.push('');

  const omitted = [];
  if (r.endToEndSec.n > 0 && r.endToEndSec.n < 10) omitted.push('p90 (needs 10 samples)');
  if (r.endToEndSec.n > 0 && r.endToEndSec.n < 100) omitted.push('p99 (needs 100 samples)');
  if (omitted.length) {
    L.push(
      `_Percentiles omitted for want of samples: ${omitted.join(', ')}. ` +
        'A p99 drawn from twenty samples is the maximum wearing a hat, so it is left ' +
        'blank rather than printed._'
    );
    L.push('');
  }

  return { markdown: L.join('\n'), analysis: r };
}

function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const out = outIdx >= 0 ? args[outIdx + 1] : 'results/REPORT.md';

  // `--out X` puts a bare path in argv that is not an input. The old filter
  // took the first non-flag argument, so `report.mjs --out r.md` quietly
  // analysed r.md.
  const inputs = args.filter((a, i) => !a.startsWith('--') && i !== outIdx + 1);
  if (inputs.length === 0) inputs.push('results/samples-latest.json');

  const entries = inputs.map((file) => ({ file, run: JSON.parse(readFileSync(file, 'utf8')) }));
  const { markdown } = build(mergeRuns(entries));

  writeFileSync(out, markdown + '\n');
  console.log(markdown);
  console.error(`\nwrote ${out}`);
}

export { build };

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('report.mjs')) {
  main();
}
