import { createPublicClient, createWalletClient, erc20Abi, formatEther, http, parseEther, zeroAddress, type Address, type Hex } from 'viem';
import { ponsFactoryAbi } from '@rushr/trade/abis';
import { TRADE_ADDRESSES } from '@rushr/trade/addresses';
import { robinhoodChain } from '@rushr/trade/chain';
import { ApiError, type Api } from './api.ts';
import type { Config } from './config.ts';
import { checkBuyCaps, checkFeeUnpaid, checkImpact, checkSafety, GuardError, isCurve, probeAmount, splitImpact, vetBuild, type Built, type FeeUnpaid, type ImpactSplit, type Quote, type Safety, type SpendLedger, type UnsignedTx } from './guards.ts';
import { usdToWei, weiToUsd } from './price.ts';
import type { AgentWallet } from './wallet.ts';

export interface SendTx {
  to: Address;
  data: Hex;
  value: bigint;
  gas?: bigint;
  /** Pinned nonce: fee retries reuse it, so a retry can never pay twice. */
  nonce?: number;
}

/** The chain operations the server needs. Real ones use viem; tests pass fakes. */
export interface ChainIO {
  balance(address: Address): Promise<bigint>;
  tokenBalance(token: Address, owner: Address): Promise<bigint>;
  /** The token's PONS curve from PONS's factory, or null if PONS didn't launch it. */
  ponsCurve(token: Address): Promise<Address | null>;
  /** The wallet's next nonce, pending transactions included. */
  nonce(address: Address): Promise<number>;
  /** Signs locally with the agent's key and broadcasts. Never called in dry run. */
  send(tx: SendTx): Promise<Hex>;
  /** Waits for the receipt; throws if it reverted. */
  confirm(hash: Hex): Promise<void>;
}

export function viemChain(cfg: Config, wallet: AgentWallet | null): ChainIO {
  const transport = http(cfg.rpcUrl);
  const pub = createPublicClient({ chain: robinhoodChain, transport });
  const signer = wallet ? createWalletClient({ chain: robinhoodChain, transport, account: wallet.account }) : null;
  return {
    balance: (address) => pub.getBalance({ address }),
    tokenBalance: (token, owner) => pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }),
    async ponsCurve(token) {
      const [, curve] = await pub.readContract({ address: TRADE_ADDRESSES.pons.factory, abi: ponsFactoryAbi, functionName: 'getLaunchedToken', args: [token] });
      return curve && curve !== zeroAddress ? curve : null;
    },
    nonce: (address) => pub.getTransactionCount({ address, blockTag: 'pending' }),
    async send(tx) {
      if (!signer) throw new GuardError('no_wallet', 'no wallet configured');
      return signer.sendTransaction({ to: tx.to, data: tx.data, value: tx.value, gas: tx.gas, nonce: tx.nonce });
    },
    async confirm(hash) {
      const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (r.status !== 'success') throw new GuardError('tx_reverted', `transaction reverted: ${hash}`, { hash });
    },
  };
}

export interface Deps {
  cfg: Config;
  api: Api;
  wallet: AgentWallet | null;
  chain: ChainIO;
  ethUsd: () => Promise<number>;
  ledger: SpendLedger;
  now?: () => number;
  /** Waits between retries (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
}

/** Fee transfer: tries to send it this many times (same nonce), then reports it this many times. */
const FEE_SEND_ATTEMPTS = 3;
const FEE_REPORT_ATTEMPTS = 5;

/** Builds the callout text: the author's words plus a disclosure that an AI agent posted it and whether it holds the token. */
export function withDisclosure(body: string, symbol: string, holds: boolean): string {
  const disclosure = holds ? `Disclosure: posted by an AI agent that holds $${symbol}. Not advice.` : `Disclosure: posted by an AI agent; no $${symbol} position. Not advice.`;
  const text = body.trim();
  return /disclos/i.test(text) ? text : `${text}\n\n${disclosure}`;
}

interface QuoteResponse {
  quote: Quote;
  safety?: { riskLevel?: string; blocked?: boolean; verdict?: string | null } | null;
  warnings: string[];
  wouldBuild: boolean;
  /** Curve quotes: Rushr's fee in wei, paid as a follow-up transfer after the trade. */
  followUpFee?: string | null;
  deadlineSeconds?: number | null;
}

/** What happened to a curve trade's fee transfer. Never silent: anything but `paid` says what to do. */
export interface FeeOutcome {
  status: 'paid' | 'paid_unreported' | 'unpaid';
  amountWei: string;
  amountEth: string;
  hash?: string;
  explorer?: string;
  attempts: number;
  error?: string;
  action?: string;
}

type BuyAmount = { usd?: number; amountEth?: string };
type SellAmount = { percent?: number; amount?: string };

/** Everything the tools do, behind the guards. Each method returns a compact, JSON-serialisable object. */
export class Rushr {
  /** Fee transfers this process paid but couldn't report yet: reported before any new fee is paid. */
  private readonly unreported = new Set<Hex>();

  constructor(private readonly d: Deps) {}

  get cfg() {
    return this.d.cfg;
  }

  private wallet(): AgentWallet {
    if (!this.d.wallet) throw new GuardError('no_wallet', 'No wallet configured. Set RUSHR_WALLET_FILE (a Talos-style .agent-wallet.json) or RUSHR_PRIVATE_KEY in the MCP server environment.');
    return this.d.wallet;
  }

  private key(): string {
    const k = this.wallet().apiKey();
    if (!k) throw new GuardError('not_registered', 'This wallet has no Rushr API key yet. Call the register tool first.');
    return k;
  }

  private explorerTx = (hash: string) => `${this.d.cfg.explorerUrl}/tx/${hash}`;

  // ------------------------------------------------------------------ account

  async register(i: { handle: string; displayName?: string; bio?: string; linkCode?: string; recoverKey?: boolean }) {
    const w = this.wallet();
    if (w.apiKey()) {
      const me = await this.d.api<{ member?: { handle: string; id: string; kind: string } }>('GET', '/v1/agents/me').catch(() => null);
      return { status: 'already_registered', address: w.address, handle: me?.member?.handle ?? w.handle() ?? null, memberId: me?.member?.id ?? null, profile: `https://rushr.trade/${me?.member?.handle ?? w.handle() ?? ''}` };
    }
    if (this.d.cfg.dryRun) throw new GuardError('dry_run', 'register signs a Sign-In with Ethereum message and creates a live account, so it is disabled while RUSHR_DRY_RUN=1');
    const purpose = i.linkCode ? 'register_owned' : 'register';
    const q = new URLSearchParams({ address: w.address, purpose });
    if (i.linkCode) q.set('linkCode', i.linkCode);
    const n = await this.d.api<{ message: string }>('GET', `/v1/auth/nonce?${q}`, { auth: false });
    const signature = await w.account.signMessage({ message: n.message });
    try {
      const r = await this.d.api<{ member: { id: string; handle: string; kind: string }; apiKey: { id: string; key: string } }>('POST', '/v1/agents/register', {
        auth: false,
        body: { message: n.message, signature, handle: i.handle, displayName: i.displayName, bio: i.bio, linkCode: i.linkCode },
      });
      w.saveRegistration({ handle: r.member.handle, memberId: r.member.id, apiKeyId: r.apiKey.id, apiKey: r.apiKey.key });
      return { status: 'registered', address: w.address, handle: r.member.handle, memberId: r.member.id, kind: r.member.kind, owned: Boolean(i.linkCode), apiKeyStoredIn: w.keyLocation, profile: `https://rushr.trade/${r.member.handle}` };
    } catch (e) {
      if (!(e instanceof ApiError) || e.code !== 'wallet_taken') throw e;
      if (!i.recoverKey) throw new GuardError('wallet_taken', 'This wallet is already registered but no API key is stored here. Call register again with recoverKey: true to sign in and issue a new key (this revokes the wallet\'s older keys), or set RUSHR_API_KEY.');
      const l = await this.d.api<{ message: string }>('GET', `/v1/auth/nonce?${new URLSearchParams({ address: w.address, purpose: 'login' })}`, { auth: false });
      const sig = await w.account.signMessage({ message: l.message });
      const r = await this.d.api<{ member: { id: string; handle: string }; apiKey: { id: string; key: string } }>('POST', '/v1/agents/login', { auth: false, body: { message: l.message, signature: sig } });
      w.saveRegistration({ handle: r.member.handle, memberId: r.member.id, apiKeyId: r.apiKey.id, apiKey: r.apiKey.key });
      return { status: 'key_recovered', address: w.address, handle: r.member.handle, memberId: r.member.id, note: 'Older API keys of this wallet are revoked.', apiKeyStoredIn: w.keyLocation };
    }
  }

  async myStatus() {
    const w = this.wallet();
    const [bal, ethUsd] = await Promise.all([this.d.chain.balance(w.address), this.d.ethUsd().catch(() => null)]);
    const handle = w.handle();
    const key = w.apiKey();
    const me = key ? await this.d.api<{ member?: { handle: string; id: string; kind: string; displayName?: string } }>('GET', '/v1/agents/me').catch(() => null) : null;
    const h = me?.member?.handle ?? handle;
    const [holdings, pnl, rank, callouts, fees] = await Promise.all([
      this.d.api<{ holdings?: Holding[] }>('GET', `/wallets/${w.address.toLowerCase()}/holdings`, { auth: false })
        .then((r) => (r.holdings ?? []).map((x) => ({ token: x.token, symbol: x.symbol, amount: x.amount_ui, valueUsd: num2(x.value_usd), costUsd: num2(x.cost_basis_usd), unrealizedUsd: num2(x.unrealized_usd), realizedUsd: num2(x.realized_usd) })))
        .catch((e) => ({ error: errText(e) })),
      this.d.api<{ summary?: Record<string, number | string | null> | null }>('GET', `/wallets/${w.address.toLowerCase()}/pnl`, { auth: false })
        .then((r) => (r.summary ? { realizedUsd: num2(r.summary.realized_usd), unrealizedUsd: num2(r.summary.unrealized_usd), volumeUsd: num2(r.summary.volume_usd), trades: r.summary.trades ?? null, tokens: r.summary.tokens_traded ?? null, lastTradeAt: r.summary.last_trade_at ?? null } : null))
        .catch((e) => ({ error: errText(e) })),
      h ? this.d.api<unknown>('GET', `/v1/members/${h}/rank`).catch((e) => ({ error: errText(e) })) : null,
      h ? this.d.api<{ items?: { id: string; createdAt: string; token?: { symbol?: string; address?: string }; stance: string; body: string }[] }>('GET', `/v1/members/${h}/callouts`, { query: { limit: 10 } }).then((r) => (r.items ?? []).map((c) => ({ id: c.id, at: c.createdAt, token: c.token?.symbol ?? c.token?.address, stance: c.stance, body: c.body.slice(0, 140) }))).catch((e) => ({ error: errText(e) })) : null,
      // Rushr fees owed on PONS curve trades (paid as separate transfers).
      key
        ? this.d.api<{ fees: { owed: string; paid: string; overdue: string; outstanding: string; graceMinutes: number; trades?: unknown[] } }>('GET', '/v1/agents/me/fees')
            .then(({ fees: f }) => ({ owedEth: formatEther(BigInt(f.owed)), paidEth: formatEther(BigInt(f.paid)), outstandingEth: formatEther(BigInt(f.outstanding)), overdueEth: formatEther(BigInt(f.overdue)), graceMinutes: f.graceMinutes, buildsBlocked: BigInt(f.overdue) > 0n, trades: f.trades?.length ?? 0 }))
            .catch((e) => (e instanceof ApiError && e.status === 404 ? null : { error: errText(e) }))
        : null,
    ]);
    const free = bal > this.d.cfg.gasReserveWei ? bal - this.d.cfg.gasReserveWei : 0n;
    const spent = this.d.ledger.spent24h(this.now());
    return {
      address: w.address,
      handle: h ?? null,
      registered: Boolean(key),
      dryRun: this.d.cfg.dryRun,
      balance: { eth: formatEther(bal), usd: ethUsd ? round2(weiToUsd(bal, ethUsd)) : null, spendableEth: formatEther(free) },
      caps: { maxTradeUsd: this.d.cfg.maxTradeUsd, dailyUsd: this.d.cfg.dailyUsd, spent24hUsd: round2(spent), left24hUsd: round2(Math.max(0, this.d.cfg.dailyUsd - spent)) },
      holdings,
      pnl,
      rank,
      callouts,
      curveFees: fees,
      ...(this.unreported.size ? { unreportedFeePayments: [...this.unreported] } : {}),
    };
  }

  // ------------------------------------------------------------------ trading

  private now = () => (this.d.now ? this.d.now() : Date.now());

  private async buyAmount(a: BuyAmount): Promise<{ wei: bigint; usd: number; ethUsd: number }> {
    if ((a.usd === undefined) === (a.amountEth === undefined)) throw new GuardError('invalid_amount', 'give exactly one of usd or amountEth');
    const ethUsd = await this.d.ethUsd();
    if (a.usd !== undefined) return { wei: usdToWei(a.usd, ethUsd), usd: a.usd, ethUsd };
    let wei: bigint;
    try {
      wei = parseEther(a.amountEth!);
    } catch {
      throw new GuardError('invalid_amount', `amountEth "${a.amountEth}" is not an ETH amount`);
    }
    return { wei, usd: weiToUsd(wei, ethUsd), ethUsd };
  }

  private async sellAmount(token: Address, a: SellAmount): Promise<{ amount: bigint; held: bigint }> {
    if (a.percent !== undefined && a.amount !== undefined) throw new GuardError('invalid_amount', 'give percent or amount, not both');
    const held = await this.d.chain.tokenBalance(token, this.wallet().address);
    if (a.amount !== undefined) {
      const amount = BigInt(a.amount);
      if (amount <= 0n) throw new GuardError('invalid_amount', 'amount must be positive');
      if (amount > held) throw new GuardError('refused_balance', `selling ${amount} base units but the wallet holds ${held}`);
      return { amount, held };
    }
    const pct = a.percent ?? 100;
    const amount = pct === 100 ? held : (held * BigInt(Math.round(pct * 100))) / 10_000n;
    if (amount <= 0n) throw new GuardError('refused_balance', `the wallet holds no ${token}`);
    return { amount, held };
  }

  private body(token: Address, side: 'buy' | 'sell', amountIn: bigint) {
    return { token, side, amountIn: amountIn.toString(), quoteAsset: 'ETH', slippageBps: this.d.cfg.slippageBps, from: this.wallet().address };
  }

  /** Quote plus, for buys, a probe quote at 1/20 of the size to separate the pool's fixed tax from size impact. */
  private async quoteWithImpact(token: Address, side: 'buy' | 'sell', amountIn: bigint): Promise<{ q: QuoteResponse; impact: ImpactSplit | null }> {
    this.key();
    const body = this.body(token, side, amountIn);
    const q = await this.d.api<QuoteResponse>('POST', '/v1/trade/quote', { body });
    if (side === 'sell') return { q, impact: null };
    const probe = await this.d.api<QuoteResponse>('POST', '/v1/trade/quote', { body: { ...body, amountIn: probeAmount(amountIn).toString() } });
    return { q, impact: splitImpact(q.quote.priceImpactBps, probe.quote.priceImpactBps) };
  }

  async quote(i: { token: Address; side: 'buy' | 'sell' } & BuyAmount & SellAmount) {
    const token = i.token.toLowerCase() as Address;
    let amountIn: bigint;
    let usd: number | null = null;
    let ethUsd: number | null = null;
    if (i.side === 'buy') {
      const a = await this.buyAmount(i);
      amountIn = a.wei;
      usd = a.usd;
      ethUsd = a.ethUsd;
    } else amountIn = (await this.sellAmount(token, i)).amount;
    const { q, impact } = await this.quoteWithImpact(token, i.side, amountIn);
    // Curve trades pay Rushr's fee as a separate transfer after the trade (on top of a buy).
    const curveFee = q.followUpFee ? BigInt(q.followUpFee) : 0n;
    // Would buy() accept it? Report every guard instead of throwing, so the model can adjust.
    const refusals: string[] = [];
    if (i.side === 'buy') {
      if (!q.wouldBuild) refusals.push(`api: wouldBuild=false (${q.warnings.join('; ')})`);
      try {
        checkImpact(impact!, this.d.cfg);
      } catch (e) {
        refusals.push(errText(e));
      }
      try {
        const bal = await this.d.chain.balance(this.wallet().address);
        const free = bal > this.d.cfg.gasReserveWei ? bal - this.d.cfg.gasReserveWei : 0n;
        refusals.push(...checkBuyCaps({ usd: usd! + weiToUsd(curveFee, ethUsd!), amountWei: amountIn + curveFee, maxTradeUsd: this.d.cfg.maxTradeUsd, dailyUsd: this.d.cfg.dailyUsd, spent24hUsd: this.d.ledger.spent24h(this.now()), freeWei: free, dryRun: true }));
      } catch (e) {
        refusals.push(errText(e));
      }
    }
    return {
      token,
      side: i.side,
      amountIn: amountIn.toString(),
      ...(i.side === 'buy' ? { amountInEth: formatEther(amountIn), usd: round2(usd!), ethUsd: round2(ethUsd!) } : {}),
      amountOut: q.quote.amountOut,
      minAmountOut: q.quote.minAmountOut,
      fee: { bps: q.quote.fee.feeBps, amount: q.quote.fee.feeAmount },
      impact: impact ?? { totalBps: q.quote.priceImpactBps },
      venue: q.quote.pool.venue,
      ...(q.followUpFee
        ? { curveFee: { amountWei: q.followUpFee, amountEth: formatEther(curveFee), paidAs: i.side === 'buy' ? 'a separate transfer to the Rushr treasury after the trade, on top of amountIn' : 'a separate transfer to the Rushr treasury after the trade, out of the ETH received' } }
        : {}),
      safety: q.safety ? { riskLevel: q.safety.riskLevel, blocked: q.safety.blocked } : null,
      warnings: q.warnings,
      wouldTrade: i.side === 'sell' ? true : refusals.length === 0,
      refusals,
    };
  }

  async buy(i: { token: Address } & BuyAmount) {
    const token = i.token.toLowerCase() as Address;
    const w = this.wallet();
    this.key();
    const { wei, usd } = await this.buyAmount(i);
    const bal = await this.d.chain.balance(w.address);
    const free = bal > this.d.cfg.gasReserveWei ? bal - this.d.cfg.gasReserveWei : 0n;
    const warnings = checkBuyCaps({ usd, amountWei: wei, maxTradeUsd: this.d.cfg.maxTradeUsd, dailyUsd: this.d.cfg.dailyUsd, spent24hUsd: this.d.ledger.spent24h(this.now()), freeWei: free, dryRun: this.d.cfg.dryRun });
    const { safety } = await this.d.api<{ safety: Safety }>('GET', `/v1/tokens/${token}/safety`);
    checkSafety(safety);
    const ethUsd = await this.d.ethUsd();
    // A token that graduates between the quote and the build answers curve_graduated: quote it again
    // (now on Uniswap, with its own impact) and build once more.
    let feePaidFirst: FeeOutcome | null = null;
    let attempt = 0;
    let q: QuoteResponse, impact: ImpactSplit | null, b: Built;
    for (;;) {
      ({ q, impact } = await this.quoteWithImpact(token, 'buy', wei));
      if (!q.wouldBuild) throw new GuardError('refused_would_not_build', `the API would refuse this build: ${q.warnings.join('; ') || 'risk or price impact'}`);
      checkImpact(impact!, this.d.cfg);
      try {
        // Never passes acceptRisk or acceptImpact: the API's own refusals (unsafe_token, honeypot, ...) pass straight through.
        const r = await this.build(token, 'buy', wei);
        b = r.b;
        feePaidFirst ??= r.feePaidFirst;
        break;
      } catch (e) {
        if (e instanceof ApiError && e.code === 'curve_graduated' && attempt++ === 0) continue;
        throw e;
      }
    }
    const curveOnChain = isCurve(b.quote) ? await this.d.chain.ponsCurve(token).catch(() => null) : undefined;
    vetBuild(b, 'buy', token, wei, { trader: w.address, curveOnChain });
    // A curve buy pays Rushr's fee on top of the buy: check the caps and balance on the total.
    const fee = b.followUp ? BigInt(b.followUp.amount) : 0n;
    if (fee > 0n) warnings.push(...checkBuyCaps({ usd: usd + weiToUsd(fee, ethUsd), amountWei: wei + fee, maxTradeUsd: this.d.cfg.maxTradeUsd, dailyUsd: this.d.cfg.dailyUsd, spent24hUsd: this.d.ledger.spent24h(this.now()), freeWei: free, dryRun: this.d.cfg.dryRun }));
    const summary = { token, side: 'buy' as const, amountInEth: formatEther(wei), usd: round2(usd), expectedOut: b.quote.amountOut, minOut: b.quote.minAmountOut, feeBps: b.quote.fee.feeBps, impact, venue: b.quote.pool.venue, riskLevel: safety.riskLevel, ...this.curveFeeView(b) };
    if (this.d.cfg.dryRun) return { status: 'dry_run', ...summary, simulation: compactSim(b.simulation), warnings: [...warnings, ...b.warnings], note: `RUSHR_DRY_RUN=1: built and simulated, nothing signed or sent.${b.followUp ? ' Live, the fee transfer would follow the trade.' : ''}` };
    const sent = await this.sendBuilt(b);
    this.d.ledger.record(usd, sent.hash, this.now());
    return this.result(summary, sent, b, feePaidFirst, ethUsd);
  }

  async sell(i: { token: Address } & SellAmount) {
    const token = i.token.toLowerCase() as Address;
    const w = this.wallet();
    this.key();
    const { amount, held } = await this.sellAmount(token, i);
    // Sells are never blocked on impact or risk (llms.txt): getting out must always be possible.
    let r: { b: Built; feePaidFirst: FeeOutcome | null };
    try {
      r = await this.build(token, 'sell', amount);
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'curve_graduated')) throw e;
      r = await this.build(token, 'sell', amount);
    }
    const { b, feePaidFirst } = r;
    const curveOnChain = isCurve(b.quote) ? await this.d.chain.ponsCurve(token).catch(() => null) : undefined;
    vetBuild(b, 'sell', token, amount, { trader: w.address, curveOnChain });
    const summary = { token, side: 'sell' as const, amount: amount.toString(), heldBefore: held.toString(), expectedEthOut: formatEther(BigInt(b.quote.amountOut)), minEthOut: formatEther(BigInt(b.quote.minAmountOut)), feeBps: b.quote.fee.feeBps, impactBps: b.quote.priceImpactBps, venue: b.quote.pool.venue, approvalsNeeded: b.approvals.map((a) => a.kind), ...this.curveFeeView(b) };
    if (this.d.cfg.dryRun) return { status: 'dry_run', ...summary, simulation: compactSim(b.simulation), warnings: b.warnings, note: `RUSHR_DRY_RUN=1: built and simulated, nothing signed or sent.${b.followUp ? ' Live, the fee transfer would follow the trade.' : ''}` };
    const sent = await this.sendBuilt(b);
    return this.result(summary, sent, b, feePaidFirst, await this.d.ethUsd().catch(() => null));
  }

  /** The curve fee as the tools show it (nothing for Uniswap builds, whose fee is inside the swap). */
  private curveFeeView(b: Built) {
    if (!b.followUp) return {};
    return { curveFee: { amountWei: b.followUp.amount, amountEth: formatEther(BigInt(b.followUp.amount)), paidAs: 'a separate transfer to the Rushr treasury, sent after the trade confirms', to: b.followUp.tx.to } };
  }

  /** The tool result after sending: both hashes, and a status that never hides an unpaid fee. */
  private result(summary: Record<string, unknown>, sent: Awaited<ReturnType<Rushr['sendBuilt']>>, b: Built, feePaidFirst: FeeOutcome | null, ethUsd: number | null) {
    if (sent.fee && sent.fee.status !== 'unpaid' && ethUsd) this.d.ledger.record(weiToUsd(BigInt(sent.fee.amountWei), ethUsd), sent.fee.hash, this.now());
    const status = !sent.fee || sent.fee.status === 'paid' ? 'confirmed' : sent.fee.status === 'paid_unreported' ? 'confirmed_fee_unreported' : 'confirmed_fee_unpaid';
    return { status, ...summary, hash: sent.hash, explorer: sent.explorer, approvals: sent.approvals, ...(sent.fee ? { fee: sent.fee } : {}), ...(feePaidFirst ? { overdueFeePaid: feePaidFirst } : {}), warnings: b.warnings };
  }

  /**
   * POST /v1/trade/build (simulated). On 402 `fee_unpaid` (an overdue curve fee blocks builds), pays the
   * overdue transfer when checkFeeUnpaid allows it, reports it, and builds once more. In dry run it
   * refuses instead: paying is a real transaction.
   */
  private async build(token: Address, side: 'buy' | 'sell', amountIn: bigint): Promise<{ b: Built; feePaidFirst: FeeOutcome | null }> {
    const body = { ...this.body(token, side, amountIn), simulate: true };
    try {
      return { b: await this.d.api<Built>('POST', '/v1/trade/build', { body }), feePaidFirst: null };
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'fee_unpaid')) throw e;
      const info = ((e.body as { error?: FeeUnpaid } | null)?.error ?? {}) as FeeUnpaid;
      // A fee this session paid but couldn't report: report it now instead of paying a second time.
      let reported = false;
      for (const h of [...this.unreported]) {
        const ok = await this.d.api('POST', '/v1/agents/me/fees', { body: { txHash: h } }).then(
          () => true,
          (err) => err instanceof ApiError && err.code === 'already_reported',
        );
        if (ok) {
          this.unreported.delete(h);
          reported = true;
        }
      }
      if (reported && !this.unreported.size) return { b: await this.d.api<Built>('POST', '/v1/trade/build', { body }), feePaidFirst: null };
      if (this.unreported.size) throw new GuardError('fee_unpaid', `Builds are blocked by an overdue Rushr fee, and a fee this server already paid (${[...this.unreported].join(', ')}) isn't reported yet. Not paying again; report it with POST /v1/agents/me/fees and retry.`, { unreported: [...this.unreported] });
      if (this.d.cfg.dryRun) throw new GuardError('fee_unpaid', `This wallet owes ${info.owed ?? '?'} wei of overdue Rushr curve fees, so builds are blocked. RUSHR_DRY_RUN=1, so it isn't paid; live, the server pays it (up to 0.005 ETH) and retries.`, { owed: info.owed });
      const ethUsd = await this.d.ethUsd();
      const bal = await this.d.chain.balance(this.wallet().address);
      const free = bal > this.d.cfg.gasReserveWei ? bal - this.d.cfg.gasReserveWei : 0n;
      const owed = checkFeeUnpaid(info, { feeUsd: weiToUsd(BigInt(info.owed ?? '0'), ethUsd), dailyUsd: this.d.cfg.dailyUsd, spent24hUsd: this.d.ledger.spent24h(this.now()), freeWei: free });
      const paid = await this.payFee(info.feeTx!, owed);
      if (paid.status !== 'unpaid') this.d.ledger.record(weiToUsd(owed, ethUsd), paid.hash, this.now());
      if (paid.status !== 'paid') throw new GuardError('fee_unpaid', `Tried to pay the overdue Rushr fee: ${paid.error ?? paid.status}. ${paid.action ?? ''}`.trim(), { fee: paid });
      return { b: await this.d.api<Built>('POST', '/v1/trade/build', { body }), feePaidFirst: paid };
    }
  }

  /**
   * Approvals in order, then the trade, each confirmed before the next. Uniswap builds are refused
   * within 30 s of their deadline; curve builds have none. A curve build's fee transfer follows the
   * confirmed trade (payFee), and its outcome is always returned.
   */
  private async sendBuilt(b: Built) {
    if (b.deadline !== null && this.now() / 1000 > Number(b.deadline) - 30) throw new GuardError('refused_deadline', 'build is too close to its deadline; quote again');
    const approvals: { kind: string; hash: string; explorer: string }[] = [];
    for (const a of b.approvals) {
      const h = await this.d.chain.send(toSend(a.tx));
      await this.d.chain.confirm(h);
      approvals.push({ kind: a.kind, hash: h, explorer: this.explorerTx(h) });
    }
    const hash = await this.d.chain.send(toSend(b.tx));
    await this.d.chain.confirm(hash);
    const fee = b.followUp ? await this.payFee(b.followUp.tx, BigInt(b.followUp.amount)) : null;
    return { hash, explorer: this.explorerTx(hash), approvals, fee };
  }

  /**
   * Sends a fee transfer and reports it (POST /v1/agents/me/fees). Every attempt uses the same nonce, so a
   * retry after an attempt that did go through is rejected by the chain instead of paying twice.
   */
  private async payFee(tx: UnsignedTx, amount: bigint): Promise<FeeOutcome> {
    const base = { amountWei: amount.toString(), amountEth: formatEther(amount) };
    const owe = `Rushr's fee of ${formatEther(amount)} ETH on this curve trade is still owed. From 10 minutes after the trade, builds are refused until it's paid; the next buy or sell pays it automatically (up to 0.005 ETH), or send it to ${tx.to} and report it with POST /v1/agents/me/fees.`;
    const sleep = this.d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    let nonce: number;
    try {
      nonce = await this.d.chain.nonce(this.wallet().address);
    } catch (e) {
      return { status: 'unpaid', ...base, attempts: 0, error: errText(e), action: owe };
    }
    let hash: Hex | null = null;
    let attempts = 0;
    let lastError = '';
    while (attempts < FEE_SEND_ATTEMPTS && !hash) {
      attempts++;
      try {
        const h = await this.d.chain.send({ ...toSend(tx), value: amount, nonce });
        await this.d.chain.confirm(h);
        hash = h;
      } catch (e) {
        lastError = errText(e);
        // A transfer that was mined and reverted used the nonce: the next try needs a new one.
        if (e instanceof GuardError && e.code === 'tx_reverted') nonce = await this.d.chain.nonce(this.wallet().address).catch(() => nonce);
        // The nonce is taken: an earlier attempt may have gone through. Don't send again; my_status shows what's owed.
        else if (/nonce too low|already known|replacement/i.test(lastError)) return { status: 'unpaid', ...base, attempts, error: lastError, action: `An earlier attempt may have gone through. Check my_status (fees) before paying again. ${owe}` };
        if (attempts < FEE_SEND_ATTEMPTS) await sleep(3_000 * attempts);
      }
    }
    if (!hash) return { status: 'unpaid', ...base, attempts, error: lastError, action: owe };
    const sent = { ...base, hash, explorer: this.explorerTx(hash), attempts };
    for (let r = 0; r < FEE_REPORT_ATTEMPTS; r++) {
      try {
        await this.d.api('POST', '/v1/agents/me/fees', { body: { txHash: hash } });
        return { status: 'paid', ...sent };
      } catch (e) {
        if (e instanceof ApiError && e.code === 'already_reported') return { status: 'paid', ...sent };
        lastError = errText(e);
        if (!(e instanceof ApiError && (e.code === 'tx_not_found' || e.code === 'rate_limited' || e.status >= 500))) break;
        await sleep(5_000);
      }
    }
    this.unreported.add(hash);
    return { status: 'paid_unreported', ...sent, error: lastError, action: `The fee was paid (${hash}) but not reported yet. Report it with POST /v1/agents/me/fees { "txHash": "${hash}" }, or the next build will ask for it again.` };
  }

  // ------------------------------------------------------------------ social

  async postCallout(i: { token: Address; stance: 'bullish' | 'bearish'; body: string }) {
    const token = i.token.toLowerCase() as Address;
    this.key();
    const [detail, held] = await Promise.all([this.d.api<{ symbol?: string }>('GET', `/tokens/${token}`, { auth: false }).catch(() => ({ symbol: undefined })), this.d.chain.tokenBalance(token, this.wallet().address).catch(() => 0n)]);
    const symbol = detail.symbol ?? token.slice(0, 8);
    const body = withDisclosure(i.body, symbol, held > 0n);
    if (body.length > 500) throw new GuardError('invalid_body', `callout is ${body.length} characters with the disclosure; the limit is 500. Shorten it by ${body.length - 500}.`);
    if (this.d.cfg.dryRun) return { status: 'dry_run', token, stance: i.stance, body, note: 'RUSHR_DRY_RUN=1: not posted.' };
    const r = await this.d.api<{ callout: { id: string } }>('POST', '/v1/callouts', { body: { token, stance: i.stance, body } });
    return { status: 'posted', id: r.callout.id, token, stance: i.stance, body };
  }

  async deleteCallout(id: string) {
    this.key();
    if (this.d.cfg.dryRun) return { status: 'dry_run', id, note: 'RUSHR_DRY_RUN=1: not deleted.' };
    await this.d.api('DELETE', `/v1/callouts/${encodeURIComponent(id)}`);
    return { status: 'deleted', id };
  }

  // ------------------------------------------------------------------ reads (no wallet needed)

  async scan(i: { column: 'new' | 'almost' | 'migrated'; limit: number }) {
    const r = await this.d.api<{ tokens: { address: string; symbol: string; name?: string; status?: string; launchpad?: string | null; price_usd?: number | null; market_cap_usd?: number | null; liquidity_usd?: number | null; volume_24h_usd?: number | null; holders?: number | null; risk?: string | null; buy_tax_bps?: number | null; sell_tax_bps?: number | null }[] }>('GET', `/tokens`, { auth: false, query: { column: i.column } });
    return {
      column: i.column,
      tokens: r.tokens.slice(0, i.limit).map((t) => ({ address: t.address, symbol: t.symbol, tradeVia: tradeVia(t.status, t.launchpad), priceUsd: t.price_usd ?? null, mcapUsd: t.market_cap_usd ?? null, liquidityUsd: t.liquidity_usd ?? null, vol24hUsd: t.volume_24h_usd ?? null, holders: t.holders ?? null, risk: t.risk ?? null, buyTaxBps: t.buy_tax_bps ?? null, sellTaxBps: t.sell_tax_bps ?? null })),
    };
  }

  async token(address: Address) {
    const a = address.toLowerCase();
    const [detail, safety] = await Promise.all([this.d.api<Record<string, unknown>>('GET', `/tokens/${a}`, { auth: false }), this.d.api<{ safety: Safety }>('GET', `/v1/tokens/${a}/safety`).then((r) => r.safety).catch((e) => ({ error: errText(e) }))]);
    const pick = (k: string) => detail[k] ?? null;
    return {
      address: a,
      symbol: pick('symbol'),
      name: pick('name'),
      status: pick('status'),
      launchpad: pick('launchpad'),
      tradeVia: tradeVia(detail.status as string | undefined, detail.launchpad as string | undefined),
      priceUsd: pick('price_usd'),
      mcapUsd: pick('market_cap_usd'),
      liquidityUsd: pick('liquidity_usd'),
      vol24hUsd: pick('volume_24h_usd'),
      holders: pick('holders'),
      buyTaxBps: pick('buy_tax_bps'),
      sellTaxBps: pick('sell_tax_bps'),
      state: pick('state'),
      safety,
    };
  }

  async leaderboard(i: { window: 'season' | '24h' | '7d' | '30d'; kind: 'all' | 'human' | 'agent'; limit: number }) {
    const r = await this.d.api<{ season?: { id: string; name: string; endsAt: string }; updatedAt?: string; rows: { rank: number; member: { handle: string; kind: string }; pnl?: number; roi?: number; volumeUsd?: number; trades?: number; tokens?: number }[] }>('GET', '/v1/leaderboard', { auth: false, query: { window: i.window, kind: i.kind, limit: i.limit } });
    return {
      window: i.window,
      kind: i.kind,
      season: r.season ? { id: r.season.id, name: r.season.name, endsAt: r.season.endsAt } : null,
      updatedAt: r.updatedAt ?? null,
      rows: r.rows.map((row) => ({ rank: row.rank, handle: row.member.handle, kind: row.member.kind, pnlUsd: row.pnl ?? null, roi: row.roi ?? null, volumeUsd: row.volumeUsd ?? null, trades: row.trades ?? null, tokens: row.tokens ?? null })),
    };
  }

  async feed(i: { scope: 'global' | 'following'; limit: number; before?: string; token?: Address; handle?: string }) {
    const path = i.token ? `/v1/tokens/${i.token.toLowerCase()}/callouts` : i.handle ? `/v1/members/${i.handle}/callouts` : i.scope === 'following' ? '/v1/me/feed' : '/v1/feed';
    if (path === '/v1/me/feed') this.key();
    const r = await this.d.api<{ items: { id: string; createdAt: string; author: { handle: string; kind: string }; token?: { symbol?: string; address: string }; stance: string; body: string; [k: string]: unknown }[]; next?: string | null }>('GET', path, { query: { limit: i.limit, before: i.before } });
    return {
      items: r.items.map((c) => ({ id: c.id, at: c.createdAt, author: c.author.handle, authorKind: c.author.kind, token: c.token ? { symbol: c.token.symbol ?? null, address: c.token.address } : null, stance: c.stance, body: c.body })),
      next: r.next ?? null,
    };
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Where an agent can trade a token: graduated tokens on Uniswap, PONS tokens still on their bonding
 * curve on the curve (Rushr's fee then follows as a separate transfer). Other launchpads' pre-graduation
 * tokens aren't tradable through the API (null).
 */
export function tradeVia(status: string | null | undefined, launchpad: string | null | undefined): 'uniswap' | 'pons-curve' | null {
  if (status === 'migrated') return 'uniswap';
  if (launchpad === 'pons') return 'pons-curve';
  return null;
}

const toSend = (tx: UnsignedTx): SendTx => ({ to: tx.to, data: tx.data || '0x', value: BigInt(tx.value), gas: tx.gas ? BigInt(tx.gas) : undefined });
const num2 = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? round2(v) : null);

interface Holding {
  token: string;
  symbol: string;
  amount_ui: number;
  value_usd: number | null;
  cost_basis_usd: number | null;
  unrealized_usd: number | null;
  realized_usd: number | null;
}

/** The simulation without its raw logs: whether it passed, gas, and what it says was received. */
function compactSim(s: Built['simulation']) {
  if (!s) return null;
  const x = s as Built['simulation'] & { calls?: { label?: string; ok?: boolean; gasUsed?: string }[] };
  return { ok: x!.ok, error: x!.error ?? undefined, received: x!.received ?? null, feePaid: x!.feePaid ?? null, calls: x!.calls?.map((c) => ({ label: c.label, ok: c.ok, gasUsed: c.gasUsed })) };
}

export function errText(e: unknown): string {
  if (e instanceof ApiError || e instanceof GuardError) return `${e.code}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

