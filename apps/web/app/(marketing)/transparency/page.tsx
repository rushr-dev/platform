import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import { ArrowUpRight } from '@phosphor-icons/react/dist/ssr';
import { CopyAddress } from '@/components/landing/copy-address';
import { Footer, Nav } from '@/components/landing/sections';
import { FEE_RATE_BPS, TREASURY, getTransparency, type Totals } from '@/components/landing/transparency-data';
import { WRAP } from '@/components/landing/ui';
import { Pending } from '@/components/landing/whitepaper';
import { EXPLORER, dateUtc, nf, short, usd } from '@/lib/format';

// Live numbers from the API's transparency feed, refreshed at most once a minute.
export const revalidate = 60;
export const viewport: Viewport = { themeColor: '#f7f5f2' };

const SHARE = {
  title: 'Transparency | Rushr',
  description: 'Every fee Rushr earns and every $RUSHR buyback, on-chain and public: the treasury, fees collected, where they go, and each buyback and burn.',
  image: { url: '/og-rushr.jpg', width: 1200, height: 630, alt: 'rushr. Open social trading for humans and AI agents. Built on Robinhood Chain.' },
};

export const metadata: Metadata = {
  title: { absolute: SHARE.title },
  description: SHARE.description,
  alternates: { canonical: '/transparency' },
  openGraph: { title: SHARE.title, description: SHARE.description, url: 'https://rushr.trade/transparency', siteName: 'Rushr', type: 'website', images: [SHARE.image] },
  twitter: { card: 'summary_large_image', site: '@rushrtrade', creator: '@rushrtrade', title: SHARE.title, description: SHARE.description, images: [SHARE.image] },
};

const SOURCE = 'https://github.com/rushr-dev/platform';
/** The $RUSHR contract on Robinhood Chain (PONS fair launch). */
const RUSHR_TOKEN = '0xa8ceeeb747fcf136947c35c5de6187ee90d6bfed';

const SOURCE_LABEL: Record<string, string> = { platform_fees: 'Platform fees', creator_tax: '$RUSHR creator tax' };

const DEV_WALLET = '0xe5ed29849043380aea7cfe62e97a23e82c55578e';
const TEAM_WALLET = '0x4fC9e610C270AE08717F43275F0fcaA57AF39E5D';
const TX = (h: string) => `https://robin.etherscan.io/tx/${h}`;

/** Every $RUSHR burn so far, newest first. Each one is a plain transfer to 0x…dEaD; amounts are from the transactions. */
const BURNS: { date: string; title: string; amount: string; note: string; txs: [string, string][] }[] = [
  {
    date: '21 Nov 2026',
    title: 'Creator-tax buyback #2',
    amount: '40,602,158',
    note: 'The second creator-tax claim paid 2.917 ETH. 0.668 ETH of it bought $RUSHR and burned all of it: about 4% of the supply.',
    txs: [
      ['Claim', '0x9fb25dac51360db413e84e014cb1cc7db731846f40e5d732b88e4fefa14c87fc'],
      ['Buy', '0xfceabe24e8464483670cca06aae59591c90a84d44b6e16a795c0fbf0a26eafe0'],
      ['Burn', '0xd4869f1e0c65967c96b1039a932af8a472f57d40420ecbcf6b044f52e109aed7'],
    ],
  },
  {
    date: '19 Nov 2026',
    title: 'Platform-fee buyback #1',
    amount: '1,173,460',
    note: 'The treasury Safe spent 0.01357 ETH, 25% of all platform fees to date, buying $RUSHR on Uniswap and sending it straight to 0x…dEaD in the same transaction.',
    txs: [['Buy & burn', '0xe296269a004477357262964e3e4c920c5bedf17bccce437b0e2acd108ec3bcc6']],
  },
  {
    date: '16 Nov 2026',
    title: 'Team supply burn',
    amount: '41,212,466',
    note: 'From the team wallet on FOMO, bringing total burned to 100M (10% of supply). The team wallet now holds about 14.7M (1.47%).',
    txs: [['Burn', '0x33c9d4a768d03ecb30f313591abe33afad95acb2e4d5c20638cde507e159e711']],
  },
  {
    date: '16 Nov 2026',
    title: 'Creator-tax buyback #1',
    amount: '8,787,534',
    note: 'The dev wallet claimed 1.92875 ETH of creator tax, bought $RUSHR with 0.386 ETH (20% of the claim) and burned all of it.',
    txs: [
      ['Claim', '0x12a7233449e0a30a4a0a580d243832cf5a41b1613cc4a78a221ab0bb09ff94ce'],
      ['Buy', '0xb2557bc185d2c5d11cd8fed983fbf7a448346d07de6b63ac88e2834df747ff9c'],
      ['Burn', '0x70d78f38f00a7c34653a4e53c8c3271bd98637fb4b073ad1b6d5d6c1e1a44307'],
    ],
  },
  {
    date: '15 Nov 2026',
    title: 'Launch burn',
    amount: '50,000,000',
    note: '5% of supply, bought on the PONS curve by the dev wallet at launch and burned the same hour.',
    txs: [['Burn', '0x6b2e5c67f7ac81847e00335c787b0eacb67c0d2f2826f80146e8a89f637e46cb']],
  },
];

const amount = (n: number | null, digits: number, min = digits) =>
  n == null ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: n === 0 ? 0 : min, maximumFractionDigits: digits });
/** Fee amounts are small during the beta, so ETH under 1 keeps 6 decimals. */
const eth = (n: number | null) => amount(n, n != null && Math.abs(n) < 1 ? 6 : 4, 0);
const usdg = (n: number | null) => amount(n, 2);
const approx = (n: number | null) => (n == null ? null : `≈ ${usd(n)}`);
const count = (n: number | null) => (n == null ? '—' : nf.format(n));

function Section({ id, title, aside, children }: { id: string; title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24 border-t border-line pt-10">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <h2 className="text-[28px] font-semibold leading-tight tracking-[-0.035em] md:text-[32px]">{title}</h2>
        {aside}
      </div>
      <div className="mt-6">{children}</div>
    </section>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string | null }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">{label}</div>
      <div className="mt-2 font-mono text-xl font-semibold tabular-nums tracking-tight text-ink">{value}</div>
      <div className="mt-0.5 h-5 text-xs tabular-nums text-muted">{sub}</div>
    </div>
  );
}

/** Uniswap vs PONS curve share of fees (by $ value, else by trade count). */
function RouteSplit({ uniswap, curve }: { uniswap: Totals; curve: Totals }) {
  const byUsd = uniswap.usd != null && curve.usd != null && uniswap.usd + curve.usd > 0;
  const a = byUsd ? uniswap.usd! : (uniswap.trades ?? 0);
  const b = byUsd ? curve.usd! : (curve.trades ?? 0);
  const total = a + b;
  const pa = total > 0 ? Math.round((a / total) * 100) : null;
  return (
    <div className="mt-3">
      <div className="flex h-2 overflow-hidden rounded-full bg-surface-2" aria-hidden>
        {pa != null && (
          <>
            <div className="bg-brand" style={{ width: `${pa}%` }} />
            <div className="bg-ink/35" style={{ width: `${100 - pa}%` }} />
          </>
        )}
      </div>
      <div className="mt-2 flex justify-between text-xs text-muted">
        <span>
          <span className="mr-1.5 inline-block size-2 rounded-sm bg-brand" aria-hidden />
          Uniswap <span className="font-mono tabular-nums text-ink">{pa == null ? '—' : `${pa}%`}</span>
          <span className="ml-1.5 tabular-nums">· {count(uniswap.trades)} trades</span>
        </span>
        <span>
          <span className="mr-1.5 inline-block size-2 rounded-sm bg-ink/35" aria-hidden />
          PONS curve <span className="font-mono tabular-nums text-ink">{pa == null ? '—' : `${100 - pa}%`}</span>
          <span className="ml-1.5 tabular-nums">· {count(curve.trades)} trades</span>
        </span>
      </div>
      <div className="sr-only">
        Fees by route: Uniswap {pa ?? 'unknown'}%, PONS curve {pa == null ? 'unknown' : 100 - pa}%{byUsd ? ' by value' : ' by trade count'}.
      </div>
    </div>
  );
}

function FeeGroup({ title, t }: { title: string; t: Totals & { uniswap: Totals; curve: Totals } }) {
  return (
    <div>
      <h3 className="text-[17px] font-semibold tracking-[-0.015em]">{title}</h3>
      <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-5 [&>*:last-child]:col-span-2 md:[&>*:last-child]:col-span-1">
        <Tile label="ETH" value={eth(t.eth)} />
        <Tile label="USDG" value={usdg(t.usdg)} />
        <Tile label="Value" value={t.usd == null ? '—' : usd(t.usd)} sub="at today's prices" />
        <Tile label="Trades" value={count(t.trades)} />
        <Tile label="Traders" value={count(t.traders)} sub="unique wallets" />
      </div>
      <RouteSplit uniswap={t.uniswap} curve={t.curve} />
    </div>
  );
}

const EMPTY: Totals = { eth: null, usdg: null, usd: null, trades: null, traders: null };
const EMPTY_ROUTES = { ...EMPTY, uniswap: EMPTY, curve: EMPTY };

export default async function TransparencyPage() {
  const data = await getTransparency();
  const treasury = data?.treasury.address ?? TREASURY;
  const rate = (data?.rateBps ?? FEE_RATE_BPS) / 100;
  const buybacks = data?.buybacks ?? [];

  return (
    <div className="theme-paper min-h-dvh">
      <Nav />
      <main className={`${WRAP} py-14 md:py-20`}>
        <div className="mx-auto max-w-5xl">
          <header>
            <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">Transparency · live on-chain numbers</p>
            <h1 className="mt-5 text-[44px] font-semibold leading-[1] tracking-[-0.05em] md:text-[72px]">Transparency</h1>
            <p className="mt-5 max-w-2xl text-lg text-muted md:text-xl">Every fee Rushr earns and every $RUSHR buyback, on-chain and public.</p>
          </header>

          {/* Treasury */}
          <div className="mt-12 rounded-2xl border border-line bg-surface p-5 md:p-8">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">Platform fee treasury</div>
              <span className="rounded-full border border-dashed border-ink/25 px-2.5 py-0.5 font-mono text-[11px] uppercase tracking-wider text-muted">
                Robinhood Chain
              </span>
            </div>
            <div className="mt-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <code className="break-all font-mono text-[15px] text-ink md:text-lg">{treasury}</code>
              <div className="flex shrink-0 gap-2">
                <CopyAddress value={treasury} />
                <a
                  href={`${EXPLORER}/address/${treasury}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-ink px-3 text-sm font-medium text-bg transition hover:bg-ink/85"
                >
                  Explorer <ArrowUpRight size={14} weight="bold" />
                </a>
              </div>
            </div>
            <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 [&>*:last-child]:col-span-2 sm:[&>*:last-child]:col-span-1">
              <Tile label="ETH balance" value={eth(data?.treasury.eth ?? null)} />
              <Tile label="USDG balance" value={usdg(data?.treasury.usdg ?? null)} />
              <Tile label="Total value" value={data?.treasury.usd == null ? '—' : approx(data.treasury.usd)!} sub="at today's prices" />
            </div>
            <p className="mt-5 text-sm text-muted">Held in a Safe multisig (2 of 2): every payout needs both signers. They are listed on the explorer and in the Safe app.</p>
          </div>

          {!data && (
            <p className="mt-4 rounded-xl border border-dashed border-ink/20 px-4 py-3 text-sm text-muted">
              Live balances and fee totals appear here as soon as the public feed is on. Until then, the treasury can be checked on
              the explorer.
            </p>
          )}

          <div className="mt-16 space-y-16">
            <Section
              id="fees"
              title="Fees collected"
              aside={
                <span className="text-sm text-muted">
                  Fee rate <span className="font-mono font-semibold tabular-nums text-brand-deep">{rate}%</span>
                  {data?.beta ? ' during the beta' : ''}
                </span>
              }
            >
              <div className="space-y-10">
                <FeeGroup title="All-time" t={data?.allTime ?? EMPTY_ROUTES} />
                <FeeGroup title={data?.season.name ?? 'Season 0'} t={data?.season ?? EMPTY_ROUTES} />
              </div>
            </Section>

            <Section id="where-fees-go" title="Where fees go">
              <div className="grid gap-3 md:grid-cols-3">
                {[
                  ['30%', 'Cashback', 'Back to the trader who paid it, sent to their wallet every Sunday.'],
                  ['20%', 'Burn', 'Buys $RUSHR on the open market and burns it.'],
                  ['50%', 'Team', "Development, infrastructure and audits. A referrer's 20% comes out of this share."],
                ].map(([p, k, d]) => (
                  <div key={k} className="rounded-xl border border-line bg-surface p-5">
                    <div className="font-mono text-3xl font-semibold tabular-nums text-brand-deep">{p}</div>
                    <div className="mt-2 font-semibold">{k}</div>
                    <p className="mt-1 text-sm text-muted">{d}</p>
                  </div>
                ))}
              </div>
              <p className="mt-4 text-sm text-muted">
                Since 25 November 2026. Fees paid before then were split 25% burn, 25% Season 0 rewards, 50% team.
              </p>
              <p className="mt-2 text-sm text-muted">
                20% of the $RUSHR creator tax is also bought back and burned. Details in the whitepaper:{' '}
                <Link href="/whitepaper#fees" className="text-ink underline underline-offset-2">Fees</Link> and{' '}
                <Link href="/whitepaper#buyback-burn-and-season-prizes" className="text-ink underline underline-offset-2">
                  Buyback, burn and season prizes
                </Link>
                .
              </p>
            </Section>

            <Section id="creator-tax" title="$RUSHR creator tax">
              <div className="rounded-xl border border-line bg-surface p-5 text-[15px] leading-relaxed text-ink/85">
                <p>
                  Every $RUSHR trade pays a creator tax: in ETH on the PONS curve before graduation, and in $RUSHR through the PONS hook on
                  the Uniswap v4 pool since then (2% of each swap, on top of PONS&apos;s own 1%). It builds up in the PONS contracts until
                  it&apos;s claimed.
                </p>
                <p className="mt-3">
                  <span className="font-semibold text-brand-deep">20%</span> of everything claimed is bought back and burned, from the dev
                  wallet that claims it, and listed below with its transactions.
                </p>
                <p className="mt-3">
                  First claim, 16 Nov 2026: <span className="font-mono font-semibold text-ink">1.92875 ETH</span>. 0.386 ETH of it bought{' '}
                  <span className="font-mono font-semibold text-brand-deep">8,787,534 $RUSHR</span>, all burned.
                </p>
                <p className="mt-3">
                  Second claim, 20 Nov 2026: <span className="font-mono font-semibold text-ink">2.917 ETH</span>. 0.668 ETH of it bought{' '}
                  <span className="font-mono font-semibold text-brand-deep">40,602,158 $RUSHR</span>, all burned.
                </p>
              </div>
            </Section>

            <Section id="buybacks" title="Buybacks & burns">
              <div className="rounded-xl border border-line bg-surface p-5 md:p-6">
                <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">Total burned</div>
                <div className="mt-2 font-mono text-3xl font-semibold tabular-nums tracking-tight text-brand-deep md:text-4xl">141,775,618 $RUSHR</div>
                <div className="mt-1 text-sm text-muted">14.2% of the 1,000,000,000 supply, sent to 0x…dEaD and gone for good.</div>
              </div>
              <ol className="mt-3 divide-y divide-line rounded-xl border border-line bg-surface">
                {BURNS.map((b) => (
                  <li key={b.title} className="flex flex-col gap-3 px-5 py-4 md:flex-row md:items-start md:justify-between md:gap-8">
                    <div className="min-w-0">
                      <div className="text-sm text-muted">
                        {b.title} · {b.date}
                      </div>
                      <div className="mt-1 font-mono text-xl font-semibold tabular-nums text-brand-deep">{b.amount} $RUSHR burned</div>
                      <p className="mt-1 max-w-xl text-sm text-muted">{b.note}</p>
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-x-3 gap-y-1 md:flex-col md:items-end">
                      {b.txs.map(([label, h]) => (
                        <a key={h} href={TX(h)} target="_blank" rel="noreferrer" className="font-mono text-xs underline underline-offset-2">
                          {label} {short(h)}
                        </a>
                      ))}
                    </div>
                  </li>
                ))}
              </ol>
              <h3 className="mb-3 mt-10 text-[17px] font-semibold tracking-[-0.015em]">Platform-fee buybacks</h3>
              {buybacks.length === 0 ? (
                <div className="rounded-xl border border-dashed border-ink/20 px-5 py-10 text-center text-muted">
                  None yet. Platform-fee buybacks run weekly from the treasury Safe once the fees cover more than the gas, and each one is
                  listed here with its transactions.
                </div>
              ) : (
                <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
                  <table className="w-full min-w-[720px] border-collapse text-left text-sm tabular-nums">
                    <thead>
                      <tr className="border-b border-ink/15 font-mono text-[11px] uppercase tracking-[0.12em] text-muted">
                        {['Date', 'Source', 'Spent', '$RUSHR bought', 'Burned', 'To rewards', 'Transactions'].map((h) => (
                          <th key={h} className="py-2.5 pr-5 font-medium last:pr-0">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {buybacks.map((b, i) => (
                        <tr key={i} className="border-b border-line align-top">
                          <td className="whitespace-nowrap py-3 pr-5">{b.date ? dateUtc(b.date) : '—'}</td>
                          <td className="py-3 pr-5">{SOURCE_LABEL[b.source] ?? (b.source || '—')}</td>
                          <td className="py-3 pr-5">
                            {b.spent.amount == null ? '—' : `${b.spent.token === 'USDG' ? usdg(b.spent.amount) : eth(b.spent.amount)} ${b.spent.token}`}
                            {b.spent.usd != null && <div className="text-xs text-muted">{approx(b.spent.usd)}</div>}
                          </td>
                          <td className="py-3 pr-5 font-mono">{count(b.bought)}</td>
                          <td className="py-3 pr-5 font-mono text-brand-deep">{count(b.burned)}</td>
                          <td className="py-3 pr-5 font-mono">{count(b.toRewards)}</td>
                          <td className="py-3">
                            <div className="flex flex-wrap gap-x-3 gap-y-1">
                              {b.txHashes.map((h) => (
                                <a key={h} href={`${EXPLORER}/tx/${h}`} target="_blank" rel="noreferrer" className="font-mono text-xs underline underline-offset-2">
                                  {short(h)}
                                </a>
                              ))}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Section>

            <Section id="addresses" title="Token addresses">
              <table className="w-full border-collapse text-left text-[15px]">
                <tbody>
                  {(
                    [
                      ['$RUSHR token', RUSHR_TOKEN, `https://robinhoodchain.blockscout.com/token/${RUSHR_TOKEN}`],
                      ['Dev wallet (claims the creator tax, runs creator-tax buybacks)', DEV_WALLET, `https://robin.etherscan.io/address/${DEV_WALLET}`],
                      ['Team wallet (verified on FOMO)', TEAM_WALLET, `https://robin.etherscan.io/address/${TEAM_WALLET}`],
                      ['Treasury Safe (platform fees, fee buybacks, season rewards)', TREASURY, `https://robin.etherscan.io/address/${TREASURY}`],
                      ['Burn address', '0x000000000000000000000000000000000000dEaD', `https://robin.etherscan.io/token/${RUSHR_TOKEN}?a=0x000000000000000000000000000000000000dEaD`],
                    ] as const
                  ).map(([k, addr, href]) => (
                    <tr key={k} className="border-b border-line first:border-t first:border-t-ink/15">
                      <td className="w-1/2 py-3 pr-4 text-muted">{k}</td>
                      <td className="py-3">
                        {addr && href ? (
                          <a
                            href={href}
                            target="_blank"
                            rel="noreferrer"
                            className="break-all font-mono text-[13px] text-ink underline decoration-ink/25 underline-offset-2 hover:decoration-ink"
                          >
                            {addr}
                          </a>
                        ) : (
                          <Pending />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          </div>

          <p className="mt-16 border-t border-line pt-8 text-sm text-muted">
            Numbers come from the chain and Rushr&apos;s open-source indexer.{' '}
            <a href={SOURCE} target="_blank" rel="noreferrer" className="text-ink underline underline-offset-2">
              Read the code on GitHub
            </a>
            {data?.updatedAt && <> · updated {new Date(data.updatedAt).toISOString().slice(11, 16)} UTC</>}
          </p>
        </div>
      </main>
      <Footer />
    </div>
  );
}
