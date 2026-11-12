import { describe, expect, it } from 'vitest';
import { decodeFunctionData, getAddress, zeroAddress, type Address } from 'viem';
import {
  assertOneClickAllowed,
  canonicalize,
  createSessionSigner,
  derToRaw,
  PlaceholderKmsKey,
  PrivySessionSigner,
  rawToDer,
  WebCryptoAuthorizationKey,
} from '../src/signer';
import { allowedSelectors, buildSignerPolicy, defaultCaps, DEFAULT_CAPS } from '../src/policy';
import { buildRushrRouterSwap, routeFromPool, rushrPoolKey, rushrRouterAbi, RouteKind } from '../src/rushr-router';
import { resolveConfig } from '../src/config';
import { TRADE_ADDRESSES } from '../src/addresses';
import type { PonsPool, Quote, V2Pool, V3Pool, V4Pool } from '../src/types';

const PONS: Address = '0x39dbed3a2bd333467115de45665cc57f813c4571';
const WALLET: Address = '0x2222222222222222222222222222222222222222';
const ROUTER: Address = '0x3333333333333333333333333333333333333333';
const CURVE_ROUTER: Address = '0x4444444444444444444444444444444444444444';

/** Ephemeral P-256 key generated for this test run only (never a real credential). */
async function testKey() {
  return crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
}

describe('RFC 8785 canonical JSON', () => {
  it('sorts keys by UTF-16 code units, recursively, and drops undefined', () => {
    expect(canonicalize({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null }, e: undefined })).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
    // "€" (U+20AC) sorts after "a"; "\u0080" between them, "1" before letters
    expect(canonicalize({ '€': 1, a: 2, '\u0080': 3, '1': 4 })).toBe('{"1":4,"a":2,"\u0080":3,"€":1}');
  });

  it('formats numbers like ECMAScript and refuses bigint / non-finite', () => {
    expect(canonicalize([1e21, 0.1, -0, 1e-7, 4663])).toBe('[1e+21,0.1,0,1e-7,4663]');
    expect(() => canonicalize({ v: 1n })).toThrow(/bigint/);
    expect(() => canonicalize(Infinity)).toThrow();
  });
});

describe('ECDSA signature encoding', () => {
  it('raw r||s <-> DER round-trips, incl. high-bit and leading-zero integers', () => {
    const raw = new Uint8Array(64);
    raw[0] = 0x80; // r needs a 0x00 pad in DER
    raw[31] = 1;
    raw[32] = 0;
    raw[33] = 0x01; // s has a leading zero byte to strip
    raw[63] = 2;
    const der = rawToDer(raw);
    expect(der[0]).toBe(0x30);
    expect(der[2]).toBe(0x02);
    expect(der[3]).toBe(33); // r padded
    expect(derToRaw(der)).toEqual(raw);
  });
});

describe('Privy session signer (REST, Workers-compatible)', () => {
  it('signs the canonical payload with the authorization key; Privy can verify it', async () => {
    const kp = await testKey();
    const signer = new PrivySessionSigner({
      appId: 'test-app',
      appSecret: 'test-secret',
      authorizationKey: new WebCryptoAuthorizationKey(kp.privateKey),
      now: () => 1_000,
    });
    const { url, init, signedPayload } = await signer.buildRequest('wallet_abc', { to: ROUTER, data: '0x1234', value: 10n ** 16n, chainId: 4663, nonce: 7 });
    expect(url).toBe('https://api.privy.io/v1/wallets/wallet_abc/rpc');
    const headers = init.headers as Record<string, string>;
    expect(headers['privy-app-id']).toBe('test-app');
    expect(headers['privy-request-expiry']).toBe('1060000');
    expect(headers.authorization).toBe(`Basic ${btoa('test-app:test-secret')}`);

    const payload = JSON.parse(signedPayload);
    expect(payload).toMatchObject({ version: 1, method: 'POST', url, headers: { 'privy-app-id': 'test-app', 'privy-request-expiry': '1060000' } });
    expect(payload.body.params.transaction).toMatchObject({ to: ROUTER, value: '0x2386f26fc10000', chain_id: 4663, nonce: '0x7' });
    expect(canonicalize(payload)).toBe(signedPayload); // already canonical
    expect(JSON.parse(init.body as string)).toEqual(payload.body);

    const der = Uint8Array.from(atob(headers['privy-authorization-signature']!), (c) => c.charCodeAt(0));
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, kp.publicKey, new Uint8Array(derToRaw(der)), new TextEncoder().encode(signedPayload));
    expect(ok).toBe(true);
  });

  it('imports Privy-format keys (wallet-auth:<pkcs8>)', async () => {
    const kp = await testKey();
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
    const key = await WebCryptoAuthorizationKey.fromPrivyString(`wallet-auth:${btoa(String.fromCharCode(...pkcs8))}`);
    const msg = new TextEncoder().encode('hello');
    const der = await key.signDer(msg);
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, kp.publicKey, new Uint8Array(derToRaw(der)), msg)).toBe(true);
  });

  it('returns the signed tx, and reports policy denials without retrying', async () => {
    const kp = await testKey();
    const calls: string[] = [];
    const ok = (async (u: string | URL | Request) => {
      calls.push(String(u));
      return new Response(JSON.stringify({ method: 'eth_signTransaction', data: { signed_transaction: '0x02f8aa' } }), { status: 200 });
    }) as typeof fetch;
    const denied = (async () => new Response('{"error":"Policy violation: transaction denied"}', { status: 403 })) as typeof fetch;
    const base = { appId: 'a', appSecret: 's', authorizationKey: new WebCryptoAuthorizationKey(kp.privateKey) };
    const tx = { to: ROUTER, data: '0x' as const, value: 1n, chainId: 4663 };
    expect(await new PrivySessionSigner({ ...base, fetch: ok }).signTransaction('w1', tx)).toBe('0x02f8aa');
    expect(calls).toHaveLength(1);
    await expect(new PrivySessionSigner({ ...base, fetch: denied }).signTransaction('w1', tx)).rejects.toThrow(/policy denied \(403\)/);
    await expect(new PrivySessionSigner({ ...base, fetch: ok }).buildRequest('../x', tx)).rejects.toThrow(/wallet id/);
  });

  it('is off unless WALLETS_ENABLED=1 and Privy is configured; the KMS placeholder refuses', async () => {
    const key = new PlaceholderKmsKey();
    expect(createSessionSigner({}, key)).toBeNull();
    expect(createSessionSigner({ WALLETS_ENABLED: '0', PRIVY_APP_ID: 'a', PRIVY_APP_SECRET: 's' }, key)).toBeNull();
    expect(createSessionSigner({ WALLETS_ENABLED: '1' }, key)).toBeNull();
    const s = createSessionSigner({ WALLETS_ENABLED: '1', PRIVY_APP_ID: 'a', PRIVY_APP_SECRET: 's' }, key);
    expect(s).toBeInstanceOf(PrivySessionSigner);
    await expect(s!.signTransaction('w', { to: ROUTER, data: '0x', value: 0n, chainId: 4663 })).rejects.toThrow(/No KMS configured/);
  });

  it('one-click trading stays off until RushrRouter is deployed and audited', () => {
    expect(() => assertOneClickAllowed(resolveConfig())).toThrow(/deployed/);
    expect(() => assertOneClickAllowed(resolveConfig({ rushrRouter: ROUTER }))).toThrow(/audited/);
    expect(() => assertOneClickAllowed(resolveConfig({ rushrRouter: ROUTER, rushrRouterAudited: true }))).not.toThrow();
  });
});

describe('Privy signer policy', () => {
  it('founder default caps: 0.25 ETH per trade, 1 ETH per 24 h, 30-day grants', () => {
    expect(defaultCaps(1_000)).toEqual({ perTradeWei: 25n * 10n ** 16n, dailyWei: 10n ** 18n, expiresAt: 1_000 + 30 * 86_400 });
    expect(DEFAULT_CAPS.grantSeconds).toBe(2_592_000);
  });

  it('allows only the router trade selectors and router approvals, within caps and expiry', () => {
    const p = buildSignerPolicy({ purpose: 'quick-trade', wallet: WALLET, rushrRouter: ROUTER, curveRouter: CURVE_ROUTER, caps: defaultCaps(1_000) });
    const s = allowedSelectors();
    const trade = p.rules[0]!;
    const cond = (rule: typeof trade, field: string) => rule.conditions.find((c) => c.field === field)!;
    expect(cond(trade, 'to').value).toEqual([ROUTER, CURVE_ROUTER]);
    expect(cond(trade, 'function_selector').value).toEqual([s.rushrBuy, s.rushrSell, s.curveBuy, s.curveSell]);
    expect(cond(trade, 'function_selector').value).not.toContain(s.rushrSellAnyPool); // user-confirmed exits only
    expect(cond(trade, 'value').value).toBe('250000000000000000');
    expect(cond(trade, 'eth_value_24h').value).toBe('1000000000000000000');
    expect(cond(trade, 'chain_id').value).toBe('4663');
    expect(cond(trade, 'current_unix_timestamp').value).toBe(String(1_000 + 2_592_000));
    const approve = p.rules[1]!;
    expect(cond(approve, 'approve.spender').value).toEqual([ROUTER, CURVE_ROUTER]);
    expect(cond(approve, 'value').value).toBe('0');
    expect(p.rules.every((r) => r.action === 'ALLOW' && r.method === 'eth_signTransaction')).toBe(true);
    expect(new Set([s.rushrBuy, s.rushrSell, s.rushrSellAnyPool, s.curveBuy, s.curveSell]).size).toBe(5);
  });

  it('per-agent policies are independent and validate caps', () => {
    const a = buildSignerPolicy({ purpose: 'agent:7', wallet: WALLET, rushrRouter: ROUTER, caps: { perTradeWei: 1n, dailyWei: 5n, expiresAt: 9 } });
    expect(a.name).toBe(`rushr:agent:7:${WALLET}`);
    expect(a.rules[0]!.conditions.find((c) => c.field === 'to')!.value).toEqual([ROUTER]);
    expect(() => buildSignerPolicy({ purpose: 'x', wallet: WALLET, rushrRouter: ROUTER, caps: { perTradeWei: 5n, dailyWei: 1n, expiresAt: 9 } })).toThrow(/caps/);
  });
});

describe('RushrRouter calldata', () => {
  const v4: V4Pool = {
    venue: 'uniswap-v4',
    id: '0x6073975413484a350101c0c5d592a91ceb6c3ee881ad359613a08359fd1495a0',
    key: { currency0: zeroAddress, currency1: PONS, fee: 3000, tickSpacing: 60, hooks: zeroAddress },
    hookData: '0x',
    token: PONS,
    quote: zeroAddress,
    venueFeeBps: 30,
    venueFeeLabel: '',
  };
  const v3: V3Pool = { venue: 'uniswap-v3', id: '0xed50bdeea8000000000000000000000000000000', token: PONS, quote: TRADE_ADDRESSES.weth, fee: 3000, venueFeeBps: 30, venueFeeLabel: '' };
  const v2usdg: V2Pool = { venue: 'uniswap-v2', id: '0x1', token: PONS, quote: TRADE_ADDRESSES.usdg, reserveToken: 1n, reserveQuote: 1n, venueFeeBps: 30, venueFeeLabel: '' };

  it('maps pools to routes (ETH/WETH Uniswap only) with keys matching the contract', () => {
    const r4 = routeFromPool(v4)!;
    expect(r4).toEqual({ kind: RouteKind.V4, token: PONS, quote: zeroAddress, fee: 3000, tickSpacing: 60, hooks: zeroAddress });
    expect(rushrPoolKey(r4)).toBe(v4.id);
    // Same value asserted in contracts/test/RushrRouter.t.sol (test_poolKeys) for the v3 route.
    expect(rushrPoolKey(routeFromPool(v3)!)).toBe(V3_KEY);
    expect(routeFromPool(v2usdg)).toBeNull();
    expect(routeFromPool({ venue: 'pons-curve' } as PonsPool)).toBeNull();
  });

  it('builds buy / sell / sellAnyPool calls with referral flag and router approval', () => {
    const cfg = resolveConfig({ rushrRouter: ROUTER });
    const q = (side: 'buy' | 'sell', feeBps = 50): Quote =>
      ({
        request: { side, token: PONS, quoteAsset: 'ETH', amountIn: 10n ** 16n, trader: WALLET },
        pool: v3,
        amountIn: 10n ** 16n,
        minAmountOut: 123n,
        fee: { feeBps, baseFeeBps: 50 },
      }) as unknown as Quote;
    const buy = buildRushrRouterSwap(q('buy', 45), cfg, { now: 1_000 });
    expect(buy.tx).toMatchObject({ to: ROUTER, value: 10n ** 16n });
    const d = decodeFunctionData({ abi: rushrRouterAbi, data: buy.tx.data });
    expect(d.functionName).toBe('buy');
    expect(d.args).toEqual([{ kind: 1, token: getAddress(PONS), quote: getAddress(TRADE_ADDRESSES.weth), fee: 3000, tickSpacing: 0, hooks: zeroAddress }, 123n, 1_300n, true]);

    const sell = buildRushrRouterSwap(q('sell'), cfg, { now: 1_000 });
    expect(decodeFunctionData({ abi: rushrRouterAbi, data: sell.tx.data }).functionName).toBe('sell');
    expect(sell.approvals).toEqual([{ kind: 'erc20', token: PONS, spender: ROUTER, amount: 2n ** 256n - 1n }]);
    expect(decodeFunctionData({ abi: rushrRouterAbi, data: buildRushrRouterSwap(q('sell'), cfg, { sellMode: 'any' }).tx.data }).functionName).toBe('sellAnyPool');

    expect(() => buildRushrRouterSwap(q('buy'), resolveConfig())).toThrow(/not deployed/);
  });
});

/** keccak256(abi.encode(uint8(1), WETH, PONS, uint24(3000))) — shared with the Solidity test. */
const V3_KEY = '0xa3f5a45e222714c4fc15486925f027adce5b0d0c9ae1ec4491443885f7e15796' as const;
