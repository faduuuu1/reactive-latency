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
  L.push(`Run started \`${run.startedAt}\`, finished \`${run.finishedAt ?? 'incomplete'}\`.`);
  L.push('');
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
  const input = args.find((a) => !a.startsWith('--')) ?? 'results/samples-latest.json';
  const outIdx = args.indexOf('--out');
  const out = outIdx >= 0 ? args[outIdx + 1] : 'results/REPORT.md';

  const run = JSON.parse(readFileSync(input, 'utf8'));
  const { markdown } = build(run);

  writeFileSync(out, markdown + '\n');
  console.log(markdown);
  console.error(`\nwrote ${out}`);
}

export { build };

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('report.mjs')) {
  main();
}
