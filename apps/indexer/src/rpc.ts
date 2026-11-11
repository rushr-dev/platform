import { decodeFunctionResult, encodeFunctionData, parseAbi, toFunctionSelector, type Address, type Hex } from 'viem';
import { ABIS, NATIVE_ETH, QUOTES, UNISWAP, type RawLog } from '@rushr/core';

interface RpcResponse<T> {
  id: number;
  result?: T;
  error?: { code: number; message: string };
}

export class Rpc {
  private id = 0;
  constructor(private url: string) {}

  async call<T>(method: string, params: unknown[]): Promise<T> {
    const res = await this.post({ jsonrpc: '2.0', id: ++this.id, method, params });
    const body = (await res.json()) as RpcResponse<T>;
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result as T;
  }

  async batch<T>(calls: { method: string; params: unknown[] }[]): Promise<(T | null)[]> {
    if (calls.length === 0) return [];
    const start = this.id;
    const res = await this.post(calls.map((c, i) => ({ jsonrpc: '2.0', id: start + i + 1, ...c })));
    this.id += calls.length;
    const body = (await res.json()) as RpcResponse<T>[];
    const byId = new Map(body.map((r) => [r.id, r]));
    return calls.map((_, i) => byId.get(start + i + 1)?.result ?? null);
  }

  async blockNumber(): Promise<bigint> {
    return BigInt(await this.call<Hex>('eth_blockNumber', []));
  }

  /** One OR-filtered getLogs over [from, to]. */
  async logs(from: bigint, to: bigint, topics: Hex[]): Promise<RawLog[]> {
    return this.call<RawLog[]>('eth_getLogs', [
      { fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, topics: [topics] },
    ]);
  }

  /** name/symbol/decimals/totalSupply for many tokens in one batch. Missing values come back null. */
  async tokenMetadata(tokens: Address[]) {
    const fns = ['name', 'symbol', 'decimals', 'totalSupply'] as const;
    const calls = tokens.flatMap((t) =>
      fns.map((fn) => ({
        method: 'eth_call',
        params: [{ to: t, data: encodeFunctionData({ abi: ABIS.erc20, functionName: fn }) }, 'latest'],
      })),
    );
    const results: (Hex | null)[] = [];
    for (let i = 0; i < calls.length; i += 100) results.push(...(await this.batch<Hex>(calls.slice(i, i + 100))));
    return tokens.map((token, ti) => {
      const get = <F extends (typeof fns)[number]>(fn: F, fi: number) => {
        const raw = results[ti * 4 + fi];
        if (!raw || raw === '0x') return null;
        try {
          return decodeFunctionResult({ abi: ABIS.erc20, functionName: fn as 'name', data: raw }) as unknown;
        } catch {
          return null;
        }
      };
      return {
        token,
        name: (get('name', 0) as string | null) ?? '',
        symbol: (get('symbol', 1) as string | null) ?? '',
        decimals: Number(get('decimals', 2) ?? 18),
        totalSupply: (get('totalSupply', 3) as bigint | null) ?? 0n,
      };
    });
  }

  /** Who launched it: the smart-account sender for ERC-4337 txs, else tx.from. */
  async launchers(txs: Hex[]): Promise<Map<Hex, Address>> {
    const out = new Map<Hex, Address>();
    const receipts = await this.batch<{ from: Address; logs: RawLog[] }>(
      txs.map((h) => ({ method: 'eth_getTransactionReceipt', params: [h] })),
    );
    const USER_OP = '0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f';
    receipts.forEach((r, i) => {
      if (!r) return;
      const op = r.logs.find((l) => l.topics[0] === USER_OP);
      const sender = op ? (`0x${op.topics[2]!.slice(26)}` as Address) : r.from;
      out.set(txs[i]!, sender.toLowerCase() as Address);
    });
    return out;
  }

  /** v4 PoolKeys for pool ids, via the PositionManager (null when it never saw the pool). */
  async poolKeys(ids: string[]) {
    const abi = parseAbi([
      'function poolKeys(bytes25 poolId) view returns (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)',
    ]);
    const raw = await this.batch<Hex>(
      ids.map((id) => ({
        method: 'eth_call',
        params: [
          { to: UNISWAP.v4.positionManager, data: encodeFunctionData({ abi, functionName: 'poolKeys', args: [id.slice(0, 52) as Hex] }) },
          'latest',
        ],
      })),
    );
    return ids.map((id, i) => {
      const r = raw[i];
      if (!r || r === '0x') return { id, key: null };
      const [currency0, currency1, , , hooks] = decodeFunctionResult({ abi, functionName: 'poolKeys', data: r });
      if (currency0 === NATIVE_ETH && currency1 === NATIVE_ETH) return { id, key: null };
      return { id, key: { currency0: currency0.toLowerCase() as Address, currency1: currency1.toLowerCase() as Address, hooks: hooks.toLowerCase() as Address } };
    });
  }

  /** A token's creation: its first Transfer (mint) tx, block and time, plus who sent that tx and to what contract. */
  async tokenOrigin(token: Address) {
    const res = await this.call<{ transfers: { hash: Hex; blockNum: Hex; metadata?: { blockTimestamp?: string } }[] }>(
      'alchemy_getAssetTransfers',
      [{ contractAddresses: [token], category: ['erc20'], order: 'asc', maxCount: '0x1', fromBlock: '0x0', withMetadata: true }],
    );
    const t = res.transfers[0];
    if (!t) return null;
    const tx = await this.call<{ from: Address; to: Address | null }>('eth_getTransactionByHash', [t.hash]);
    return {
      tx: t.hash,
      block: BigInt(t.blockNum),
      time: t.metadata?.blockTimestamp ? Math.floor(Date.parse(t.metadata.blockTimestamp) / 1000) : 0,
      to: (tx.to ?? NATIVE_ETH).toLowerCase() as Address,
    };
  }

  /** OR-filtered getLogs over [from, to], halving the range whenever the provider says the response is too big. */
  async logsSplit(from: bigint, to: bigint, topics: Hex[]): Promise<RawLog[]> {
    try {
      return await this.logs(from, to, topics);
    } catch (err) {
      if (to - from < 2n || !/response size|exceed|too many|limit/i.test(String(err))) throw err;
      const mid = (from + to) / 2n;
      return [...(await this.logsSplit(from, mid, topics)), ...(await this.logsSplit(mid + 1n, to, topics))];
    }
  }

  /**
   * USD price of tokens from their own Uniswap v4 pools: quotes selling one token into USDG and into
   * ETH across the common fee tiers (no hooks) and keeps the best answer. Null when no pool exists.
   * Used for quote tokens other than ETH/USDG (Robinhood stock tokens, other coins used as quotes).
   */
  async usdPrices(tokens: { address: Address; decimals: number }[], ethUsd: number | null): Promise<Map<Address, number | null>> {
    const abi = parseAbi([
      'function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)',
    ]);
    const TIERS: [number, number][] = [[100, 1], [500, 10], [3000, 60], [10000, 200], [0x800000, 60]];
    const COUNTER: { address: Address; decimals: number; usd: () => number | null }[] = [
      { address: QUOTES.USDG as Address, decimals: 6, usd: () => 1 },
      { address: NATIVE_ETH as Address, decimals: 18, usd: () => ethUsd },
    ];
    const calls: { token: Address; counter: (typeof COUNTER)[number]; decimals: number }[] = [];
    const reqs = tokens.flatMap((t) =>
      COUNTER.flatMap((c) =>
        TIERS.map(([fee, tickSpacing]) => {
          const tokenIs0 = t.address.toLowerCase() < c.address.toLowerCase();
          calls.push({ token: t.address, counter: c, decimals: t.decimals });
          const data = encodeFunctionData({
            abi,
            functionName: 'quoteExactInputSingle',
            args: [
              {
                poolKey: {
                  currency0: tokenIs0 ? t.address : c.address,
                  currency1: tokenIs0 ? c.address : t.address,
                  fee,
                  tickSpacing,
                  hooks: NATIVE_ETH as Address,
                },
                zeroForOne: tokenIs0,
                exactAmount: 10n ** BigInt(t.decimals),
                hookData: '0x',
              },
            ],
          });
          return { method: 'eth_call', params: [{ to: UNISWAP.v4.quoter, data }, 'latest'] };
        }),
      ),
    );
    const out = new Map<Address, number | null>(tokens.map((t) => [t.address, null]));
    for (let i = 0; i < reqs.length; i += 100) {
      const res = await this.batch<Hex>(reqs.slice(i, i + 100));
      res.forEach((r, j) => {
        if (!r || r === '0x') return;
        const c = calls[i + j]!;
        const perUnit = c.counter.usd();
        if (perUnit == null) return;
        try {
          const [amountOut] = decodeFunctionResult({ abi, functionName: 'quoteExactInputSingle', data: r });
          const usd = (Number(amountOut) / 10 ** c.counter.decimals) * perUnit;
          if (usd > 0 && usd > (out.get(c.token) ?? 0)) out.set(c.token, usd);
        } catch {
          // no pool at this tier
        }
      });
    }
    return out;
  }

  /** PONS curves' quote tokens via `pairToken()` (0x0 = native ETH; USDG for dollar curves). */
  async curveQuotes(curves: string[]): Promise<Map<string, Address>> {
    const SELECTOR = toFunctionSelector('pairToken()');
    const res = await this.batch<Hex>(curves.map((c) => ({ method: 'eth_call', params: [{ to: c, data: SELECTOR }, 'latest'] })));
    const out = new Map<string, Address>();
    curves.forEach((c, i) => {
      const r = res[i];
      out.set(c, (r && r.length >= 66 ? `0x${r.slice(26, 66)}` : NATIVE_ETH).toLowerCase() as Address);
    });
    return out;
  }

  /** All Transfer logs of one token in [from, to]. Tries the whole range, halving whenever the response is too big. */
  /**
   * A token's Transfer history. With a budget, gives up (HistoryTooLarge) past `maxLogs` logs or
   * `maxMs`, so a token with an enormous history can't stall the live indexer.
   */
  async transferLogs(token: Address, from: bigint, to: bigint, budget?: { maxLogs: number; maxMs: number }): Promise<RawLog[]> {
    const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    const b = budget ? { left: budget.maxLogs, deadline: Date.now() + budget.maxMs } : undefined;
    return this.filteredLogs(from, to, { address: token, topics: [TRANSFER] }, b);
  }

  /**
   * getLogs with an address and/or per-position topic filter (e.g. Swap events for a list of pool
   * ids), halving the block range whenever the provider says the response is too big.
   */
  async filteredLogs(
    from: bigint,
    to: bigint,
    filter: { address?: string | string[]; topics: (Hex | Hex[] | null)[] },
    budget?: { left: number; deadline: number },
  ): Promise<RawLog[]> {
    if (budget && (budget.left < 0 || Date.now() > budget.deadline)) throw new HistoryTooLarge();
    try {
      const logs = await this.call<RawLog[]>('eth_getLogs', [
        { fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, ...filter },
      ]);
      if (budget && (budget.left -= logs.length) < 0) throw new HistoryTooLarge();
      return logs;
    } catch (err) {
      if (err instanceof HistoryTooLarge) throw err;
      if (to - from < 2n || !/response size|exceed|too many|limit|range/i.test(String(err))) throw err;
      const mid = (from + to) / 2n;
      return [...(await this.filteredLogs(from, mid, filter, budget)), ...(await this.filteredLogs(mid + 1n, to, filter, budget))];
    }
  }

  /**
   * First incoming ETH transfer per wallet (≈ who created/funded it, and when), via Alchemy's
   * transfers API. Wallets with no incoming ETH (e.g. contracts) come back with nulls.
   */
  async firstFunders(wallets: Address[]): Promise<Map<Address, { funder: Address | null; at: number | null }>> {
    const out = new Map<Address, { funder: Address | null; at: number | null }>();
    for (let i = 0; i < wallets.length; i += 25) {
      const chunk = wallets.slice(i, i + 25);
      const results = await this.batch<{ transfers: { from: string; metadata?: { blockTimestamp?: string } }[] }>(
        chunk.map((w) => ({
          method: 'alchemy_getAssetTransfers',
          params: [
            {
              toAddress: w,
              category: ['external', 'internal'],
              order: 'asc',
              maxCount: '0x1',
              excludeZeroValue: true,
              withMetadata: true,
              fromBlock: '0x0',
            },
          ],
        })),
      );
      chunk.forEach((w, j) => {
        const t = results[j]?.transfers?.[0];
        out.set(w, {
          funder: t ? (t.from.toLowerCase() as Address) : null,
          at: t?.metadata?.blockTimestamp ? Math.floor(Date.parse(t.metadata.blockTimestamp) / 1000) : null,
        });
      });
    }
    return out;
  }

  private async post(body: unknown): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) return res;
      if (attempt >= 3 || (res.status !== 429 && res.status < 500)) {
        throw new Error(`RPC HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
    }
  }
}

export class HistoryTooLarge extends Error {
  override name = 'HistoryTooLarge';
}
