import {
  formatTransactionReceipt,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type Address,
  type Hex,
  type PublicClient,
  type RpcTransactionReceipt,
  type TransactionReceipt,
  type TransactionSerializedEIP1559,
} from 'viem';
import type { WalletCall } from './quick';

/**
 * Fast send for quick trades: the wallet only SIGNS; nonce, fees and gas come from a local cache (no
 * RPC calls at click time), and the signed tx is broadcast with `eth_sendRawTransactionSync`
 * (EIP-7966, supported by Robinhood Chain's RPC), which returns the receipt in the same round trip.
 * Falls back to eth_sendRawTransaction + fast receipt polling if the method is missing or times out.
 *
 * Before anything is broadcast, the signed bytes are decoded and checked against what was asked
 * (to, data, value, nonce, chain, gas, fee caps) and the signer is recovered: a wallet that signed
 * something else is never broadcast.
 */

export interface UnsignedEip1559 {
  type: 'eip1559';
  chainId: number;
  nonce: number;
  to: Address;
  data: Hex;
  value: bigint;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/** Signs and returns the serialized signed transaction (never broadcasts). */
export type SignTxFn = (tx: UnsignedEip1559) => Promise<Hex>;

export interface SendHooks {
  /** Signed, verified and handed to the RPC: the hash is final from here on. */
  onSubmitted?(hash: Hex): void;
}

export interface SendTimings {
  /** Waiting for nonce/fees (0 when cached). */
  prepMs: number;
  signMs: number;
  /** Broadcast until receipt. */
  confirmMs: number;
  via: 'sync' | 'poll';
}

export interface SendResult {
  hash: Hex;
  receipt: TransactionReceipt;
  timings: SendTimings;
}

export class SendError extends Error {
  constructor(
    message: string,
    readonly code: 'NONCE' | 'FEE' | 'REJECTED' | 'MISMATCH' | 'TIMEOUT' | 'UNSUPPORTED',
    readonly hash?: Hex,
  ) {
    super(message);
  }
}

const FEE_TTL_MS = 10_000;
const NONCE_TTL_MS = 20_000;
const FALLBACK_BASE_FEE = 20_000_000n; // 0.02 gwei, Robinhood Chain's floor (measured)

export interface TxPipelineOptions {
  /** Base fee multiplier for maxFeePerGas (Arbitrum charges the base fee only; tips are ignored). */
  feeMultiplier?: bigint;
  pollMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

export class TxPipeline {
  private nonce: { value: number; at: number } | null = null;
  private fees: { maxFeePerGas: bigint; at: number } | null = null;
  private inflight: Promise<void> | null = null;
  private syncSupported = true;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly opt: Required<TxPipelineOptions>;

  constructor(
    private readonly client: PublicClient,
    readonly account: Address,
    opts: TxPipelineOptions = {},
  ) {
    this.opt = { feeMultiplier: 2n, pollMs: 150, timeoutMs: 60_000, now: () => Date.now(), ...opts };
  }

  /** Fetch nonce and fees if missing or stale. Cheap to call often (one RPC batch, deduplicated). */
  warm(force = false): Promise<void> {
    const t = this.opt.now();
    const fresh = !force && this.nonce && t - this.nonce.at < NONCE_TTL_MS && this.fees && t - this.fees.at < FEE_TTL_MS;
    if (fresh) return Promise.resolve();
    return (this.inflight ??= (async () => {
      try {
        const [n, block] = await Promise.all([
          this.client.getTransactionCount({ address: this.account, blockTag: 'pending' }),
          this.client.getBlock({ blockTag: 'latest' }).catch(() => null),
        ]);
        const at = this.opt.now();
        // Never move the nonce backwards past one we already used locally.
        this.nonce = { value: Math.max(n, this.nonce?.value ?? 0), at };
        const base = block?.baseFeePerGas ?? FALLBACK_BASE_FEE;
        this.fees = { maxFeePerGas: base * this.opt.feeMultiplier, at };
      } finally {
        this.inflight = null;
      }
    })());
  }

  /** Forget the cached nonce (after a rejected broadcast or a trade made elsewhere). */
  resetNonce() {
    this.nonce = null;
  }

  get cached(): { nonce: number | null; maxFeePerGas: bigint | null } {
    return { nonce: this.nonce?.value ?? null, maxFeePerGas: this.fees?.maxFeePerGas ?? null };
  }

  /** Max gas cost of a call at the cached fee cap (for balance checks). */
  maxGasCost(gas: bigint): bigint {
    return gas * (this.fees?.maxFeePerGas ?? FALLBACK_BASE_FEE * this.opt.feeMultiplier);
  }

  /** Sign and broadcast one call; calls are serialized so nonces stay in order. */
  send(call: WalletCall, sign: SignTxFn, hooks: SendHooks = {}): Promise<SendResult> {
    const run = this.queue.then(() => this.sendNow(call, sign, hooks));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async sendNow(call: WalletCall, sign: SignTxFn, hooks: SendHooks): Promise<SendResult> {
    const t0 = performance.now();
    if (!this.nonce || !this.fees) await this.warm();
    else void this.warm(); // refresh in the background if stale; use the cache now
    const nonce = this.nonce!.value;
    const tx: UnsignedEip1559 = {
      type: 'eip1559',
      chainId: call.chainId,
      nonce,
      to: call.to,
      data: call.data,
      value: call.value,
      gas: call.gas,
      maxFeePerGas: this.fees!.maxFeePerGas,
      maxPriorityFeePerGas: 0n,
    };
    const t1 = performance.now();
    const raw = await sign(tx);
    const t2 = performance.now();
    await verifySigned(raw, tx, this.account);
    const hash = keccak256(raw);
    // Reserve the nonce before broadcasting so a second click right after uses the next one.
    this.nonce = { value: nonce + 1, at: this.opt.now() };
    hooks.onSubmitted?.(hash);
    try {
      const { receipt, via } = await this.broadcast(raw, hash);
      return { hash, receipt, timings: { prepMs: t1 - t0, signMs: t2 - t1, confirmMs: performance.now() - t2, via } };
    } catch (e) {
      if (e instanceof SendError && e.code !== 'TIMEOUT') this.resetNonce();
      throw e;
    }
  }

  private async broadcast(raw: Hex, hash: Hex): Promise<{ receipt: TransactionReceipt; via: 'sync' | 'poll' }> {
    if (this.syncSupported) {
      try {
        const r = (await this.client.request({ method: 'eth_sendRawTransactionSync' as 'eth_sendRawTransaction', params: [raw] })) as unknown as RpcTransactionReceipt;
        if (r && typeof r === 'object' && 'blockNumber' in r) return { receipt: formatTransactionReceipt(r), via: 'sync' };
        // Some nodes return only the hash: fall through to polling.
      } catch (e) {
        const { code, message } = rpcError(e);
        if (code === -32601 || /does not exist|not available|not supported/i.test(message)) this.syncSupported = false;
        else if (code === 4 || /timeout|timed out/i.test(message)) return { receipt: await this.poll(hash), via: 'poll' }; // accepted, not yet mined
        else throw classify(message, hash);
        // Method missing: broadcast the classic way below.
        try {
          await this.client.request({ method: 'eth_sendRawTransaction', params: [raw] });
        } catch (e2) {
          const m = rpcError(e2).message;
          if (!/already known/i.test(m)) throw classify(m, hash);
        }
      }
    } else {
      try {
        await this.client.request({ method: 'eth_sendRawTransaction', params: [raw] });
      } catch (e) {
        const m = rpcError(e).message;
        if (!/already known/i.test(m)) throw classify(m, hash);
      }
    }
    return { receipt: await this.poll(hash), via: 'poll' };
  }

  private async poll(hash: Hex): Promise<TransactionReceipt> {
    const end = this.opt.now() + this.opt.timeoutMs;
    for (;;) {
      const r = await this.client.getTransactionReceipt({ hash }).catch(() => null);
      if (r) return r;
      if (this.opt.now() > end) throw new SendError('Not confirmed within a minute; check the explorer.', 'TIMEOUT', hash);
      await new Promise((res) => setTimeout(res, this.opt.pollMs));
    }
  }
}

function rpcError(e: unknown): { code: number | undefined; message: string } {
  const err = e as { code?: number; cause?: { code?: number; message?: string }; details?: string; shortMessage?: string; message?: string };
  const code = err?.cause?.code ?? err?.code;
  const message = [err?.details, err?.cause?.message, err?.shortMessage, err?.message].filter(Boolean).join(' | ');
  return { code, message: message.replace(/https?:\/\/\S+/g, '') };
}

function classify(message: string, hash: Hex): SendError {
  if (/nonce too low|nonce too high|replacement transaction/i.test(message)) return new SendError('Wallet nonce changed (another trade?), retrying.', 'NONCE', hash);
  if (/max fee per gas less than block base fee|fee cap/i.test(message)) return new SendError('Network fee moved, retrying.', 'FEE', hash);
  if (/insufficient funds/i.test(message)) return new SendError('Not enough ETH for this trade and gas.', 'REJECTED', hash);
  return new SendError(message.split(' | ')[0]!.slice(0, 160) || 'Broadcast rejected', 'REJECTED', hash);
}

/** The signed bytes must be exactly the transaction we asked for, signed by the user's wallet. */
export async function verifySigned(raw: Hex, want: UnsignedEip1559, account: Address): Promise<void> {
  let tx: ReturnType<typeof parseTransaction>;
  try {
    tx = parseTransaction(raw);
  } catch {
    // Not a serialized transaction (e.g. a wallet that returns only a signature): nothing was sent, so
    // the caller may fall back to the wallet's own send.
    throw new SendError('Wallet returned an unreadable transaction; nothing was sent.', 'UNSUPPORTED');
  }
  const same =
    tx.type === 'eip1559' &&
    tx.chainId === want.chainId &&
    tx.nonce === want.nonce &&
    tx.to?.toLowerCase() === want.to.toLowerCase() &&
    (tx.data ?? '0x').toLowerCase() === want.data.toLowerCase() &&
    (tx.value ?? 0n) === want.value &&
    tx.gas === want.gas &&
    tx.maxFeePerGas === want.maxFeePerGas &&
    (tx.maxPriorityFeePerGas ?? 0n) === want.maxPriorityFeePerGas;
  if (!same) throw new SendError('Wallet signed a different transaction than requested; nothing was sent.', 'MISMATCH');
  const signer = await recoverTransactionAddress({ serializedTransaction: raw as TransactionSerializedEIP1559 });
  if (signer.toLowerCase() !== account.toLowerCase()) throw new SendError('Signed by another account; nothing was sent.', 'MISMATCH');
}
