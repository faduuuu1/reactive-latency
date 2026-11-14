// A JSON-RPC client in sixty lines, deliberately.
//
// The alternative is ethers or viem, which would pull a few hundred packages
// into a repository whose only other dependency is a pinned Solidity library.
// Everything needed here — four read methods and a log filter — is a POST with
// a JSON body, and Node has had `fetch` built in since 18. Signing is the one
// hard part, and that is handed to `cast`, which is already the toolchain and
// already holds the key.

export class RpcError extends Error {
  constructor(message, { method, params, code } = {}) {
    super(message);
    this.method = method;
    this.params = params;
    this.code = code;
  }
}

export class Rpc {
  /**
   * @param {string} url
   * @param {{label?: string, timeoutMs?: number, retries?: number}} opts
   */
  constructor(url, { label = url, timeoutMs = 15_000, retries = 3 } = {}) {
    if (!url) throw new RpcError(`no RPC url for ${label}`);
    this.url = url;
    this.label = label;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.id = 0;
  }

  async call(method, params = []) {
    let lastErr;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) await sleep(Math.min(250 * 2 ** (attempt - 1), 2_000));
      try {
        const res = await fetch(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!res.ok) throw new RpcError(`${this.label}: HTTP ${res.status}`, { method, params });
        const body = await res.json();
        if (body.error) {
          // A malformed request will fail the same way every time; only
          // transport trouble is worth another attempt.
          throw new RpcError(`${this.label}: ${body.error.message}`, {
            method,
            params,
            code: body.error.code,
          });
        }
        return body.result;
      } catch (err) {
        lastErr = err;
        if (err instanceof RpcError && typeof err.code === 'number') throw err;
      }
    }
    throw new RpcError(`${this.label}: ${method} failed after ${this.retries + 1} attempts: ${lastErr?.message}`, {
      method,
      params,
    });
  }

  async chainId() {
    return Number(await this.call('eth_chainId'));
  }

  async blockNumber() {
    return Number(await this.call('eth_blockNumber'));
  }

  async getBlock(number) {
    const b = await this.call('eth_getBlockByNumber', [toHex(number), false]);
    if (!b) throw new RpcError(`${this.label}: block ${number} not found`);
    return { number: Number(b.number), timestamp: Number(b.timestamp), hash: b.hash };
  }

  async getReceipt(txHash) {
    return this.call('eth_getTransactionReceipt', [txHash]);
  }

  /** @param {{address?: string, topics?: (string|null|string[])[], fromBlock: number|string, toBlock: number|string}} f */
  async getLogs(f) {
    return this.call('eth_getLogs', [
      {
        ...(f.address ? { address: f.address } : {}),
        ...(f.topics ? { topics: f.topics } : {}),
        fromBlock: typeof f.fromBlock === 'number' ? toHex(f.fromBlock) : f.fromBlock,
        toBlock: typeof f.toBlock === 'number' ? toHex(f.toBlock) : f.toBlock,
      },
    ]);
  }
}

export const toHex = (n) => '0x' + BigInt(n).toString(16);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** uint256 topic/word -> BigInt */
export const word = (hex) => BigInt(hex);

/** Split a `data` blob into 32-byte words. */
export function words(data) {
  const body = data.startsWith('0x') ? data.slice(2) : data;
  const out = [];
  for (let i = 0; i < body.length; i += 64) out.push('0x' + body.slice(i, i + 64));
  return out;
}
