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
  /** Wallets that hold the token, excluding pools, the PoolManager, curves and burn addresses. */
  holders: SnapshotHolder[];
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
  /** Earlier tokens (last 7 days) with the same symbol, by other contracts (spam clones excluded). */
  sameSymbolEarlier: number;
  /** Launchpad id, or 'uniswap-v4' for a plain pool (no launchpad). */
  launchpad: string | null;
  now: number;
}

export interface Reason {
  level: 'high' | 'medium' | 'info';
  text: string;
}

export interface TokenSignals {
  holders: number;
  top10Pct: number;
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
    bestAthMarketCapUsd: number | null;
  };
  copycat: boolean;
  sameSymbolEarlier: number;
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
  /** Plain-pool tokens with at least this many airdropped holders are treated as spam clones. */
  spamAirdroppedHolders: 20,
};

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
    serialLauncher: launches7d >= THRESHOLDS.serialLaunches7d,
    bestAthMarketCapUsd: athValues.length ? Math.max(...athValues) : null,
  };

  const signals: Omit<TokenSignals, 'risk' | 'verdict' | 'reasons'> = {
    holders: s.holderCount,
    top10Pct: round1(pct(top10, s.totalSupply)),
    devPct: round1(pct(devHeld, s.totalSupply)),
    snipersPct: s.launchIndexed ? round1(pct(sniperBought, s.totalSupply)) : null,
    sniperCount: s.launchIndexed ? new Set(snipers.map((b) => b.trader)).size : null,
    bundledPct: s.launchIndexed ? round1(pct(bundled, s.totalSupply)) : null,
    bundledStillHeldPct: s.launchIndexed ? round1(pct(sumHeld(bundle.map((b) => b.trader)), s.totalSupply)) : null,
    insidersPct: round1(pct(sumHeld(insiders), s.totalSupply)),
    freshWalletsPct: s.holders.length ? round1((fresh.length / s.holders.length) * 100) : 0,
    airdroppedHolders: s.airdropped.length,
    dev,
    copycat: s.sameSymbolEarlier > 0,
    sameSymbolEarlier: s.sameSymbolEarlier,
    spam: isPlainPool(s.launchpad) && s.airdropped.length >= THRESHOLDS.spamAirdroppedHolders,
  };
  return { ...signals, ...judge(signals, s) };
}

function judge(
  x: Omit<TokenSignals, 'risk' | 'verdict' | 'reasons'>,
  s: TokenSnapshot,
): Pick<TokenSignals, 'risk' | 'verdict' | 'reasons'> {
  const reasons: Reason[] = [];
  const add = (level: Reason['level'], text: string) => reasons.push({ level, text });

  if (x.copycat) add('high', `copycat: ${x.sameSymbolEarlier} earlier $${s.symbol} token${x.sameSymbolEarlier > 1 ? 's' : ''} this week`);
  if (x.dev.serialLauncher) add('high', `dev launched ${x.dev.launches7d} tokens this week`);
  if (x.dev.rugs >= 2) add('high', `dev's past tokens: ${x.dev.rugs} of ${x.dev.launches} rugged`);
  else if (x.dev.rugs === 1) add('medium', `dev has 1 rugged token`);
  if (x.bundledStillHeldPct !== null && x.bundledStillHeldPct >= 20) add('high', `${x.bundledStillHeldPct}% still held by the launch bundle`);
  else if (x.bundledPct !== null && x.bundledPct >= 10) add('medium', `${x.bundledPct}% bought in the launch bundle`);
  if (x.insidersPct >= 15) add('high', `insiders hold ${x.insidersPct}%`);
  else if (x.insidersPct >= 5) add('medium', `insiders hold ${x.insidersPct}%`);
  if (x.airdroppedHolders >= 20) add('high', `${x.airdroppedHolders} holders were airdropped (fake holder count)`);
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
