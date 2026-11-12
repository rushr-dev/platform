import {
  pgTable,
  text,
  integer,
  bigint,
  numeric,
  boolean,
  jsonb,
  timestamp,
  primaryKey,
  index,
} from 'drizzle-orm/pg-core';

// Addresses and hashes are stored lowercase hex. Token/ETH amounts are raw integers (numeric(78,0)).
const amount = (name: string) => numeric(name, { precision: 78, scale: 0 });

export const tokens = pgTable(
  'tokens',
  {
    address: text('address').primaryKey(),
    name: text('name').notNull(),
    symbol: text('symbol').notNull(),
    decimals: integer('decimals').notNull(),
    totalSupply: amount('total_supply').notNull(),
    deployer: text('deployer').notNull(),
    launchpad: text('launchpad'),
    createdBlock: bigint('created_block', { mode: 'bigint' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    status: text('status', { enum: ['new', 'bonding', 'migrated'] }).notNull().default('new'),
    taxBps: integer('tax_bps'),
    quote: text('quote'), // quote asset address of the main pool (0x0 = native ETH)
    mainPool: text('main_pool'), // v4 pool id, or PONS curve address
    priceUsd: numeric('price_usd'),
    /** Block time of the swap that set price_usd; prices only move forward in time. */
    priceAt: timestamp('price_at', { withTimezone: true }),
    athMarketCapUsd: numeric('ath_market_cap_usd'),
    imageUrl: text('image_url'),
    website: text('website'),
    twitter: text('twitter'),
    telegram: text('telegram'),
    description: text('description'),
    /** When launchpad metadata (icon, socials) was last resolved; null = not tried yet. */
    metadataAt: timestamp('metadata_at', { withTimezone: true }),
    /** When the icon was first found (metadata_at moves on every retry): launch → icon latency. */
    imageAt: timestamp('image_at', { withTimezone: true }),
    // Rolling market stats, updated by the indexer.
    priceEth: numeric('price_eth'),
    marketCapUsd: numeric('market_cap_usd'),
    liquidityUsd: numeric('liquidity_usd'),
    volume24hUsd: numeric('volume_24h_usd'),
    holders: integer('holders').notNull().default(0),
    bondingProgress: numeric('bonding_progress'),
    migratedAt: timestamp('migrated_at', { withTimezone: true }),
    /** False when the token was discovered mid-life and its first trades couldn't be indexed. */
    launchIndexed: boolean('launch_indexed').notNull().default(true),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('tokens_deployer_idx').on(t.deployer),
    index('tokens_status_created_idx').on(t.status, t.createdAt),
  ],
);

export const pools = pgTable(
  'pools',
  {
    id: text('id').primaryKey(), // pool address, or v4 pool id
    token: text('token').notNull(),
    quote: text('quote').notNull(), // 0x0 (native ETH), WETH, USDG or a stock token
    tokenIsCurrency0: boolean('token_is_currency0').notNull().default(false),
    dex: text('dex').notNull(), // 'uniswap-v4' | 'pons-curve' | 'v3' | 'v2' (v3/v2 include every fork)
    venue: text('venue'), // v3/v2 only: DEX name (uniswap, ramses, aero, up, topaz, ...), 'other' if unknown
    // Pool key parts, so swaps can be routed (v4: currency0/1 from token/quote + these + hooks). Null for curves and v2.
    fee: integer('fee'),
    tickSpacing: integer('tick_spacing'),
    /** Last measured TVL (v3/v2: the pool's token balances), and when. Null for v4 until per-pool TVL lands. */
    liquidityUsd: numeric('liquidity_usd'),
    liquidityAt: timestamp('liquidity_at', { withTimezone: true }),
    launchpad: text('launchpad'),
    hooks: text('hooks'),
    createdBlock: bigint('created_block', { mode: 'bigint' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('pools_token_idx').on(t.token)],
);

export const swaps = pgTable(
  'swaps',
  {
    tx: text('tx').notNull(),
    logIndex: integer('log_index').notNull(),
    token: text('token').notNull(),
    pool: text('pool').notNull(),
    block: bigint('block', { mode: 'bigint' }).notNull(),
    time: timestamp('time', { withTimezone: true }).notNull(),
    trader: text('trader').notNull(),
    side: text('side', { enum: ['buy', 'sell'] }).notNull(),
    tokenAmount: amount('token_amount').notNull(),
    quote: text('quote').notNull(),
    quoteAmount: amount('quote_amount').notNull(),
    priceUsd: numeric('price_usd'),
    usd: numeric('usd'),
    /** Sells only: PnL realized by this sell at the trader's average cost then (null when unpriced). */
    realizedUsd: numeric('realized_usd'),
  },
  (t) => [
    primaryKey({ columns: [t.tx, t.logIndex] }),
    index('swaps_token_time_idx').on(t.token, t.time),
    // Per-wallet history and windows (profiles, PnL, the Agents leaderboard).
    index('swaps_trader_time_idx').on(t.trader, t.time),
  ],
);

/**
 * A wallet's position in a token, from its trades on every indexed venue (average-cost basis).
 * Tokens sold beyond what the wallet bought (airdrops, transfers in) count at zero cost and are
 * tracked in unbacked_sold_tokens. Unrealized PnL = held_tokens x current price - cost_basis_usd.
 */
export const positions = pgTable(
  'positions',
  {
    wallet: text('wallet').notNull(),
    token: text('token').notNull(),
    boughtTokens: amount('bought_tokens').notNull().default('0'),
    boughtUsd: numeric('bought_usd').notNull().default('0'),
    soldTokens: amount('sold_tokens').notNull().default('0'),
    soldUsd: numeric('sold_usd').notNull().default('0'),
    buys: integer('buys').notNull().default(0),
    sells: integer('sells').notNull().default(0),
    /** Tokens bought and not yet sold (raw units). */
    heldTokens: amount('held_tokens').notNull().default('0'),
    /** Average cost of held_tokens. */
    costBasisUsd: numeric('cost_basis_usd').notNull().default('0'),
    realizedUsd: numeric('realized_usd').notNull().default('0'),
    /** Sold without a matching buy (zero cost basis): airdrops, transfers in, tokens bought before indexing. */
    unbackedSoldTokens: amount('unbacked_sold_tokens').notNull().default('0'),
    firstTradeAt: timestamp('first_trade_at', { withTimezone: true }).notNull(),
    lastTradeAt: timestamp('last_trade_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.wallet, t.token] }), index('positions_token_idx').on(t.token)],
);

/**
 * Trades placed through Rushr (web, agents, API) and the platform fee each paid, for fee accounting and
 * referral accruals. Recorded from the chain, never from client amounts: amounts and the fee actually
 * received by the treasury come from the receipt and a call trace. See docs/trading.md.
 */
export const tradesLedger = pgTable(
  'trades_ledger',
  {
    id: text('id').primaryKey(),
    chainId: integer('chain_id').notNull(),
    status: text('status', { enum: ['quoted', 'submitted', 'confirmed', 'failed'] }).notNull(),
    txHash: text('tx_hash').notNull().unique(),
    blockNumber: bigint('block_number', { mode: 'bigint' }),
    ts: timestamp('ts', { withTimezone: true }).notNull(),
    trader: text('trader').notNull(),
    sourceKind: text('source_kind', { enum: ['web', 'agent', 'api'] }).notNull(),
    sourceId: text('source_id'),
    side: text('side', { enum: ['buy', 'sell'] }),
    token: text('token'),
    quoteAsset: text('quote_asset', { enum: ['ETH', 'USDG'] }),
    venue: text('venue'),
    poolId: text('pool_id'),
    router: text('router'),
    /** buy: quote paid in total (fee included); sell: tokens sold. Raw units. */
    amountIn: amount('amount_in'),
    /** buy: tokens received; sell: quote received after the fee. Raw units. */
    amountOut: amount('amount_out'),
    feeToken: text('fee_token'),
    baseFeeBps: integer('base_fee_bps'),
    /** Effective fee rate measured from the chain (fee / quote notional). */
    feeBps: numeric('fee_bps'),
    /** Received by the treasury in this tx: the payout basis. */
    feeAmount: amount('fee_amount'),
    referrer: text('referrer'),
    referralCode: text('referral_code'),
    referralDiscount: amount('referral_discount'),
    referrerShareBps: integer('referrer_share_bps'),
    referrerAccrual: amount('referrer_accrual'),
    /** Anything that didn't match expectations (fee rate off, trader mismatch, no swap found, ...). */
    flags: text('flags').array().notNull().default([]),
    confirmAttempts: integer('confirm_attempts').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('trades_ledger_referrer_status_idx').on(t.referrer, t.status), index('trades_ledger_trader_ts_idx').on(t.trader, t.ts)],
);

/** Per-wallet PnL summary for profiles, refreshed about every minute from positions and swaps. */
export const walletPnl = pgTable(
  'wallet_pnl',
  {
    wallet: text('wallet').primaryKey(),
    realizedUsd: numeric('realized_usd').notNull(),
    unrealizedUsd: numeric('unrealized_usd').notNull(),
    realized24hUsd: numeric('realized_24h_usd').notNull(),
    realized7dUsd: numeric('realized_7d_usd').notNull(),
    realized30dUsd: numeric('realized_30d_usd').notNull(),
    volumeUsd: numeric('volume_usd').notNull(),
    trades: integer('trades').notNull(),
    tokensTraded: integer('tokens_traded').notNull(),
    /** Share of closed positions (nothing held) with realized PnL > 0; null when none closed. */
    winRate: numeric('win_rate'),
    bestTradeUsd: numeric('best_trade_usd'),
    lastTradeAt: timestamp('last_trade_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('wallet_pnl_realized_idx').on(t.realizedUsd)],
);

export const transfers = pgTable(
  'transfers',
  {
    tx: text('tx').notNull(),
    logIndex: integer('log_index').notNull(),
    token: text('token').notNull(),
    block: bigint('block', { mode: 'bigint' }).notNull(),
    time: timestamp('time', { withTimezone: true }).notNull(),
    from: text('from').notNull(),
    to: text('to').notNull(),
    amount: amount('amount').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tx, t.logIndex] }),
    index('transfers_token_idx').on(t.token, t.block),
  ],
);

export const balances = pgTable(
  'balances',
  {
    token: text('token').notNull(),
    wallet: text('wallet').notNull(),
    amount: amount('amount').notNull(),
    // Largest balance ever held and when the wallet first received the token: used by signals.
    firstReceivedAt: timestamp('first_received_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.token, t.wallet] }), index('balances_wallet_idx').on(t.wallet)],
);

/**
 * Staging for a full-history holder backfill: balances aggregated from Transfers before the
 * token's first indexed transfer, merged into `balances` in one transaction when the job ends.
 */
export const holderBackfill = pgTable(
  'holder_backfill',
  {
    token: text('token').notNull(),
    wallet: text('wallet').notNull(),
    amount: amount('amount').notNull(),
    firstReceivedAt: timestamp('first_received_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.token, t.wallet] })],
);

export const wallets = pgTable(
  'wallets',
  {
    address: text('address').primaryKey(),
    firstSeen: timestamp('first_seen', { withTimezone: true }),
    firstFunder: text('first_funder'),
    fundedAt: timestamp('funded_at', { withTimezone: true }),
    fundingCheckedAt: timestamp('funding_checked_at', { withTimezone: true }),
    isContract: boolean('is_contract'),
    labels: text('labels').array().notNull().default([]),
  },
  (t) => [index('wallets_funder_idx').on(t.firstFunder)],
);

export const candles = pgTable(
  'candles',
  {
    token: text('token').notNull(),
    interval: text('interval', { enum: ['1m'] }).notNull(), // coarser intervals are aggregated at query time
    bucket: timestamp('bucket', { withTimezone: true }).notNull(),
    open: numeric('open').notNull(),
    high: numeric('high').notNull(),
    low: numeric('low').notNull(),
    close: numeric('close').notNull(),
    volumeUsd: numeric('volume_usd').notNull(),
    trades: integer('trades').notNull(),
  },
  (t) => [primaryKey({ columns: [t.token, t.interval, t.bucket] })],
);

export const signals = pgTable('signals', {
  token: text('token').primaryKey(),
  data: jsonb('data').notNull(), // TokenSignals from @rushr/core
  riskLevel: text('risk_level', { enum: ['low', 'medium', 'high', 'unknown'] }).notNull(),
  verdict: text('verdict').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const deployerStats = pgTable('deployer_stats', {
  deployer: text('deployer').primaryKey(),
  cluster: text('cluster'), // shared first funder, if any
  launches: integer('launches').notNull().default(0),
  launches7d: integer('launches_7d').notNull().default(0),
  rugs: integer('rugs').notNull().default(0),
  migrated: integer('migrated').notNull().default(0),
  avgSecondsToDevSell: integer('avg_seconds_to_dev_sell'),
  bestPeakMcapUsd: numeric('best_peak_mcap_usd'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const indexerState = pgTable('indexer_state', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
