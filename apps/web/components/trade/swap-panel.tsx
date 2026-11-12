'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPublicClient, formatUnits, http, isAddress, parseUnits, type Address, type PublicClient } from 'viem';
import {
  assertSignable,
  buildSwap,
  erc20Abi,
  findBestRoute,
  isBuildable,
  isPlaceholderRecipient,
  isTradeError,
  probeTokenSafety,
  resolveConfig,
  robinhoodChain,
  simulateSwap,
  TRADE_ADDRESSES,
  type BuiltSwap,
  type QuoteAsset,
  type RouteResult,
  type SwapSimulation,
  type TokenSafety,
} from '@rushr/trade';
import { API_URL } from '@/lib/api';
import { short } from '@/lib/format';
import { requestAccount, useInjectedWallets, type InjectedWallet } from './wallet';

/**
 * Swap test bed. Quotes and simulations run in the browser against the public Robinhood Chain RPC
 * (eth_call / eth_simulateV1). This component never asks the wallet to sign or send anything.
 */

const client = createPublicClient({ chain: robinhoodChain, transport: http(), batch: { multicall: true } }) as PublicClient;
// Placeholder fee config (see docs/trading.md): 1% to a placeholder treasury. Signing is refused until it is set.
const cfg = resolveConfig();
/** Used when no wallet is connected: an empty address, funded only inside the simulation. */
const SIM_TRADER: Address = '0x00000000000000000000000000000000c0ffee01';

interface TokenInfo {
  symbol: string;
  name: string;
  decimals: number;
  main_pool?: `0x${string}` | null;
  created_block?: string;
  launchpad?: string | null;
}

const QUOTE_DECIMALS: Record<QuoteAsset, number> = { ETH: 18, USDG: 6 };

function fmt(v: bigint, decimals: number, max = 6): string {
  const s = formatUnits(v, decimals);
  const [i, f = ''] = s.split('.');
  return f ? `${Number(i).toLocaleString('en-US')}.${f.slice(0, max).replace(/0+$/, '') || '0'}` : Number(i).toLocaleString('en-US');
}

const bps = (n: number | null | undefined) => (n == null ? '—' : `${(n / 100).toFixed(2)}%`);

export function SwapPanel({ initialToken }: { initialToken: string }) {
  const wallets = useInjectedWallets();
  const [account, setAccount] = useState<{ address: Address; chainId: number; wallet: string } | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);

  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [tokenInput, setTokenInput] = useState(initialToken);
  const [quoteAsset, setQuoteAsset] = useState<QuoteAsset>('ETH');
  const [amount, setAmount] = useState('0.01');
  const [slippage, setSlippage] = useState('1');
  /** Test-bed stand-in for the referral the server would resolve from the trader's signup. */
  const [referrer, setReferrer] = useState('');

  const [token, setToken] = useState<TokenInfo | null>(null);
  const [route, setRoute] = useState<RouteResult | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);

  const [sim, setSim] = useState<{ built: BuiltSwap; result: SwapSimulation; funded: boolean } | null>(null);
  const [safety, setSafety] = useState<TokenSafety | null>(null);
  const [simulating, setSimulating] = useState(false);

  const tokenAddress = isAddress(tokenInput) ? (tokenInput.toLowerCase() as Address) : null;
  const trader = account?.address ?? SIM_TRADER;

  // Token metadata from the Rushr API (decimals, main pool hint).
  useEffect(() => {
    setToken(null);
    if (!tokenAddress) return;
    let cancelled = false;
    fetch(`${API_URL}/tokens/${tokenAddress}`)
      .then((r) => (r.ok ? (r.json() as Promise<TokenInfo>) : null))
      .then((t: TokenInfo | null | undefined) => !cancelled && setToken(t ?? { symbol: short(tokenAddress), name: '', decimals: 18 }))
      .catch(() => !cancelled && setToken({ symbol: short(tokenAddress), name: '', decimals: 18 }));
    return () => {
      cancelled = true;
    };
  }, [tokenAddress]);

  const inDecimals = side === 'buy' ? QUOTE_DECIMALS[quoteAsset] : (token?.decimals ?? 18);
  const outDecimals = side === 'buy' ? (token?.decimals ?? 18) : QUOTE_DECIMALS[quoteAsset];
  const inSymbol = side === 'buy' ? quoteAsset : (token?.symbol ?? 'token');
  const outSymbol = side === 'buy' ? (token?.symbol ?? 'token') : quoteAsset;

  const amountIn = useMemo(() => {
    try {
      const v = parseUnits(amount || '0', inDecimals);
      return v > 0n ? v : null;
    } catch {
      return null;
    }
  }, [amount, inDecimals]);
  const slippageBps = Math.round(Number(slippage) * 100);

  const getQuote = useCallback(async () => {
    if (!tokenAddress || !amountIn || !token) return;
    setQuoting(true);
    setError(null);
    setSim(null);
    setSafety(null);
    try {
      const r = await findBestRoute(
        client,
        {
          side,
          token: tokenAddress,
          quoteAsset,
          amountIn,
          trader,
          slippageBps: Number.isFinite(slippageBps) ? slippageBps : cfg.defaultSlippageBps,
          referral: isAddress(referrer) ? { referrer: referrer as Address } : null,
          source: { kind: 'web' },
        },
        cfg,
        { mainPool: token.main_pool ?? null, createdBlock: token.created_block ? BigInt(token.created_block) : undefined },
      );
      setRoute(r);
      setSelected(Math.max(0, r.quotes.indexOf(r.best)));
    } catch (e) {
      setRoute(null);
      setError(isTradeError(e) ? `${e.code}: ${e.message}` : String((e as Error).message ?? e));
    } finally {
      setQuoting(false);
    }
  }, [tokenAddress, amountIn, token, side, quoteAsset, trader, slippageBps, referrer]);

  const quote = route?.quotes[selected] ?? null;
  const buildable = quote ? isBuildable(quote.pool, cfg) : false;

  const simulate = useCallback(async () => {
    if (!quote) return;
    setSimulating(true);
    setError(null);
    setSim(null);
    setSafety(null);
    try {
      // Sells and USDG buys spend a real ERC20 balance, which a simulation can't conjure.
      const spent = side === 'sell' ? quote.pool.token : quoteAsset === 'USDG' ? TRADE_ADDRESSES.usdg : null;
      if (spent) {
        const bal = await client.readContract({ address: spent, abi: erc20Abi, functionName: 'balanceOf', args: [trader] });
        if (bal < quote.amountIn) {
          setError(`${account ? 'This wallet' : 'The simulated wallet'} holds ${fmt(bal, inDecimals)} ${inSymbol}; connect a wallet that holds at least ${fmt(quote.amountIn, inDecimals)} to simulate this ${side}.`);
          return;
        }
      }
      const built = buildSwap(quote, cfg);
      // Buys with ETH: top up the balance inside the simulation only, so it works without funds.
      const funded = side === 'buy' && quoteAsset === 'ETH';
      const [result, probe] = await Promise.all([
        simulateSwap(client, built, cfg, funded ? { fundEth: quote.amountIn + 10n ** 17n } : {}),
        side === 'buy' && quoteAsset === 'ETH' ? probeTokenSafety(client, quote, cfg).catch(() => null) : Promise.resolve(null),
      ]);
      setSim({ built, result, funded });
      setSafety(probe);
    } catch (e) {
      setError(isTradeError(e) ? `${e.code}: ${e.message}` : String((e as Error).message ?? e));
    } finally {
      setSimulating(false);
    }
  }, [quote, side, quoteAsset, trader, account, inDecimals, inSymbol]);

  const connect = async (w: InjectedWallet) => {
    setWalletError(null);
    try {
      const a = await requestAccount(w);
      setAccount({ ...a, wallet: w.name });
    } catch (e) {
      setWalletError((e as Error).message);
    }
  };

  let signBlock: string | null = null;
  try {
    assertSignable(cfg);
  } catch (e) {
    signBlock = (e as Error).message;
  }

  return (
    <div className="mx-auto grid max-w-5xl grid-cols-1 gap-4 px-4 py-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <header className="lg:col-span-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight">Swap</h1>
          <span className="rounded-md bg-risk-medium/15 px-2 py-0.5 text-[11px] font-medium text-risk-medium">Test bed · simulation only</span>
        </div>
        <p className="mt-1 text-sm text-muted">
          Quotes and simulations run against Robinhood Chain with <code className="font-mono text-ink/80">eth_call</code> and{' '}
          <code className="font-mono text-ink/80">eth_simulateV1</code>. Nothing is signed or sent.
        </p>
      </header>

      {/* Left: inputs */}
      <section className="min-w-0 rounded-2xl border border-line bg-surface p-4">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div className="flex rounded-xl bg-surface-2 p-1 text-sm" role="tablist" aria-label="Side">
            {(['buy', 'sell'] as const).map((s) => (
              <button
                key={s}
                type="button"
                role="tab"
                aria-selected={side === s}
                onClick={() => {
                  setSide(s);
                  setRoute(null);
                  setSim(null);
                  setAmount(s === 'buy' ? '0.01' : '1000');
                }}
                className={`rounded-lg px-4 py-1.5 font-medium capitalize transition ${side === s ? (s === 'buy' ? 'bg-go text-bg' : 'bg-risk-high text-bg') : 'text-muted hover:text-ink'}`}
              >
                {s}
              </button>
            ))}
          </div>
          <WalletButton wallets={wallets} account={account} onConnect={connect} onDisconnect={() => setAccount(null)} />
        </div>
        {walletError && <p className="mb-3 text-xs text-risk-high">{walletError}</p>}
        {account && account.chainId !== TRADE_ADDRESSES.chainId && (
          <p className="mb-3 text-xs text-risk-medium">Wallet is on chain {account.chainId}; Robinhood Chain is {TRADE_ADDRESSES.chainId}. Simulation still works.</p>
        )}

        <label className="block text-xs text-muted" htmlFor="swap-token">
          Token
        </label>
        <input
          id="swap-token"
          value={tokenInput}
          onChange={(e) => setTokenInput(e.target.value.trim())}
          spellCheck={false}
          className="mt-1 w-full rounded-xl border border-line bg-surface-2 px-3 py-2 font-mono text-xs outline-none focus:border-brand/60"
          placeholder="0x…"
        />
        <p className="mt-1 h-4 truncate text-xs text-muted">
          {tokenAddress ? (token ? `${token.symbol}${token.name ? ` · ${token.name}` : ''}${token.launchpad ? ` · ${token.launchpad}` : ''}` : 'Loading…') : 'Paste a token address'}
        </p>

        <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] gap-2">
          <div>
            <label className="block text-xs text-muted" htmlFor="swap-amount">
              {side === 'buy' ? 'You pay' : 'You sell'} ({inSymbol})
            </label>
            <input
              id="swap-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(',', '.'))}
              className="mt-1 w-full rounded-xl border border-line bg-surface-2 px-3 py-2 font-mono text-lg tabular-nums outline-none focus:border-brand/60"
            />
          </div>
          <div>
            <span className="block text-xs text-muted">Quote asset</span>
            <div className="mt-1 flex rounded-xl bg-surface-2 p-1 text-sm">
              {(['ETH', 'USDG'] as const).map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => {
                    setQuoteAsset(q);
                    setRoute(null);
                    setSim(null);
                    if (side === 'buy') setAmount(q === 'ETH' ? '0.01' : '25');
                  }}
                  className={`rounded-lg px-2.5 py-2 font-medium transition ${quoteAsset === q ? 'bg-white/[0.09] text-ink' : 'text-muted hover:text-ink'}`}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-3 flex items-center gap-2 text-xs text-muted">
          <label htmlFor="swap-slippage">Slippage</label>
          <input
            id="swap-slippage"
            inputMode="decimal"
            value={slippage}
            onChange={(e) => setSlippage(e.target.value)}
            className="w-16 rounded-lg border border-line bg-surface-2 px-2 py-1 text-right font-mono text-ink outline-none"
          />
          <span>%</span>
          <span className="ml-auto">Trader: {account ? short(account.address) : 'simulated wallet'}</span>
        </div>
        <div className="mt-2 flex items-center gap-2 text-xs text-muted">
          <label htmlFor="swap-referrer" className="shrink-0">
            Referred by
          </label>
          <input
            id="swap-referrer"
            value={referrer}
            onChange={(e) => setReferrer(e.target.value.trim())}
            spellCheck={false}
            placeholder="referrer address (optional, test only)"
            className="min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-2 py-1 font-mono text-ink outline-none"
          />
        </div>

        <button
          type="button"
          onClick={getQuote}
          disabled={!tokenAddress || !amountIn || !token || quoting}
          className="mt-4 w-full rounded-xl bg-ink py-2.5 text-sm font-semibold text-bg transition hover:bg-ink/90 disabled:opacity-40"
        >
          {quoting ? 'Finding routes…' : 'Get quote'}
        </button>

        {route && (
          <div className="mt-4">
            <p className="mb-1.5 text-xs text-muted">
              Routes ({route.quotes.length} quoted{route.failures.length ? `, ${route.failures.length} failed` : ''})
            </p>
            <ul className="space-y-1">
              {route.quotes.map((q, i) => (
                <li key={q.pool.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelected(i);
                      setSim(null);
                      setSafety(null);
                    }}
                    className={`flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-xs transition ${i === selected ? 'border-brand/50 bg-brand/[0.06]' : 'border-line hover:border-white/20'}`}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-ink">{q.pool.venueFeeLabel}</span>
                      <span className="font-mono text-muted">{short(q.pool.id, 6, 4)}</span>
                      {!isBuildable(q.pool, cfg) && <span className="ml-2 text-risk-medium">needs curve router</span>}
                    </span>
                    <span className="shrink-0 text-right font-mono tabular-nums">
                      {fmt(q.amountOut, outDecimals, 4)} <span className="text-muted">{outSymbol}</span>
                      <span className="block text-muted">impact {bps(q.priceImpactBps)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {error && <p className="mt-3 break-words text-xs text-risk-high">{error}</p>}
      </section>

      {/* Right: breakdown, simulation */}
      <section className="min-w-0 space-y-4">
        <div className="rounded-2xl border border-line bg-surface p-4">
          <h2 className="mb-3 text-sm font-semibold">Fee breakdown</h2>
          {quote ? (
            <dl className="space-y-2 text-sm">
              <Row label={side === 'buy' ? 'You pay' : 'You sell'} value={`${fmt(quote.amountIn, inDecimals)} ${inSymbol}`} />
              <Row
                label={`Rushr fee (${bps(quote.fee.feeBps)}, from ${side === 'buy' ? 'input' : 'output'})`}
                value={`${fmt(quote.fee.feeAmount, QUOTE_DECIMALS[quoteAsset])} ${quoteAsset}`}
                strong
              />
              {quote.fee.feeBps < quote.fee.baseFeeBps && (
                <Row
                  label={`Referral discount (${bps(quote.fee.baseFeeBps)} → ${bps(quote.fee.feeBps)})`}
                  value={`−${fmt(quote.fee.referralDiscountAmount, QUOTE_DECIMALS[quoteAsset])} ${quoteAsset}`}
                />
              )}
              {quote.fee.referrerAccrual > 0n && (
                <Row label={`Referrer accrues (${bps(cfg.referrerShareBps)} of fee, off-chain)`} value={`${fmt(quote.fee.referrerAccrual, QUOTE_DECIMALS[quoteAsset])} ${quoteAsset}`} />
              )}
              <Row label="Venue fees (paid to the pool or curve)" value={quote.pool.venueFeeLabel.split(' · ').slice(1).join(' · ') || bps(quote.fee.venueFeeBps)} />
              <Row label="Price impact" value={bps(quote.priceImpactBps)} />
              <Row label="You receive (estimated)" value={`${fmt(quote.amountOut, outDecimals)} ${outSymbol}`} strong />
              <Row label={`Minimum received (${bps(quote.slippageBps)} slippage)`} value={`${fmt(quote.minAmountOut, outDecimals)} ${outSymbol}`} />
              {quote.expectedRefund > 0n && <Row label="Refunded (curve graduates)" value={`${fmt(quote.expectedRefund, QUOTE_DECIMALS[quoteAsset])} ${quoteAsset}`} />}
              {quote.warnings.map((w) => (
                <p key={w} className="rounded-lg bg-risk-medium/10 px-2.5 py-1.5 text-xs text-risk-medium">
                  {w}
                </p>
              ))}
            </dl>
          ) : (
            <p className="text-sm text-muted">Get a quote to see the fee breakdown.</p>
          )}
          {isPlaceholderRecipient(cfg) && <p className="mt-3 text-[11px] text-muted">Fee recipient is a placeholder until the treasury address is set.</p>}
        </div>

        <div className="rounded-2xl border border-line bg-surface p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">Simulation</h2>
            <button
              type="button"
              onClick={simulate}
              disabled={!quote || !buildable || simulating}
              className="rounded-lg bg-go px-3 py-1.5 text-xs font-semibold text-bg transition disabled:opacity-40"
            >
              {simulating ? 'Simulating…' : 'Simulate'}
            </button>
          </div>
          {quote && !buildable && <p className="mt-2 text-xs text-risk-medium">PONS curve routes need the Rushr curve router, which is not deployed. Pick another route.</p>}
          {sim ? (
            <div className="mt-3 space-y-2 text-sm">
              <p className={sim.result.ok ? 'text-brand' : 'text-risk-high'}>{sim.result.ok ? 'Swap succeeds' : `Reverts: ${sim.result.error}`}</p>
              <dl className="space-y-2">
                <Row label="Received" value={`${fmt(sim.result.received, outDecimals)} ${outSymbol}`} />
                <Row label="Treasury received" value={`${fmt(sim.result.feePaid, QUOTE_DECIMALS[quoteAsset])} ${quoteAsset}`} />
                <Row label="Measured token tax" value={bps(sim.result.tokenTaxBps)} />
                <Row label="Gas (swap call)" value={sim.result.gasUsed.toLocaleString('en-US')} />
              </dl>
              {sim.funded && <p className="text-[11px] text-muted">The trader's ETH balance was topped up inside the simulation only.</p>}
              <ol className="mt-2 space-y-1 text-xs">
                {sim.result.calls.map((c, i) => (
                  <li key={i} className="flex justify-between gap-2 font-mono">
                    <span className="truncate text-muted">{c.label}</span>
                    <span className={c.ok ? 'text-brand' : 'text-risk-high'}>{c.ok ? 'ok' : 'revert'}</span>
                  </li>
                ))}
              </ol>
            </div>
          ) : (
            <p className="mt-2 text-sm text-muted">Runs the approvals and the swap in one simulated block.</p>
          )}
          {safety && (
            <div className="mt-3 rounded-lg bg-surface-2 p-2.5 text-xs">
              <p className="font-medium">Buy → sell probe</p>
              <p className="mt-1 text-muted">
                {safety.honeypot ? <span className="text-risk-high">Cannot sell after buying (honeypot)</span> : safety.sellOk ? 'Sells back' : 'Probe failed'} · buy tax{' '}
                {bps(safety.buyTaxBps)} · sell tax {bps(safety.sellTaxBps)} · round trip {bps(safety.roundTripBps)}
              </p>
            </div>
          )}
        </div>

        {sim && (
          <details className="rounded-2xl border border-line bg-surface p-4 text-xs">
            <summary className="cursor-pointer text-sm font-semibold">Unsigned transaction</summary>
            <dl className="mt-3 space-y-1.5 font-mono">
              <Row label="to" value={sim.built.tx.to} />
              <Row label="value" value={`${fmt(sim.built.tx.value, 18)} ETH`} />
              <Row label="commands" value={sim.built.commands.map((c) => c.label).join(' → ') || 'RushrCurveRouter'} />
              <Row label="approvals" value={sim.built.approvals.map((a) => `${a.kind} → ${short(a.spender)}`).join(', ') || 'none'} />
              <Row label="calldata" value={`${(sim.built.tx.data.length - 2) / 2} bytes`} />
            </dl>
            <button type="button" disabled title={signBlock ?? undefined} className="mt-3 w-full rounded-xl border border-line py-2 font-semibold text-muted">
              Signing disabled in the test bed
            </button>
            {signBlock && <p className="mt-1.5 text-[11px] text-muted">{signBlock}.</p>}
          </details>
        )}
      </section>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className={`min-w-0 truncate text-right tabular-nums ${strong ? 'font-semibold text-ink' : ''}`}>{value}</dd>
    </div>
  );
}

function WalletButton({
  wallets,
  account,
  onConnect,
  onDisconnect,
}: {
  wallets: InjectedWallet[];
  account: { address: Address; wallet: string } | null;
  onConnect: (w: InjectedWallet) => void;
  onDisconnect: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (account)
    return (
      <button type="button" onClick={onDisconnect} title={`${account.wallet}, click to disconnect`} className="rounded-xl bg-surface-2 px-3 py-2 font-mono text-xs">
        {short(account.address)}
      </button>
    );
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} className="rounded-xl bg-ink px-3 py-2 text-xs font-semibold text-bg">
        Connect wallet
      </button>
      {open && (
        <div className="absolute right-0 z-10 mt-1 w-56 rounded-xl border border-line bg-surface-2 p-1 shadow-xl">
          {wallets.length ? (
            wallets.map((w) => (
              <button
                key={w.id}
                type="button"
                onClick={() => {
                  setOpen(false);
                  onConnect(w);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs hover:bg-white/[0.06]"
              >
                {w.icon && <img src={w.icon} alt="" className="size-4" />}
                {w.name}
              </button>
            ))
          ) : (
            <p className="px-2.5 py-2 text-xs text-muted">No browser wallet found. Quotes and simulation still work with a simulated wallet.</p>
          )}
        </div>
      )}
    </div>
  );
}
