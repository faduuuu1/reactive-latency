#!/usr/bin/env node
// Drives the loop and records what happened. Writes raw samples only - every
// bit of arithmetic lives in stats.mjs, so the numbers can be re-derived, and
// argued with, long after the testnet has moved on.
//
// Usage:
//   node harness/collect.mjs --samples 40 --interval 3000
//
// Every observation here comes from one polling loop, at one interval, on one
// clock. That is deliberate. By default `cast send` waits for the receipt on
// its own schedule, which would bury cast's poll interval inside our
// measurement; CAST_ASYNC returns the hash immediately and hands the waiting
// back to us, so the wall-clock figures have one known resolution instead of
// two unknown ones.

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { Rpc, sleep, words } from './rpc.mjs';
import { loadEnv, need, readJson, signerArgs, topic0, topicUint } from './env.mjs';
import { ReactorBudget, DEFAULT_COST_WEI, formatEther } from './budget.mjs';

const EVENTS = readJson(new URL('./events.json', import.meta.url));

function parseArgs(argv) {
  const o = {
    samples: 20,
    interval: 3_000, // gap between pushes
    poll: 250, // observation resolution; Base Sepolia makes ~200ms blocks
    timeout: 120_000, // per stage
    pattern: 'alternate', // alternate | all-trigger | none-trigger
    out: null,
    // Per-reaction cost in ether, for the budget projection. Null means use
    // the measured default; the guard raises it on its own if the live cost
    // turns out higher, so this is a starting point, not a cap.
    cost: null,
    guard: 'on', // 'off' disables the reactor budget guard. See budget.mjs.
    // Consecutive failed pushes before giving up. A harness that cannot send
    // a transaction is not measuring anything, and the 20 Nov run spent four
    // minutes and 79 pushes proving it.
    maxPushFailures: 5,
  };
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/, '');
    const v = argv[i + 1];
    if (!(k in o)) throw new Error(`unknown flag --${k}`);
    o[k] = ['samples', 'interval', 'poll', 'timeout', 'maxPushFailures'].includes(k)
      ? Number(v)
      : v;
  }
  return o;
}

function resolveCast() {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const candidates = [process.env.CAST_BIN, 'cast', join(home, '.foundry', 'bin', 'cast')];
  for (const c of candidates.filter(Boolean)) {
    try {
      execFileSync(c, ['--version'], { stdio: 'ignore' });
      return c;
    } catch {
      /* try the next one */
    }
  }
  throw new Error('cast not found - install Foundry or set CAST_BIN');
}

const bytes32 = (s) => '0x' + Buffer.from(s, 'utf8').toString('hex').padEnd(64, '0');

/** Poll until fn returns something truthy, or give up. Returns [value, observedAtMs]. */
async function pollUntil(fn, { timeout, poll }) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return [v, Date.now()];
    if (Date.now() > deadline) return [null, Date.now()];
    await sleep(poll);
  }
}

async function main() {
  loadEnv();
  const opts = parseArgs(process.argv.slice(2));
  const cast = resolveCast();
  const signer = signerArgs();
  if (signer.warning) console.warn(`! ${signer.warning}\n`);

  const originCfg = readJson('deployments/origin.json');
  const reactiveCfg = readJson('deployments/reactive.json');

  const originUrl = need('ORIGIN_RPC_URL');
  const origin = new Rpc(originUrl, { label: 'origin' });
  const lasna = new Rpc(need('REACTIVE_RPC_URL'), { label: 'lasna' });

  // An RPC pointed at the wrong network answers perfectly well, about a chain
  // nobody asked about. Check once, here, rather than wonder later why no log
  // ever matches.
  const [originChain, lasnaChain] = await Promise.all([origin.chainId(), lasna.chainId()]);
  if (originChain !== originCfg.chainId) {
    throw new Error(
      `ORIGIN_RPC_URL serves chain ${originChain}, deployments/origin.json says ${originCfg.chainId}`
    );
  }
  if (lasnaChain !== reactiveCfg.chainId) {
    throw new Error(
      `REACTIVE_RPC_URL serves chain ${lasnaChain}, deployments/reactive.json says ${reactiveCfg.chainId}`
    );
  }

  // The reactor pays for its own reactions and cannot be revived once it has
  // run dry, so affordability is established before the first push rather
  // than discovered at the last one. budget.mjs explains why that asymmetry
  // matters more than it sounds like it should.
  const budget =
    opts.guard === 'off'
      ? null
      : new ReactorBudget(lasna, reactiveCfg.reactor, {
          costWei: opts.cost ? BigInt(Math.round(Number(opts.cost) * 1e18)) : DEFAULT_COST_WEI,
        });

  if (budget) {
    const pre = await budget.preflight(opts.samples);
    for (const line of pre.lines) console.log(pre.ok ? `  ${line}` : `! ${line}`);
    if (pre.fatal) throw new Error('reactor cannot fund this run -- nothing pushed');
    console.log('');
  }

  const T = {
    priceUpdated: topic0(EVENTS.PriceUpdated),
    reacted: topic0(EVENTS.Reacted),
    stopExecuted: topic0(EVENTS.StopExecuted),
  };

  const floor = BigInt(reactiveCfg.floor);
  const pair = bytes32('ETH/USD');
  const above = (floor * 110n) / 100n;
  const below = (floor * 90n) / 100n;

  const run = {
    startedAt: new Date().toISOString(),
    options: opts,
    origin: originCfg,
    reactive: reactiveCfg,
    events: EVENTS,
    notes: [
      'Wall-clock figures are observation times from one poller at options.poll ms, ' +
        'so they are upper bounds: they include the poll gap and the RPC round trip.',
      'Base Sepolia block timestamps are second-granular while blocks are ~200ms, ' +
        'so events in the same second are indistinguishable by timestamp alone.',
      'origin->reaction and reaction->execution cross a chain boundary and so carry ' +
        'the two chains clock offset. Only end-to-end (origin->execution) has both ' +
        'timestamps from the same chain.',
    ],
    samples: [],
  };

  console.log(`origin   chain ${originChain}  feed    ${originCfg.priceFeed}`);
  console.log(`reactive chain ${lasnaChain}  reactor ${reactiveCfg.reactor}`);
  console.log(`floor ${floor}  samples ${opts.samples}  poll ${opts.poll}ms\n`);

  if (!existsSync('results')) mkdirSync('results');
  const stamp = run.startedAt.replace(/[:.]/g, '-');
  const file = opts.out ?? join('results', `samples-${stamp}.json`);

  // Flushed after every sample, not once past the end of the loop. An
  // interrupted run -- a suspended reactor, a provider that starts refusing,
  // Ctrl-C -- used to lose everything it had measured. Samples are the
  // expensive part of this harness and the write is free.
  // samples-latest.json is still written once, at the end, so a run that dies
  // halfway cannot leave the headline pointer aimed at a stub.
  const flush = () => writeFileSync(file, JSON.stringify(run, null, 2));

  let stoppedEarly = null;
  let pushFailures = 0;

  for (let i = 0; i < opts.samples; i++) {
    // Checked at the top of the iteration, not the bottom. The body has five
    // `continue` paths, and a check at the bottom would be skipped by exactly
    // the failures that most want watching -- including the ones a dying
    // reactor produces.
    if (budget) {
      const b = await budget.check(i);
      if (b.stop) {
        stoppedEarly = b.reason;
        console.error(`
! ${b.reason}`);
        console.error(`  stopping after ${i} of ${opts.samples} samples, with the data kept`);
        break;
      }
      if (i > 0 && i % 10 === 0) {
        console.log(
          `  -- reactor ${formatEther(b.balance)} left, spent ${formatEther(b.spent)}` +
            (b.measuredWei ? `, ~${formatEther(b.measuredWei)}/reaction measured` : '')
        );
      }
    }

    const shouldTrigger =
      opts.pattern === 'all-trigger'
        ? true
        : opts.pattern === 'none-trigger'
          ? false
          : i % 2 === 1;
    const price = shouldTrigger ? below : above;

    // Establish the watch point before the push, so a fast reaction cannot
    // land in a block we have already scanned past.
    const [lasnaFrom, originFrom] = await Promise.all([
      lasna.blockNumber(),
      origin.blockNumber(),
    ]);

    const sentAtMs = Date.now();
    let txHash;
    try {
      const out = execFileSync(
        cast,
        [
          'send',
          originCfg.priceFeed,
          'push(bytes32,uint256)',
          pair,
          price.toString(),
          '--rpc-url',
          originUrl,
          ...signer.args,
        ],
        { encoding: 'utf8', env: { ...process.env, CAST_ASYNC: 'true' } }
      );
      txHash = out.match(/0x[0-9a-fA-F]{64}/)?.[0];
      if (!txHash) throw new Error(`no tx hash in cast output: ${out.trim()}`);
    } catch (err) {
      // `cast` puts its diagnosis on stderr; `err.message` is only the command
      // line that failed. Recording the message alone produced 79 samples in
      // the 20 Nov run that each said a push had failed and nothing whatever
      // about why -- the one question anyone asks afterwards. execFileSync
      // attaches the captured streams to the error, so the reason costs
      // nothing to keep.
      const stderr = String(err.stderr ?? '').trim();
      const first = (stderr || String(err.message)).split('\n')[0];
      console.error(`  ${String(i).padStart(3)} push failed - ${first}`);
      run.samples.push({
        index: i,
        failed: 'push',
        error: String(err.message).slice(0, 200),
        stderr: stderr.slice(0, 600) || null,
      });
      flush();

      pushFailures += 1;
      if (pushFailures >= opts.maxPushFailures) {
        stoppedEarly =
          `${pushFailures} consecutive pushes failed -- the origin chain is not ` +
          `accepting transactions from this signer. Last reason: ${first}`;
        console.error(`\n! ${stoppedEarly}`);
        break;
      }
      continue;
    }

    pushFailures = 0; // the streak is consecutive failures, not a total

    const [receipt] = await pollUntil(
      async () => {
        const r = await origin.getReceipt(txHash);
        return r && r.blockNumber ? r : null;
      },
      opts
    );

    if (!receipt) {
      console.error(`  ${String(i).padStart(3)} push ${txHash} unmined after ${opts.timeout}ms`);
      run.samples.push({ index: i, failed: 'mine', txHash });
      flush();
      continue;
    }
    if (BigInt(receipt.status) !== 1n) {
      console.error(`  ${String(i).padStart(3)} push reverted`);
      run.samples.push({ index: i, failed: 'revert', txHash });
      flush();
      continue;
    }

    const originBlockNumber = Number(receipt.blockNumber);
    const feedLog = receipt.logs.find(
      (l) => l.topics[0].toLowerCase() === T.priceUpdated.toLowerCase()
    );
    if (!feedLog) {
      run.samples.push({ index: i, failed: 'no-feed-log', txHash });
      flush();
      continue;
    }
    // PriceUpdated(bytes32 indexed pair, uint256 price, uint256 seq)
    const seq = Number(BigInt(words(feedLog.data)[1]));

    const originBlock = await origin.getBlock(originBlockNumber);

    const scanReaction = lasna.logCursor(
      { address: reactiveCfg.reactor, topics: [T.reacted, topicUint(seq)] },
      lasnaFrom
    );
    const [reactionLog, reactionSeenAtMs] = await pollUntil(async () => {
      const logs = await scanReaction();
      return logs.length ? logs[0] : null;
    }, opts);

    if (!reactionLog) {
      console.error(`  ${String(i).padStart(3)} seq ${seq}: no reaction within ${opts.timeout}ms`);
      run.samples.push({ index: i, seq, txHash, failed: 'no-reaction', triggered: shouldTrigger });
      flush();
      continue;
    }

    // Reacted(uint256 indexed seq, uint256 price, uint256 originBlock, uint256 reactedAt, bool triggered)
    const rw = words(reactionLog.data);
    const sample = {
      index: i,
      seq,
      pair: 'ETH/USD',
      price: price.toString(),
      triggered: BigInt(rw[3]) === 1n,
      origin: {
        chainId: originChain,
        txHash,
        blockNumber: originBlockNumber,
        blockTimestamp: originBlock.timestamp,
        sentAtMs,
      },
      reaction: {
        chainId: lasnaChain,
        txHash: reactionLog.transactionHash,
        blockNumber: Number(reactionLog.blockNumber),
        blockTimestamp: Number(BigInt(rw[2])), // reactedAt == block.timestamp on Lasna
        originBlock: Number(BigInt(rw[1])),
        observedAtMs: reactionSeenAtMs,
      },
      execution: null,
    };

    if (sample.triggered) {
      const scanExecution = origin.logCursor(
        { address: originCfg.executor, topics: [T.stopExecuted, topicUint(seq)] },
        originFrom
      );
      const [execLog, execSeenAtMs] = await pollUntil(async () => {
        const logs = await scanExecution();
        return logs.length ? logs[0] : null;
      }, opts);

      if (!execLog) {
        sample.failed = 'no-execution';
        console.error(`  ${String(i).padStart(3)} seq ${seq}: reacted, no callback in ${opts.timeout}ms`);
      } else {
        // StopExecuted(uint256 indexed seq, bytes32 indexed pair, uint256 price, uint256 executedAt)
        const ew = words(execLog.data);
        const execBlockNumber = Number(execLog.blockNumber);
        const execBlock = await origin.getBlock(execBlockNumber);
        const executedAt = Number(BigInt(ew[1]));

        // On a healthy chain the event's block.timestamp and the block's own
        // timestamp are the same number. Comparing them costs one call and
        // catches an RPC quietly serving a different chain's history.
        if (executedAt !== execBlock.timestamp) {
          sample.integrityWarning =
            `executedAt ${executedAt} != block ${execBlockNumber} timestamp ${execBlock.timestamp}`;
        }

        sample.execution = {
          chainId: originChain,
          txHash: execLog.transactionHash,
          blockNumber: execBlockNumber,
          blockTimestamp: execBlock.timestamp,
          observedAtMs: execSeenAtMs,
        };
      }
    }

    const e2e = sample.execution
      ? `${sample.execution.blockTimestamp - sample.origin.blockTimestamp}s`
      : '-';
    const wall = sample.execution
      ? `${sample.execution.observedAtMs - sentAtMs}ms`
      : `${reactionSeenAtMs - sentAtMs}ms (reaction only)`;
    console.log(
      `  ${String(i).padStart(3)} seq ${String(seq).padStart(4)} ` +
        `${sample.triggered ? 'TRIGGER' : '   -   '}  end-to-end ${e2e.padStart(5)}  observed ${wall}`
    );

    run.samples.push(sample);
    flush();
    if (i < opts.samples - 1) await sleep(opts.interval);
  }

  run.finishedAt = new Date().toISOString();
  if (stoppedEarly) run.stoppedEarly = stoppedEarly;
  if (budget) {
    // Recorded in the results file, not just printed. "What state did this run
    // leave the reactor in" is the question the first live run could not
    // answer afterwards.
    const { balance, debt } = await budget.read();
    run.reactorAfter = { balanceWei: balance.toString(), debtWei: debt.toString() };
  }
  flush();
  // --out means the caller is managing filenames, so the pointer to the
  // headline run is left alone. Without this, a two-sample demo overwrites
  // samples-latest.json and every reference to "the sixty-sample run"
  // quietly starts resolving to the demo instead.
  if (!opts.out) {
    writeFileSync(join('results', 'samples-latest.json'), JSON.stringify(run, null, 2));
  }
  console.log(`\nwrote ${file}`);
  console.log(`now: node harness/report.mjs ${file}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
