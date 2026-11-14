import type { Sql } from 'postgres';
import type { Address } from 'viem';
import { BURN_ADDRESSES, INFRA_ADDRESSES, computeSignals, isContractCode, type TokenSignals, type TokenSnapshot } from '@rushr/core';
import type { Rpc } from './rpc';
import { CONTRACT_TAX_TTL_S, readPonsTax, type ContractTax } from './pons-tax';

/** How many wallets per token get a funding lookup (each costs one Alchemy call, cached forever). */
const FUND_TOP_HOLDERS = 20;
const FUND_EARLY_BUYERS = 20;
/** A funder that funded this many known wallets is an exchange/bridge, not a cluster signal. */
const COMMON_FUNDER_MIN = 50;

const EXCLUDED = INFRA_ADDRESSES.map((a) => a.toLowerCase());
const BURNS = new Set<string>(BURN_ADDRESSES.map((a) => a.toLowerCase()));
/** Top holders checked for contract code (one eth_getCode each, cached in wallets.is_contract). */
const CODE_TOP_HOLDERS = 50;

/** Why a top holder isn't counted as a person in concentration signals. */
export type HolderKind = 'burn' | 'pool' | 'contract';

/** Compute and store a token's signals (topping up wallet funding info first). */
export async function recomputeSignals(sql: Sql, rpc: Rpc, token: string): Promise<TokenSignals | null> {
  const loaded = await loadSnapshot(sql, token, rpc);
  if (!loaded) return null;
  const { snapshot, devFunder } = loaded;
  const signals = computeSignals(snapshot);
  await saveSignals(sql, snapshot, { ...signals, contractTax: loaded.contractTax } as TokenSignals, devFunder);
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
): Promise<{
  snapshot: TokenSnapshot; devFunder: string | null; excluded: { wallet: string; amount: bigint; kind: HolderKind }[];
  contractTax: ContractTax | null;
} | null> {
  const [t] = await sql<
    { address: string; symbol: string; name: string; total_supply: string; deployer: string; created_at: Date; created_block: string; main_pool: string | null; launch_indexed: boolean; launchpad: string | null; holders: number }[]
  >`select address, symbol, name, total_supply, deployer, created_at, created_block, main_pool, launch_indexed, launchpad, holders from tokens where address = ${token}`;
  if (!t) return null;
  const createdAt = Math.floor(t.created_at.getTime() / 1000);
  const excluded = [...EXCLUDED, ...(t.main_pool && t.main_pool.length === 42 ? [t.main_pool] : [])];

  // Top balances, then split people from burns, pools/curves/hooks and contracts.
  const top = await sql<{ wallet: string; amount: string }[]>`
    select wallet, amount from balances where token = ${token} and amount > 0 order by amount desc limit 120`;
  const poolRows = await sql<{ id: string; hooks: string | null }[]>`select id, hooks from pools where token = ${token}`;
  const pools = new Set<string>([
    ...excluded.filter((a) => !BURNS.has(a)),
    ...poolRows.flatMap((p) => [p.id, p.hooks ?? '']).filter((a) => a.length === 42),
  ]);
  const kindOf = new Map<string, HolderKind>();
  for (const h of top) {
    if (BURNS.has(h.wallet)) kindOf.set(h.wallet, 'burn');
    else if (pools.has(h.wallet)) kindOf.set(h.wallet, 'pool');
    else if (h.wallet === token) kindOf.set(h.wallet, 'contract');
  }
  const candidates = top.filter((h) => !kindOf.has(h.wallet)).map((h) => h.wallet);
  if (rpc) await ensureCode(sql, rpc, candidates.slice(0, CODE_TOP_HOLDERS));
  for (const r of await sql<{ address: string }[]>`
    select address from wallets where address = any(${candidates}) and is_contract`) kindOf.set(r.address, 'contract');
  const holders = top.filter((h) => !kindOf.has(h.wallet)).slice(0, 100);
  const others = top.filter((h) => kindOf.has(h.wallet)).map((h) => ({ wallet: h.wallet, amount: BigInt(h.amount), kind: kindOf.get(h.wallet)! }));
  const [burnt] = await sql<{ amount: string | null }[]>`
    select sum(amount)::text as amount from balances where token = ${token} and wallet = any(${[...BURNS]})`;
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

  // Transfer tax: recent trades that were the only swap of this token in their tx, with the trader's net
  // flow of the token in that tx (what actually reached or left the wallet).
  const taxRows = await sql<{ side: 'buy' | 'sell'; token_amount: string; net: string }[]>`
    with sw as (
      select s.tx, s.side, s.token_amount, s.trader from swaps s
      where s.token = ${token}
        and not exists (select 1 from swaps o where o.tx = s.tx and o.token = s.token and o.log_index <> s.log_index)
        -- Transfers recorded for the tx (not for history we skipped), and a real wallet as the trader
        -- (a router fallback means the recipient wasn't resolved, so its net flow says nothing).
        and exists (select 1 from transfers x where x.tx = s.tx and x.token = s.token)
        and s.trader <> all(${EXCLUDED})
      order by s.block desc, s.log_index desc limit 40
    )
    select sw.side, sw.token_amount::text,
      coalesce(sum(case when tr.to = sw.trader then tr.amount when tr."from" = sw.trader then -tr.amount else 0 end), 0)::text as net
    from sw left join transfers tr on tr.tx = sw.tx and tr.token = ${token}
    group by sw.tx, sw.side, sw.token_amount`;
  const [counts] = await sql<{ buys: number; sells: number }[]>`
    select count(*) filter (where side = 'buy')::int as buys, count(*) filter (where side = 'sell')::int as sells
    from swaps where token = ${token}`;
  // Launch farms: the same name and symbol from other wallets in the day *before* this token (earlier
  // copies only; an original isn't blamed for the copycats that follow it).
  const [farm] = await sql<{ n: number }[]>`
    select count(distinct deployer)::int as n from tokens
    where lower(symbol) = lower(${t.symbol}) and lower(name) = lower(${t.name}) and address <> ${token}
      and deployer <> ${t.deployer} and created_at >= ${t.created_at}::timestamptz - interval '24 hours'
      and created_at < ${t.created_at}::timestamptz`;

  // PONS: the curve's creator tax and fee (cached in the signals, refreshed weekly; without rpc, cache only).
  let contractTax: ContractTax | null = null;
  if (t.launchpad === 'pons') {
    const [prev] = await sql<{ ct: ContractTax | null }[]>`select data->'contractTax' as ct from signals where token = ${token}`;
    contractTax = prev?.ct ?? null;
    if (rpc && (!contractTax || Date.now() / 1000 - contractTax.at > CONTRACT_TAX_TTL_S)) {
      contractTax = (await readPonsTax(sql, rpc, token).catch(() => null)) ?? contractTax;
    }
  }

  const snapshot: TokenSnapshot = {
    address: t.address,
    symbol: t.symbol,
    totalSupply: BigInt(t.total_supply),
    deployer: t.deployer,
    createdAt,
    createdBlock: BigInt(t.created_block),
    holders: holders.map((h) => ({ wallet: h.wallet, amount: BigInt(h.amount) })),
    burnt: BigInt(burnt?.amount ?? '0'),
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
    taxSamples: taxRows.map((r) => ({ side: r.side, swapAmount: BigInt(r.token_amount), traderNet: BigInt(r.net) })),
    tradeCounts: counts ?? { buys: 0, sells: 0 },
    contractTax: contractTax ? { buyBps: contractTax.creatorTaxBps, sellBps: contractTax.creatorTaxBps, venueFeeBps: contractTax.feeBps } : null,
    sameNameDeployers24h: farm?.n ?? 0,
  };

  return { snapshot, devFunder, excluded: others, contractTax };
}

/**
 * Cache whether wallets are contracts (code over 23 bytes; EIP-7702 EOAs aren't), for wallets never checked.
 * One eth_getCode per new wallet; the answer rarely changes.
 */
export async function ensureCode(sql: Sql, rpc: Rpc, wallets: string[]) {
  if (!wallets.length) return;
  const known = new Set(
    (await sql<{ address: string }[]>`select address from wallets where address = any(${wallets}) and is_contract is not null`).map((r) => r.address),
  );
  const missing = wallets.filter((w) => !known.has(w));
  if (!missing.length) return;
  const codes = await rpc.batch<string>(missing.map((w) => ({ method: 'eth_getCode', params: [w, 'latest'] })));
  const rows = missing.map((w, i) => ({ address: w, is_contract: isContractCode(codes[i]) })).filter((r) => r.is_contract != null);
  if (!rows.length) return;
  await sql`insert into wallets ${sql(rows)} on conflict (address) do update set is_contract = excluded.is_contract`;
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
      // Real contracts only: EIP-7702 delegated EOAs (23 bytes of code) are people. Smart accounts
      // (ERC-4337) are contracts; callers decide what to exclude.
      is_contract: isContractCode(code),
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
