/**
 * Re-price a token's stored swaps with the current outlier guard (PriceReference, @rushr/core) and
 * repair what those prices feed: swaps.price_usd (trade list, 1s/15s/30s candles), the stored 1m
 * candles (5m/15m/1h/4h, Rush peaks), the ATH and the current price / market cap.
 *
 * Needed when the guard changes: prices already written stay wrong otherwise. E.g. side-pool
 * arbitrage at 44x the curve price drew a $1.6M wick on IDLEX (a $37K token) before the pool-share
 * check existed. USD values (trade sizes, volumes, PnL) don't change; only which trades set a price.
 */
import type { Sql } from 'postgres';
import { MAX_DEVIATION, MIN_POOL_SHARE, PriceReference, TRUSTED_USD } from '@rushr/core';

/** Buckets this recent are left to the live pipeline (it may be writing them right now). */
const LIVE_S = 120;

export interface RepriceResult {
  token: string;
  symbol: string;
  swaps: number;
  /** Swaps that had a price and lose it. */
  unpriced: number;
  /** Swaps that had none and get one (e.g. trades rejected against an outlier reference). */
  priced: number;
  candlesChanged: number;
  candlesRemoved: number;
  highBefore: number | null;
  highAfter: number | null;
  athBefore: number | null;
  athAfter: number | null;
}

interface SwapRow { tx: string; log_index: number; t: number; token_amount: string; quote_amount: string; usd: number | null; price_usd: number | null }
interface Candle { bucket: number; o: number; h: number; l: number; c: number; v: number; n: number }

const same = (a: number | null, b: number | null) => (a == null || b == null ? a === b : Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b)));

/** Replay one token's swaps through the guard and (with `write`) store the result. */
export async function repriceToken(sql: Sql, token: string, opts: { write: boolean; now?: number }): Promise<RepriceResult | null> {
  const run = async (q: Sql): Promise<RepriceResult | null> => {
    const [tok] = await q<{ symbol: string; decimals: number; total_supply: string; ath: number | null }[]>`
      select symbol, decimals, total_supply::text, ath_market_cap_usd::float8 as ath from tokens where address = ${token}`;
    if (!tok) return null;
    const supply = Number(tok.total_supply) / 10 ** tok.decimals;
    const swaps = await q<SwapRow[]>`
      select tx, log_index, extract(epoch from time)::int as t, token_amount::text, quote_amount::text,
        usd::float8 as usd, price_usd::float8 as price_usd
      from swaps where token = ${token} order by block, log_index`;

    const ref = new PriceReference();
    const changed: { tx: string; li: number; price: number | null }[] = [];
    const candles = new Map<number, Candle>();
    let unpriced = 0;
    let priced = 0;
    let last: { price: number; t: number } | null = null;
    for (const s of swaps) {
      const tokens = Number(s.token_amount) / 10 ** tok.decimals;
      let price: number | null = s.usd != null && tokens > 0 ? s.usd / tokens : null;
      if (price != null && !ref.accept({ usd: s.usd!, price, quoteRaw: BigInt(s.quote_amount), supply, tx: s.tx })) price = null;
      if (!same(price, s.price_usd)) {
        changed.push({ tx: s.tx, li: s.log_index, price });
        if (price == null) unpriced++;
        else if (s.price_usd == null) priced++;
      }
      if (price == null) continue;
      last = { price, t: s.t };
      const bucket = Math.floor(s.t / 60) * 60;
      const c = candles.get(bucket);
      if (!c) candles.set(bucket, { bucket, o: price, h: price, l: price, c: price, v: s.usd!, n: 1 });
      else Object.assign(c, { h: Math.max(c.h, price), l: Math.min(c.l, price), c: price, v: c.v + s.usd!, n: c.n + 1 });
    }

    const stored = await q<{ bucket: number; o: number; h: number; l: number; c: number; v: number; n: number }[]>`
      select extract(epoch from bucket)::int as bucket, open::float8 as o, high::float8 as h, low::float8 as l, close::float8 as c,
        volume_usd::float8 as v, trades as n
      from candles where token = ${token} and interval = '1m'`;
    const liveFrom = (opts.now ?? Math.floor(Date.now() / 1000)) - LIVE_S;
    const old = new Map(stored.map((c) => [c.bucket, c]));
    const upserts = [...candles.values()].filter((c) => {
      const o = old.get(c.bucket);
      return c.bucket < liveFrom && (!o || !(same(o.o, c.o) && same(o.h, c.h) && same(o.l, c.l) && same(o.c, c.c) && o.n === c.n));
    });
    const removed = stored.filter((c) => c.bucket < liveFrom && !candles.has(c.bucket)).map((c) => c.bucket);

    const highOf = (cs: Iterable<{ h: number }>) => {
      let m: number | null = null;
      for (const c of cs) m = m == null ? c.h : Math.max(m, c.h);
      return m;
    };
    const highBefore = highOf(stored);
    const highAfter = highOf(candles.values());
    // Only ever lower the ATH, and only when the repair lowered the peak: the stored ATH was taken at the
    // supply of its time, which may differ from today's (mints, burns).
    const athAfter = tok.ath != null && highAfter != null && highBefore != null && highAfter < highBefore && !same(highAfter, highBefore)
      ? Math.min(tok.ath, highAfter * supply)
      : tok.ath;
    const result: RepriceResult = {
      token, symbol: tok.symbol, swaps: swaps.length, unpriced, priced, candlesChanged: upserts.length, candlesRemoved: removed.length,
      highBefore, highAfter, athBefore: tok.ath, athAfter,
    };
    if (!opts.write || (!changed.length && !upserts.length && !removed.length && same(athAfter, tok.ath))) return result;

    // Same lock order as the pipeline's write path: swaps, then candles, then the token row.
    for (let i = 0; i < changed.length; i += 2000) {
      const chunk = changed.slice(i, i + 2000);
      await q`update swaps s set price_usd = v.price
        from unnest(${chunk.map((x) => x.tx)}::text[], ${chunk.map((x) => x.li)}::int[], ${chunk.map((x) => (x.price == null ? null : String(x.price)))}::numeric[]) v(tx, li, price)
        where s.tx = v.tx and s.log_index = v.li`;
    }
    if (removed.length) {
      await q`delete from candles where token = ${token} and interval = '1m' and bucket = any(${removed.map((b) => new Date(b * 1000))}::timestamptz[])`;
    }
    for (let i = 0; i < upserts.length; i += 1000) {
      const rows = upserts.slice(i, i + 1000).map((c) => ({
        token, interval: '1m', bucket: new Date(c.bucket * 1000), open: String(c.o), high: String(c.h), low: String(c.l),
        close: String(c.c), volume_usd: String(c.v), trades: c.n,
      }));
      await q`insert into candles ${q(rows)}
        on conflict (token, interval, bucket) do update set open = excluded.open, high = excluded.high, low = excluded.low,
          close = excluded.close, volume_usd = excluded.volume_usd, trades = excluded.trades`;
    }
    // ATH from the repaired candles; the current price from the last priced swap (unless live has moved past it).
    await q`update tokens t set ath_market_cap_usd = ${athAfter == null ? null : String(athAfter)}::numeric, updated_at = now()
      where t.address = ${token}`;
    if (last) {
      const at = new Date(last.t * 1000);
      await q`update tokens t set price_usd = ${String(last.price)}::numeric, price_at = ${at},
          market_cap_usd = ${String(last.price)}::numeric * t.total_supply / power(10::numeric, t.decimals)
        where t.address = ${token} and (t.price_at is null or t.price_at <= ${at})`;
    }
    return result;
  };
  return opts.write ? (sql.begin((tx) => run(tx as unknown as Sql)) as Promise<RepriceResult | null>) : run(sql);
}

/**
 * Tokens with a stored price the current guard would reject: a trade of TRUSTED_USD+ that moved the
 * price more than MAX_DEVIATION from the previous priced trade while implying a pool under
 * MIN_POOL_SHARE of the market cap. Swaps since `days` ago; most offending trades first.
 */
export async function outlierTokens(sql: Sql, days: number, limit: number): Promise<{ token: string; symbol: string; trades: number; worst: number }[]> {
  return sql<{ token: string; symbol: string; trades: number; worst: number }[]>`
    with p as (
      select s.token, s.usd::float8 as usd, s.price_usd::float8 as px,
        lag(s.price_usd::float8) over (partition by s.token order by s.block, s.log_index) as ref
      from swaps s where s.price_usd is not null and s.time > now() - make_interval(days => ${days})
    )
    select p.token, t.symbol, count(*)::int as trades, max(greatest(p.px / p.ref, p.ref / p.px))::float8 as worst
    from p join tokens t on t.address = p.token
    where p.ref > 0 and p.usd >= ${TRUSTED_USD} and (p.px > ${MAX_DEVIATION} * p.ref or p.px * ${MAX_DEVIATION} < p.ref)
      and t.total_supply > 0
      and p.usd / (abs(p.px / p.ref - 1) * p.ref * t.total_supply::float8 / power(10, t.decimals)) < ${MIN_POOL_SHARE}
    group by p.token, t.symbol order by trades desc limit ${limit}`;
}
