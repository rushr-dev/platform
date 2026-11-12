import { encodeFunctionData, maxUint256, type Hex } from 'viem';
import { TRADE_ADDRESSES, UR_ADDRESS_THIS, UR_MSG_SENDER } from './addresses';
import { rushrCurveRouterAbi } from './abis';
import type { TradeConfig } from './config';
import { TradeError } from './errors';
import { cmd, encodeExecute, encodeV3Path, OPEN_DELTA, v4, type EncodedCommand, type PermitSingle } from './universal-router';
import type { Approval, BuiltSwap, Quote } from './types';

const ETH = TRADE_ADDRESSES.eth;
const WETH = TRADE_ADDRESSES.weth;

export interface BuildOptions {
  /** Unix seconds; default now + cfg.deadlineSeconds. */
  deadline?: bigint;
  /** A PermitSingle the user's wallet signed (EIP-712), prepended as PERMIT2_PERMIT. Without it the
   *  approvals list asks for an on-chain Permit2.approve instead. */
  permit?: { permit: PermitSingle; signature: Hex };
  /** Current time in seconds (tests). */
  now?: number;
}

/**
 * Universal Router command plan for a quote. Fee is always on the quote side:
 * - buys: TRANSFER (ETH) or PERMIT2_TRANSFER_FROM (USDG) of the fee to the treasury, then swap the rest;
 * - sells: swap into the router, PAY_PORTION of the quote asset to the treasury, SWEEP the rest to the user
 *   with the net minimum.
 */
export function planUniversalRouter(q: Quote, cfg: TradeConfig): EncodedCommand[] {
  const pool = q.pool;
  if (pool.venue === 'pons-curve') throw new TradeError('UNSUPPORTED_VENUE', 'PONS curves are not reachable through the Universal Router');
  const treasury = cfg.feeRecipient;
  const isUsdg = pool.quote === TRADE_ADDRESSES.usdg;
  const out: EncodedCommand[] = [];

  if (q.request.side === 'buy') {
    // 1. Fee from the input.
    if (q.fee.feeAmount > 0n) {
      if (isUsdg) out.push(cmd.permit2TransferFrom(TRADE_ADDRESSES.usdg, treasury, q.fee.feeAmount));
      else out.push(cmd.transfer(ETH, treasury, q.fee.feeAmount));
    }
    const amount = q.swapAmountIn;
    // 2. Swap the rest; output straight to the user (UR_MSG_SENDER) with the slippage minimum.
    switch (pool.venue) {
      case 'uniswap-v4': {
        // Fund the router with the input first (wrap ETH / pull USDG), then settle from the router's balance.
        if (pool.quote === WETH) out.push(cmd.wrapEth(UR_ADDRESS_THIS, amount));
        if (isUsdg) out.push(cmd.permit2TransferFrom(TRADE_ADDRESSES.usdg, UR_ADDRESS_THIS, amount));
        const zeroForOne = pool.key.currency0 === pool.quote;
        out.push(
          cmd.v4Swap([
            v4.swapExactInSingle({ poolKey: pool.key, zeroForOne, amountIn: amount, amountOutMinimum: q.minAmountOut, hookData: pool.hookData }),
            v4.settle(pool.quote, OPEN_DELTA, false),
            v4.takeAll(pool.token, q.minAmountOut),
          ]),
        );
        break;
      }
      case 'uniswap-v3':
        if (!isUsdg) out.push(cmd.wrapEth(UR_ADDRESS_THIS, amount));
        out.push(cmd.v3SwapExactIn(UR_MSG_SENDER, amount, q.minAmountOut, encodeV3Path([pool.quote, pool.token], [pool.fee]), isUsdg));
        break;
      case 'uniswap-v2':
        if (!isUsdg) out.push(cmd.wrapEth(UR_ADDRESS_THIS, amount));
        out.push(cmd.v2SwapExactIn(UR_MSG_SENDER, amount, q.minAmountOut, [pool.quote, pool.token], isUsdg));
        break;
    }
    return out;
  }

  // Sell: output stays in the router, then fee + sweep.
  const amount = q.amountIn;
  switch (pool.venue) {
    case 'uniswap-v4': {
      const zeroForOne = pool.key.currency0 === pool.token;
      out.push(
        cmd.v4Swap([
          v4.swapExactInSingle({ poolKey: pool.key, zeroForOne, amountIn: amount, amountOutMinimum: q.minGrossOut, hookData: pool.hookData }),
          v4.settleAll(pool.token, amount),
          v4.take(pool.quote, UR_ADDRESS_THIS, OPEN_DELTA),
        ]),
      );
      break;
    }
    case 'uniswap-v3':
      out.push(cmd.v3SwapExactIn(UR_ADDRESS_THIS, amount, q.minGrossOut, encodeV3Path([pool.token, pool.quote], [pool.fee]), true));
      break;
    case 'uniswap-v2':
      out.push(cmd.v2SwapExactIn(UR_ADDRESS_THIS, amount, q.minGrossOut, [pool.token, pool.quote], true));
      break;
  }
  const payToken = isUsdg ? TRADE_ADDRESSES.usdg : ETH;
  if (pool.quote === WETH) out.push(cmd.unwrapWeth(UR_ADDRESS_THIS, q.minGrossOut));
  if (cfg.feeBps > 0) out.push(cmd.payPortion(payToken, treasury, cfg.feeBps));
  out.push(cmd.sweep(payToken, UR_MSG_SENDER, q.minAmountOut));
  return out;
}

/** Builds the unsigned transaction and the approvals the wallet needs first. Never signs or sends. */
export function buildSwap(q: Quote, cfg: TradeConfig, opts: BuildOptions = {}): BuiltSwap {
  const now = BigInt(opts.now ?? Math.floor(Date.now() / 1000));
  const deadline = opts.deadline ?? now + BigInt(cfg.deadlineSeconds);
  const { side } = q.request;

  if (q.pool.venue === 'pons-curve') {
    if (!cfg.curveRouter) throw new TradeError('UNSUPPORTED_VENUE', 'PONS curve trading needs the Rushr curve router, which is not deployed yet');
    const router = cfg.curveRouter;
    if (side === 'buy')
      return {
        quote: q,
        tx: { to: router, value: q.amountIn, data: encodeFunctionData({ abi: rushrCurveRouterAbi, functionName: 'buy', args: [q.pool.token, q.minAmountOut, q.request.trader, deadline] }) },
        approvals: [],
        commands: [],
        deadline,
      };
    return {
      quote: q,
      tx: { to: router, value: 0n, data: encodeFunctionData({ abi: rushrCurveRouterAbi, functionName: 'sell', args: [q.pool.token, q.amountIn, q.minAmountOut, q.request.trader, deadline] }) },
      approvals: [{ kind: 'erc20', token: q.pool.token, spender: router, amount: q.amountIn }],
      commands: [],
      deadline,
    };
  }

  const commands = planUniversalRouter(q, cfg);
  const approvals: Approval[] = [];
  // ERC20 the router pulls from the user via Permit2: the token on sells, USDG on USDG buys.
  const pulled = side === 'sell' ? q.pool.token : q.pool.quote === TRADE_ADDRESSES.usdg ? TRADE_ADDRESSES.usdg : null;
  if (pulled) {
    approvals.push({ kind: 'erc20', token: pulled, spender: TRADE_ADDRESSES.permit2, amount: maxUint256 });
    if (opts.permit) commands.unshift(cmd.permit2Permit(opts.permit.permit, opts.permit.signature));
    else approvals.push({ kind: 'permit2', token: pulled, spender: cfg.universalRouter, amount: q.amountIn });
  }
  const value = side === 'buy' && q.pool.quote !== TRADE_ADDRESSES.usdg ? q.amountIn : 0n;
  return { quote: q, tx: { to: cfg.universalRouter, data: encodeExecute(commands, deadline), value }, approvals, commands, deadline };
}
