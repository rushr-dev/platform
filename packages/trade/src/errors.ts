/** Every failure in @rushr/trade is a TradeError with a stable code the UI can map to copy. */
export type TradeErrorCode =
  | 'CONFIG_INVALID' // fee rate out of bounds, bad recipient
  | 'FEE_RECIPIENT_PLACEHOLDER' // building a tx for signing while the treasury is still a placeholder
  | 'INVALID_AMOUNT'
  | 'INVALID_SLIPPAGE'
  | 'SAME_TOKEN'
  | 'NO_ROUTE' // no venue could quote this pair
  | 'UNSUPPORTED_VENUE' // e.g. PONS curve without a deployed fee router
  | 'QUOTE_FAILED'
  | 'INSUFFICIENT_LIQUIDITY'
  | 'CURVE_GRADUATED'
  | 'SNIPE_TAX_ACTIVE'
  | 'SIMULATION_REVERTED'
  | 'SIMULATION_UNSUPPORTED'
  | 'HONEYPOT' // buy works, sell reverts
  | 'TAX_TOO_HIGH'
  | 'SLIPPAGE_EXCEEDED'
  | 'RPC_ERROR';

export class TradeError extends Error {
  readonly code: TradeErrorCode;
  readonly details?: Record<string, unknown>;
  constructor(code: TradeErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'TradeError';
    this.code = code;
    this.details = details;
  }
}

export function isTradeError(e: unknown, code?: TradeErrorCode): e is TradeError {
  return e instanceof TradeError && (code === undefined || e.code === code);
}

/**
 * Strip anything URL-like from RPC errors before they reach logs or the UI (viem errors include the
 * transport URL, which carries the RPC key).
 */
export function sanitizeRpcMessage(e: unknown): string {
  const raw = e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e);
  return raw.replace(/https?:\/\/\S+/g, '<rpc>').split('\n')[0]!.slice(0, 300);
}

/** Revert data from a viem error chain (ContractFunctionRevertedError.raw, RpcRequestError.data, ...). */
export function revertDataOf(e: unknown): `0x${string}` | undefined {
  let cur: unknown = e;
  for (let i = 0; i < 8 && cur; i++) {
    const o = cur as { raw?: unknown; data?: unknown; cause?: unknown };
    if (typeof o.raw === 'string' && o.raw.startsWith('0x')) return o.raw as `0x${string}`;
    if (typeof o.data === 'string' && o.data.startsWith('0x') && o.data.length >= 10) return o.data as `0x${string}`;
    cur = o.cause;
  }
  return undefined;
}
