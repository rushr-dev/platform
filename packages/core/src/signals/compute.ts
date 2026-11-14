import type { RiskLevel } from '../types';

/**
 * Safety signals for one token, computed from an indexed snapshot. Pure and deterministic so it
 * can be unit-tested and recomputed any time. All percentages are of total supply, 0–100.
 */

export interface SnapshotHolder {
  wallet: string;
  amount: bigint;
}

export interface SnapshotBuy {
  trader: string;
  block: bigint;
  time: number; // unix seconds
  tokenAmount: bigint;
}

export interface SnapshotWallet {
  firstFunder: string | null;
  /** First time the wallet received ETH (≈ when it was created). */
  firstSeen: number | null;
}

export interface DevToken {
  address: string;
  createdAt: number;
  athMarketCapUsd: number | null;
  marketCapUsd: number | null;
  migrated: boolean;
}

export interface TokenSnapshot {
  address: string;
  symbol: string;
  totalSupply: bigint;
  deployer: string;
  createdAt: number;
  createdBlock: bigint;
  /**
   * People holding the token, largest first: pools, the PoolManager, curves, hooks, burn addresses, the
   * token itself and contracts (code over 23 bytes) are left out. EIP-7702 delegated EOAs stay in.
   */
  holders: SnapshotHolder[];
  /** Held by burn addresses (out of circulation). Optional. */
  burnt?: bigint;
  holderCount: number;
  /** Buys in the first minute, oldest first. */
  earlyBuys: SnapshotBuy[];
  /** False when the token's first trades weren't indexed: bundle/sniper signals are then unknown. */
  launchIndexed: boolean;
  /** Funding info for the deployer, top holders and early buyers. */
  wallets: Record<string, SnapshotWallet>;
  /** Wallets that received the token in airdrop-style transfers (one tx sending to many, no swap). */
  airdropped: string[];
  /** Tokens launched by the deployer or wallets sharing its funder (excluding this token). */
  devTokens: DevToken[];
  /**
   * Organic holders (holders minus airdropped) of the strongest other token with the same ticker
   * (spam excluded), or 0 if there is none. Launch order doesn't matter: scammers often squat a
   * ticker before the real launch, so the "original" is whichever one has the real community.
   */
  twinOrganicHolders: number;
  /** Launchpad id, or 'uniswap-v4' for a plain pool (no launchpad). */
  launchpad: string | null;
  now: number;
  /**
   * Early single-swap trades with the trader's net token flow in the same tx, to measure transfer
   * tax: buys where the pool sent `swapAmount` and the trader ended up with `traderNet`, sells where
   * the trader gave up `-traderNet` and the pool got `swapAmount`. Optional (older callers).
   */
  taxSamples?: { side: 'buy' | 'sell'; swapAmount: bigint; traderNet: bigint }[];
  /**
   * Tax the token's contract charges, when it can be read (PONS curves and their v4 hook: the creator tax
   * on both sides, plus the launchpad's own fee). Wins over the measured tax. Optional.
   */
  contractTax?: { buyBps: number; sellBps: number; venueFeeBps: number } | null;
  /** Buys and sells so far (honeypot check). Optional. */
  tradeCounts?: { buys: number; sells: number };
  /**
   * Different deployers that launched a token with this exact name and symbol in the 24h *before* this one
   * (a farm's earlier copies). Later copies don't count: the original isn't blamed for its copycats.
   */
  sameNameDeployers24h?: number;
}

export interface Reason {
  level: 'high' | 'medium' | 'info';
  text: string;
}

export interface TokenSignals {
  holders: number;
  /** Top 10 people (pools, burns and contracts excluded), % of total supply. */
  top10Pct: number;
  /** % of total supply held by burn addresses. */
  burntPct?: number;
  devPct: number;
  /** null = not measured (launch trades not indexed). */
  snipersPct: number | null;
  sniperCount: number | null;
  bundledPct: number | null;
  bundledStillHeldPct: number | null;
  insidersPct: number;
  freshWalletsPct: number;
  airdroppedHolders: number;
  dev: {
    launches: number;
    launches7d: number;
    rugs: number;
    migrated: number;
    serialLauncher: boolean;
    /** Same name and symbol relaunched by several fresh wallets within a day (a launch farm). */
    farm?: boolean;
    bestAthMarketCapUsd: number | null;
  };
  /**
   * Buy/sell tax in bps: from the contract when known (PONS creator tax), else measured from real
   * trades (null = not enough trades yet).
   */
  buyTaxBps?: number | null;
  sellTaxBps?: number | null;
  /** Where the tax comes from; null when neither is known. */
  taxSource?: 'contract' | 'measured' | null;
  /** The launchpad's own trading fee (PONS protocol fee), not a tax. null when unknown. */
  venueFeeBps?: number | null;
  /** Many buys, no sell at all: possibly can't be sold. */
  noSells?: boolean;
  copycat: boolean;
  /** Organic holders of the stronger same-ticker token this one copies (0 when not a copycat). */
  twinOrganicHolders: number;
  /**
   * Airdrop-farm spam: a plain pool (no launchpad) whose holder count was padded by mass airdrops.
   * The copycat factories on Robinhood Chain deploy dozens of these per hit token. Hidden by default.
   */
  spam: boolean;
  risk: RiskLevel;
  verdict: string;
  reasons: Reason[];
}

export const THRESHOLDS = {
  sniperWindowSeconds: 5,
  /** Blocks after creation that count as the launch bundle (≈0.3s at 0.11s blocks). */
  bundleBlocks: 3n,
  freshWalletSeconds: 24 * 3600,
  serialLaunches7d: 5,
  rugDrawdown: 0.9,
  /**
   * Airdrops pad holder counts, but real tokens get airdropped too (marketing, dusting). What matters
   * is the share: at least this many airdropped holders...
   */
  spamAirdroppedHolders: 20,
  /** ...making up at least this share of all holders means the count is fake (spam, if a plain pool). */
  airdropShareFake: 0.5,
  /** ...or at least this share: worth a warning, not a verdict. */
  airdropShareNotable: 0.2,
  /** Copycat: a same-ticker token with at least this many organic holders... */
  copycatTwinMinHolders: 50,
  /** ...and at least this many times this token's organic holders. */
  copycatTwinRatio: 3,
  /** Same name+symbol launched by at least this many different deployers in 24h: a farm. */
  farmDeployers24h: 3,
  /** Trades of each side needed before a tax is reported. */
  taxMinSamples: 2,
  /** Buys with zero sells, after this long, read as possibly unsellable. */
  noSellsMinBuys: 20,
  noSellsMinAgeSeconds: 600,
};

/**
 * Transfer tax in bps from observed trades (median of samples; null below the minimum). A buy's tax is
 * the share of what the pool sent that didn't reach the trader; a sell's, the share of what the trader
 * gave that didn't reach the pool. Samples outside [0, 100%] (other transfers in the tx) are ignored.
 */
export function measureTax(samples: TokenSnapshot['taxSamples'] = []): { buyTaxBps: number | null; sellTaxBps: number | null } {
  const median = (xs: number[]) => {
    if (xs.length < THRESHOLDS.taxMinSamples) return null;
    const sorted = [...xs].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)]!;
  };
  const bps = (num: bigint, den: bigint) => (den > 0n ? Number(((den - num) * 10_000n) / den) : -1);
  const buys: number[] = [];
  const sells: number[] = [];
  for (const x of samples) {
    if (x.side === 'buy' && x.traderNet > 0n) {
      const t = bps(x.traderNet, x.swapAmount);
      if (t >= 0 && t <= 10_000) buys.push(t);
    } else if (x.side === 'sell' && x.traderNet < 0n) {
      const t = bps(x.swapAmount, -x.traderNet);
      if (t >= 0 && t <= 10_000) sells.push(t);
    }
  }
  // Rounding dust (a few wei) isn't tax.
  const clean = (v: number | null) => (v === null ? null : v < 5 ? 0 : v);
  return { buyTaxBps: clean(median(buys)), sellTaxBps: clean(median(sells)) };
}

/**
 * A copy in a launch farm: at least `farmDeployers24h` other wallets launched this exact name+symbol in the
 * day before it, and it doesn't lead its ticker by organic holders (tickers get squatted before the real
 * launch, so the token people actually hold is the original, whatever its launch order). Ties count as copies.
 */
function isFarmCopy(s: TokenSnapshot) {
  if ((s.sameNameDeployers24h ?? 0) < THRESHOLDS.farmDeployers24h) return false;
  const own = Math.max(0, s.holderCount - s.airdropped.length);
  return own <= s.twinOrganicHolders;
}

/** Another token with this ticker has a far bigger organic community: this one rides its name. */
function isCopycat(s: TokenSnapshot) {
  const own = Math.max(0, s.holderCount - s.airdropped.length);
  return s.twinOrganicHolders >= Math.max(THRESHOLDS.copycatTwinMinHolders, own * THRESHOLDS.copycatTwinRatio);
}

/** Share of holders that were airdropped (0 below the minimum count, so a handful never matters). */
function airdropShare(s: TokenSnapshot) {
  if (s.airdropped.length < THRESHOLDS.spamAirdroppedHolders) return 0;
  return s.airdropped.length / Math.max(s.holderCount, s.airdropped.length);
}

const isPlainPool = (launchpad: string | null) => !launchpad || launchpad === 'uniswap-v4';

const pct = (part: bigint, total: bigint) => (total === 0n ? 0 : Number((part * 1_000_000n) / total) / 10_000);
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Which wallets are snipers, launch-bundle buyers, insiders or fresh. Shared by signals and holder tags. */
export function classifyWallets(s: TokenSnapshot) {
  // Snipers: bought within the first few seconds, excluding the dev.
  const snipers = s.earlyBuys.filter(
    (b) => b.time - s.createdAt <= THRESHOLDS.sniperWindowSeconds && b.trader !== s.deployer,
  );
  // Bundle: buys in the creation block range, plus any early buyer sharing a funder with them or the dev.
  const devFunder = s.wallets[s.deployer]?.firstFunder ?? null;
  const bundleCore = s.earlyBuys.filter((b) => b.block - s.createdBlock <= THRESHOLDS.bundleBlocks);
  const bundleFunders = new Set(
    [devFunder, ...bundleCore.map((b) => s.wallets[b.trader]?.firstFunder)].filter((f): f is string => !!f),
  );
  const bundle = s.earlyBuys.filter((b) => {
    const f = s.wallets[b.trader]?.firstFunder;
    return bundleCore.includes(b) || (!!f && bundleFunders.has(f));
  });
  // Insiders: holders funded by the dev or by the dev's funder.
  const insiders = s.holders
    .map((h) => h.wallet)
    .filter((w) => {
      if (w === s.deployer) return false;
      const f = s.wallets[w]?.firstFunder;
      return !!f && (f === s.deployer || (devFunder !== null && f === devFunder));
    });
  // Fresh wallets: first funded within 24h before (or after) launch.
  const fresh = s.holders
    .map((h) => h.wallet)
    .filter((w) => {
      const seen = s.wallets[w]?.firstSeen;
      return seen != null && seen >= s.createdAt - THRESHOLDS.freshWalletSeconds;
    });
  return { snipers, bundle, insiders, fresh, devFunder };
}

export type HolderTag = 'dev' | 'sniper' | 'bundler' | 'insider' | 'fresh' | 'airdrop';

/** Tags per wallet for the holders table and bubble map. */
export function tagHolders(s: TokenSnapshot): Record<string, HolderTag[]> {
  const { snipers, bundle, insiders, fresh } = classifyWallets(s);
  const tags: Record<string, HolderTag[]> = {};
  const add = (w: string, t: HolderTag) => {
    const list = (tags[w] ??= []);
    if (!list.includes(t)) list.push(t);
  };
  add(s.deployer, 'dev');
  if (s.launchIndexed) {
    for (const b of snipers) add(b.trader, 'sniper');
    for (const b of bundle) add(b.trader, 'bundler');
  }
  for (const w of insiders) add(w, 'insider');
  for (const w of fresh) add(w, 'fresh');
  for (const w of s.airdropped) add(w, 'airdrop');
  return tags;
}

export function computeSignals(s: TokenSnapshot): TokenSignals {
  const balance = new Map(s.holders.map((h) => [h.wallet, h.amount]));
  const sumHeld = (wallets: Iterable<string>) => {
    let total = 0n;
    for (const w of new Set(wallets)) total += balance.get(w) ?? 0n;
    return total;
  };

  const sorted = [...s.holders].sort((a, b) => (a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0));
  const top10 = sorted.slice(0, 10).reduce((t, h) => t + h.amount, 0n);
  const devHeld = balance.get(s.deployer) ?? 0n;

  const { snipers, bundle, insiders, fresh } = classifyWallets(s);
  const sniperBought = snipers.reduce((t, b) => t + b.tokenAmount, 0n);
  const bundled = bundle.reduce((t, b) => t + b.tokenAmount, 0n);

  // Dev record across the deployer's funding cluster.
  const weekAgo = s.now - 7 * 24 * 3600;
  const rugs = s.devTokens.filter(
    (t) =>
      !t.migrated &&
      t.athMarketCapUsd != null &&
      t.athMarketCapUsd > 0 &&
      (t.marketCapUsd ?? 0) <= t.athMarketCapUsd * (1 - THRESHOLDS.rugDrawdown),
  ).length;
  const launches7d = s.devTokens.filter((t) => t.createdAt >= weekAgo).length;
  const athValues = s.devTokens.map((t) => t.athMarketCapUsd ?? 0).filter((v) => v > 0);
  const dev = {
    launches: s.devTokens.length,
    launches7d,
    rugs,
    migrated: s.devTokens.filter((t) => t.migrated).length,
    // Serial dev: this deployer (or its funding cluster) launched many tokens this week. Nothing else.
    serialLauncher: launches7d >= THRESHOLDS.serialLaunches7d,
    farm: isFarmCopy(s),
    bestAthMarketCapUsd: athValues.length ? Math.max(...athValues) : null,
  };
  const measured = measureTax(s.taxSamples);
  // A contract tax is the truth; a measured 0 (tax taken in the quote, invisible to transfers) never overrides it.
  const ct = s.contractTax ?? null;
  const tax = ct ? { buyTaxBps: ct.buyBps, sellTaxBps: ct.sellBps } : measured;
  const taxSource = ct ? 'contract' : measured.buyTaxBps != null || measured.sellTaxBps != null ? 'measured' : null;
  const noSells =
    !!s.tradeCounts && s.tradeCounts.buys >= THRESHOLDS.noSellsMinBuys && s.tradeCounts.sells === 0 &&
    s.now - s.createdAt >= THRESHOLDS.noSellsMinAgeSeconds;

  const signals: Omit<TokenSignals, 'risk' | 'verdict' | 'reasons'> = {
    holders: s.holderCount,
    top10Pct: round1(pct(top10, s.totalSupply)),
    burntPct: round1(pct(s.burnt ?? 0n, s.totalSupply)),
    devPct: round1(pct(devHeld, s.totalSupply)),
    snipersPct: s.launchIndexed ? round1(pct(sniperBought, s.totalSupply)) : null,
    sniperCount: s.launchIndexed ? new Set(snipers.map((b) => b.trader)).size : null,
    bundledPct: s.launchIndexed ? round1(pct(bundled, s.totalSupply)) : null,
    bundledStillHeldPct: s.launchIndexed ? round1(pct(sumHeld(bundle.map((b) => b.trader)), s.totalSupply)) : null,
    insidersPct: round1(pct(sumHeld(insiders), s.totalSupply)),
    freshWalletsPct: s.holders.length ? round1((fresh.length / s.holders.length) * 100) : 0,
    airdroppedHolders: s.airdropped.length,
    dev,
    buyTaxBps: tax.buyTaxBps,
    sellTaxBps: tax.sellTaxBps,
    taxSource,
    venueFeeBps: ct?.venueFeeBps ?? null,
    noSells,
    copycat: isCopycat(s),
    twinOrganicHolders: isCopycat(s) ? s.twinOrganicHolders : 0,
    spam: isPlainPool(s.launchpad) && airdropShare(s) >= THRESHOLDS.airdropShareFake,
  };
  return { ...signals, ...judge(signals, s) };
}

function judge(
  x: Omit<TokenSignals, 'risk' | 'verdict' | 'reasons'>,
  s: TokenSnapshot,
): Pick<TokenSignals, 'risk' | 'verdict' | 'reasons'> {
  const reasons: Reason[] = [];
  const add = (level: Reason['level'], text: string) => reasons.push({ level, text });

  if (x.copycat) add('high', `copycat: another $${s.symbol} has ${x.twinOrganicHolders} real holders`);
  if (x.dev.farm) add('high', `launch farm copy: ${s.sameNameDeployers24h} other wallets launched $${s.symbol} in the 24h before it`);
  if (x.dev.serialLauncher) add('high', `dev launched ${x.dev.launches7d} tokens this week`);
  if (x.noSells) add('high', `${s.tradeCounts!.buys} buys and no sells: may not be sellable`);
  if (x.sellTaxBps != null && x.sellTaxBps >= 5_000) add('high', `sell tax ${x.sellTaxBps / 100}%`);
  else if (x.sellTaxBps != null && x.sellTaxBps >= 1_000) add('medium', `sell tax ${x.sellTaxBps / 100}%`);
  if (x.buyTaxBps != null && x.buyTaxBps >= 1_000) add('medium', `buy tax ${x.buyTaxBps / 100}%`);
  if (x.dev.rugs >= 2) add('high', `dev's past tokens: ${x.dev.rugs} of ${x.dev.launches} rugged`);
  else if (x.dev.rugs === 1) add('medium', `dev has 1 rugged token`);
  if (x.bundledStillHeldPct !== null && x.bundledStillHeldPct >= 20) add('high', `${x.bundledStillHeldPct}% still held by the launch bundle`);
  else if (x.bundledPct !== null && x.bundledPct >= 10) add('medium', `${x.bundledPct}% bought in the launch bundle`);
  if (x.insidersPct >= 15) add('high', `insiders hold ${x.insidersPct}%`);
  else if (x.insidersPct >= 5) add('medium', `insiders hold ${x.insidersPct}%`);
  const share = airdropShare(s);
  if (share >= THRESHOLDS.airdropShareFake) {
    add('high', `${x.airdroppedHolders} of ${s.holderCount} holders were airdropped (fake holder count)`);
  } else if (share >= THRESHOLDS.airdropShareNotable) {
    add('medium', `${Math.round(share * 100)}% of holders were airdropped`);
  }
  if (x.top10Pct >= 50) add('high', `top 10 wallets hold ${x.top10Pct}%`);
  else if (x.top10Pct >= 30) add('medium', `top 10 wallets hold ${x.top10Pct}%`);
  if (x.devPct >= 10) add('medium', `dev still holds ${x.devPct}%`);
  if (x.snipersPct !== null && x.snipersPct >= 15) add('medium', `snipers bought ${x.snipersPct}% in the first seconds`);
  if (x.bundledPct === null) add('info', 'launch trades not indexed: bundle and sniper not measured');
  if (x.freshWalletsPct >= 50 && x.holders >= 10) add('medium', `${x.freshWalletsPct}% of top holders are fresh wallets`);
  if (x.dev.migrated > 0) add('info', `dev has ${x.dev.migrated} graduated token${x.dev.migrated > 1 ? 's' : ''}`);

  const highs = reasons.filter((r) => r.level === 'high');
  const mediums = reasons.filter((r) => r.level === 'medium');
  const risk: RiskLevel = highs.length ? 'high' : mediums.length ? 'medium' : 'low';
  const top = [...highs, ...mediums].slice(0, 3).map((r) => r.text);
  const verdict =
    risk === 'low'
      ? 'Low risk: no red flags found in holders, bundles or dev history'
      : `${risk === 'high' ? 'High' : 'Medium'} risk: ${top.join(', ')}`;
  return { risk, verdict, reasons };
}
