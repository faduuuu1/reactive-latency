#!/usr/bin/env node
// Recovers the reaction and callback transaction hashes for a run collected
// before the collector recorded them.
//
//   node harness/backfill-hashes.mjs results/samples-latest.json         # dry run
//   node harness/backfill-hashes.mjs results/samples-latest.json --write
//
// The first live run stored each leg's block number and timestamp but dropped
// the `transactionHash` that eth_getLogs hands over for free. The events are
// still on chain, so the hashes are recoverable exactly: every sample carries
// the block the event landed in and the sequence number indexed in its first
// topic, which together identify one log and no other.
//
// ## This is a verification pass, not just a lookup
//
// Re-fetching the log yields the numbers the run already claims — the block
// it landed in, the origin block the reactor echoed, the timestamp it
// recorded. Every one of them is checked against what the sample says, and a
// single disagreement aborts the write for the whole file.
//
// That matters more than the convenience. A hash that was fetched from a log
// whose contents contradict the sample would be a hash for some *other*
// event, quietly pasted next to latency figures it has nothing to do with -
// which is precisely the kind of evidence that looks strongest and means
// least. Refusing to write is the only safe failure here.

import { readFileSync, writeFileSync } from 'node:fs';

import { Rpc, words } from './rpc.mjs';
import { loadEnv, need, readJson, topic0, topicUint } from './env.mjs';

const EVENTS = readJson(new URL('./events.json', import.meta.url));

class MismatchError extends Error {}

/** Fetch the one log matching (address, topic0, seq) in a single block. */
async function logFor(rpc, { address, topic, seq, blockNumber, what }) {
  const logs = await rpc.getLogs({
    address,
    topics: [topic, topicUint(seq)],
    fromBlock: blockNumber,
    toBlock: blockNumber,
  });
  if (logs.length === 0) {
    throw new MismatchError(`seq ${seq}: no ${what} log in block ${blockNumber}`);
  }
  if (logs.length > 1) {
    // seq is monotonic and indexed, so two in one block means the filter is
    // matching something it should not, and picking one would be a guess.
    throw new MismatchError(`seq ${seq}: ${logs.length} ${what} logs in block ${blockNumber}`);
  }
  const log = logs[0];
  if (Number(log.blockNumber) !== blockNumber) {
    throw new MismatchError(
      `seq ${seq}: ${what} log says block ${Number(log.blockNumber)}, sample says ${blockNumber}`
    );
  }
  return log;
}

function check(cond, message) {
  if (!cond) throw new MismatchError(message);
}

async function main() {
  const args = process.argv.slice(2);
  const path = args.find((a) => !a.startsWith('--')) ?? 'results/samples-latest.json';
  const write = args.includes('--write');

  loadEnv();
  const run = JSON.parse(readFileSync(path, 'utf8'));

  const originCfg = readJson('deployments/origin.json');
  const reactiveCfg = readJson('deployments/reactive.json');

  const origin = new Rpc(need('ORIGIN_RPC_URL'), { label: 'origin' });
  const lasna = new Rpc(need('REACTIVE_RPC_URL'), { label: 'lasna' });

  const T = {
    reacted: topic0(EVENTS.Reacted),
    stopExecuted: topic0(EVENTS.StopExecuted),
  };

  let filled = 0;
  let already = 0;
  const problems = [];

  for (const s of run.samples) {
    if (!s.reaction || s.failed) continue;

    try {
      if (s.reaction.txHash) {
        already++;
      } else {
        const log = await logFor(lasna, {
          address: reactiveCfg.reactor,
          topic: T.reacted,
          seq: s.seq,
          blockNumber: s.reaction.blockNumber,
          what: 'Reacted',
        });
        // Reacted(uint256 indexed seq, uint256 price, uint256 originBlock,
        //         uint256 reactedAt, bool triggered)
        const w = words(log.data);
        check(
          Number(BigInt(w[1])) === s.reaction.originBlock,
          `seq ${s.seq}: Reacted names origin block ${Number(BigInt(w[1]))}, ` +
            `sample says ${s.reaction.originBlock}`
        );
        check(
          Number(BigInt(w[2])) === s.reaction.blockTimestamp,
          `seq ${s.seq}: Reacted timestamp ${Number(BigInt(w[2]))}, ` +
            `sample says ${s.reaction.blockTimestamp}`
        );
        check(
          (BigInt(w[3]) === 1n) === Boolean(s.triggered),
          `seq ${s.seq}: Reacted triggered flag disagrees with the sample`
        );
        s.reaction.txHash = log.transactionHash;
        filled++;
      }

      if (s.execution) {
        if (s.execution.txHash) {
          already++;
        } else {
          const log = await logFor(origin, {
            address: originCfg.executor,
            topic: T.stopExecuted,
            seq: s.seq,
            blockNumber: s.execution.blockNumber,
            what: 'StopExecuted',
          });
          // StopExecuted(uint256 indexed seq, bytes32 indexed pair,
          //              uint256 price, uint256 executedAt)
          const w = words(log.data);
          check(
            Number(BigInt(w[1])) === s.execution.blockTimestamp,
            `seq ${s.seq}: StopExecuted timestamp ${Number(BigInt(w[1]))}, ` +
              `sample says ${s.execution.blockTimestamp}`
          );
          s.execution.txHash = log.transactionHash;
          filled++;
        }
      }
    } catch (err) {
      if (!(err instanceof MismatchError)) throw err;
      problems.push(err.message);
    }
  }

  console.log(`${filled} hashes recovered, ${already} already present.`);

  if (problems.length) {
    console.error(`\n${problems.length} sample(s) did not check out:`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error(
      '\nNothing written. A hash is only worth having if the log it came from ' +
        'agrees with the sample it is being attached to.'
    );
    process.exit(1);
  }

  if (!write) {
    console.log('Dry run. Pass --write to save.');
    return;
  }

  writeFileSync(path, JSON.stringify(run, null, 2) + '\n');
  console.log(`wrote ${path}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
