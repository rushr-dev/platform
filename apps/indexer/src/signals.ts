import type { Sql } from 'postgres';
import type { Address } from 'viem';
import { INFRA_ADDRESSES, computeSignals, type TokenSignals, type TokenSnapshot } from '@rushr/core';
import type { Rpc } from './rpc';

/** How many wallets per token get a funding lookup (each costs one Alchemy call, cached forever). */
const FUND_TOP_HOLDERS = 20;
const FUND_EARLY_BUYERS = 20;
/** A funder that funded this many known wallets is an exchange/bridge, not a cluster signal. */
const COMMON_FUNDER_MIN = 50;

const EXCLUDED = INFRA_ADDRESSES.map((a) => a.toLowerCase());

/** Compute and store a token's signals (topping up wallet funding info first). */
export async function recomputeSignals(sql: Sql, rpc: Rpc, token: string): Promise<TokenSignals | null> {
  const loaded = await loadSnapshot(sql, token, rpc);
  if (!loaded) return null;
  const { snapshot, devFunder } = loaded;
  const signals = computeSignals(snapshot);
  await saveSignals(sql, snapshot, signals, devFunder);
  return signals;
}

/**
 * Build a token's snapshot from Postgres. With `rpc`, missing wallet funding is looked up first;
 * without it (API reads), only cached funding is used.
 */
export async function loadSnapshot(
  sql: Sql,
  token: string,
  rpc: Rpc | null,
): Promise<{ snapshot: TokenSnapshot; devFunder: string | null } | null> {
  const [t] = await sql<
    { address: string; symbol: string; total_supply: string; deployer: string; created_at: Date; created_block: string; main_pool: string | null; launch_indexed: boolean; launchpad: string | null; holders: number }[]
  >`select address, symbol, total_supply, deployer, created_at, created_block, main_pool, launch_indexed, launchpad, holders from tokens where address = ${token}`;
  if (!t) return null;
  const createdAt = Math.floor(t.created_at.getTime() / 1000);
  const excluded = [...EXCLUDED, ...(t.main_pool && t.main_pool.length === 42 ? [t.main_pool] : [])];

  const holders = await sql<{ wallet: string; amount: string }[]>`
    select wallet, amount from balances
    where token = ${token} and amount > 0 and wallet <> all(${excluded})
    order by amount desc limit 100`;
  const [{ count: holderCount } = { count: 0 }] = await sql<{ count: number }[]>`
    select count(*)::int as count from balances where token = ${token} and amount > 0 and wallet <> all(${excluded})`;
  const earlyBuys = await sql<{ trader: string; block: string; time: Date; token_amount: string }[]>`
    select trader, block, time, token_amount from swaps
    where token = ${token} and side = 'buy' and time <= ${t.created_at}::timestamptz + interval '60 seconds'
    order by block, log_index limit 200`;

  // Funding info for the dev, top holders and early buyers (fetch only what we haven't looked up).
  const want = [
    t.deployer,
    ...holders.slice(0, FUND_TOP_HOLDERS).map((h) => h.wallet),
    ...[...new Set(earlyBuys.map((b) => b.trader))].slice(0, FUND_EARLY_BUYERS),
  ];
  if (rpc) await ensureFunding(sql, rpc, [...new Set(want)]);
  const walletRows = await sql<{ address: string; first_funder: string | null; funded_at: Date | null }[]>`
    select address, first_funder, funded_at from wallets
    where address = any(${[...new Set([...want, ...holders.map((h) => h.wallet)])]})`;
  const funders = [...new Set(walletRows.map((w) => w.first_funder).filter((f): f is string => !!f))];
  const common = new Set(
    (
      await sql<{ first_funder: string }[]>`
        select first_funder from wallets where first_funder = any(${funders})
        group by first_funder having count(*) >= ${COMMON_FUNDER_MIN}`
    ).map((r) => r.first_funder),
  );
  const wallets: TokenSnapshot['wallets'] = {};
  for (const w of walletRows) {
    wallets[w.address] = {
      firstFunder: w.first_funder && !common.has(w.first_funder) ? w.first_funder : null,
      firstSeen: w.funded_at ? Math.floor(w.funded_at.getTime() / 1000) : null,
    };
  }

  // Airdrop-style transfers: one tx sending this token to 10+ wallets with no swap in it.
  const airdropped = await sql<{ to: string }[]>`
    select distinct tr.to from transfers tr
    where tr.token = ${token}
      and tr.tx in (select tx from transfers where token = ${token} group by tx having count(*) >= 10)
      and not exists (select 1 from swaps s where s.tx = tr.tx and s.token = ${token})`;

  // Dev record: tokens by the deployer, or by wallets sharing its (non-exchange) funder.
  const devFunder = wallets[t.deployer]?.firstFunder ?? null;
  const devTokens = await sql<
    { address: string; created_at: Date; ath_market_cap_usd: string | null; market_cap_usd: string | null; status: string }[]
  >`
    select address, created_at, ath_market_cap_usd, market_cap_usd, status from tokens
    where address <> ${token}
      and (deployer = ${t.deployer}
           or (${devFunder}::text is not null and deployer in (select address from wallets where first_funder = ${devFunder})))
    order by created_at desc limit 500`;

  // The strongest other token with this ticker, by organic holders (holders minus airdropped).
  // Spam excluded. Launch order is ignored: tickers are often squatted before the real launch.
  const [{ organic: twinOrganicHolders } = { organic: 0 }] = await sql<{ organic: number }[]>`
    select greatest(0, o.holders - coalesce((s.data->>'airdroppedHolders')::int, 0))::int as organic
    from tokens o left join signals s on s.token = o.address
    where lower(o.symbol) = lower(${t.symbol}) and o.address <> ${token}
      and not coalesce((s.data->>'spam')::bool, false)
    order by organic desc limit 1`;

  const snapshot: TokenSnapshot = {
    address: t.address,
    symbol: t.symbol,
    totalSupply: BigInt(t.total_supply),
    deployer: t.deployer,
    createdAt,
    createdBlock: BigInt(t.created_block),
    holders: holders.map((h) => ({ wallet: h.wallet, amount: BigInt(h.amount) })),
    holderCount,
    earlyBuys: earlyBuys.map((b) => ({
      trader: b.trader, block: BigInt(b.block), time: Math.floor(b.time.getTime() / 1000), tokenAmount: BigInt(b.token_amount),
    })),
    launchIndexed: t.launch_indexed,
    wallets,
    airdropped: airdropped.map((a) => a.to),
    devTokens: devTokens.map((d) => ({
      address: d.address,
      createdAt: Math.floor(d.created_at.getTime() / 1000),
      athMarketCapUsd: d.ath_market_cap_usd ? Number(d.ath_market_cap_usd) : null,
      marketCapUsd: d.market_cap_usd ? Number(d.market_cap_usd) : null,
      migrated: d.status === 'migrated',
    })),
    twinOrganicHolders,
    launchpad: t.launchpad,
    now: Math.floor(Date.now() / 1000),
  };

  return { snapshot, devFunder };
}

async function saveSignals(sql: Sql, snapshot: TokenSnapshot, signals: TokenSignals, devFunder: string | null) {
  const token = snapshot.address;
  const t = { deployer: snapshot.deployer };
  await sql`
    insert into signals (token, data, risk_level, verdict)
    values (${token}, ${sql.json(signals as never)}, ${signals.risk}, ${signals.verdict})
    on conflict (token) do update set data = excluded.data, risk_level = excluded.risk_level,
      verdict = excluded.verdict, updated_at = now()`;
  await sql`
    insert into deployer_stats (deployer, cluster, launches, launches_7d, rugs, migrated, best_peak_mcap_usd)
    values (${t.deployer}, ${devFunder}, ${signals.dev.launches + 1}, ${signals.dev.launches7d + 1}, ${signals.dev.rugs},
            ${signals.dev.migrated}, ${signals.dev.bestAthMarketCapUsd})
    on conflict (deployer) do update set cluster = excluded.cluster, launches = excluded.launches,
      launches_7d = excluded.launches_7d, rugs = excluded.rugs, migrated = excluded.migrated,
      best_peak_mcap_usd = excluded.best_peak_mcap_usd, updated_at = now()`;
}

/** First funder and whether it's a contract, for wallets not checked yet (also used for member sign-ups). */
export async function ensureFunding(sql: Sql, rpc: Rpc, wallets: string[]) {
  if (!wallets.length) return;
  const known = new Set(
    (await sql<{ address: string }[]>`
      select address from wallets where address = any(${wallets}) and funding_checked_at is not null`).map((r) => r.address),
  );
  const missing = wallets.filter((w) => !known.has(w)) as Address[];
  if (!missing.length) return;
  const [found, codes] = await Promise.all([
    rpc.firstFunders(missing),
    rpc.batch<string>(missing.map((w) => ({ method: 'eth_getCode', params: [w, 'latest'] }))),
  ]);
  const rows = missing.map((w, i) => {
    const f = found.get(w);
    const code = codes[i];
    return {
      address: w,
      // Smart accounts (ERC-4337) are contracts too; callers decide what to exclude.
      is_contract: code == null ? null : code !== '0x',
      first_funder: f?.funder ?? null,
      funded_at: f?.at ? new Date(f.at * 1000) : null,
      first_seen: f?.at ? new Date(f.at * 1000) : null,
      funding_checked_at: new Date(),
    };
  });
  await sql`
    insert into wallets ${sql(rows)}
    on conflict (address) do update set first_funder = excluded.first_funder, funded_at = excluded.funded_at,
      first_seen = excluded.first_seen, funding_checked_at = excluded.funding_checked_at, is_contract = excluded.is_contract`;
}
