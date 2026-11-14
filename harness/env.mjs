import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/** Minimal .env reader. Does not expand, does not overwrite a real env var. */
export function loadEnv(path = '.env') {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function need(key) {
  const v = process.env[key];
  if (!v) throw new Error(`${key} is not set (check .env against .env.example)`);
  return v;
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * How `cast` should be told who is signing.
 *
 * A keystore is preferred and not for ceremony: `--private-key` is a command
 * line argument, and command lines are readable by every other process on the
 * machine. The key is never in this process's argv when a keystore is used.
 * The raw-key path stays available because it is what every Reactive example
 * uses, but it says so out loud rather than letting the difference go unnoticed.
 */
export function signerArgs() {
  if (process.env.ETH_KEYSTORE_ACCOUNT || process.env.ETH_KEYSTORE) {
    return { args: [], mode: 'keystore', warning: null };
  }
  const pk = need('PRIVATE_KEY');
  return {
    args: ['--private-key', pk],
    mode: 'raw-key',
    warning:
      'Signing with --private-key, which puts the key in this process\'s command line ' +
      'where other local processes can read it. Fine for a throwaway testnet key. ' +
      'For anything else: `cast wallet import deployer --interactive`, then set ' +
      'ETH_KEYSTORE_ACCOUNT=deployer and ETH_PASSWORD.',
  };
}

/** keccak256 of an event signature, via the toolchain that is already here. */
export function topic0(signature) {
  return execFileSync('cast', ['keccak', signature], { encoding: 'utf8' }).trim();
}

/** Left-pad a uint to a 32-byte topic. */
export const topicUint = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
