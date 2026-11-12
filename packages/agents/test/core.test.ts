import { describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { buildMessage, verifySiwe, peekSiwe } from '../src/siwe';
import { newApiKey, parseApiKey, sha256Hex, safeEqual, newLinkCode, isLinkCodeFormat, newNonce } from '../src/crypto';
import { checkHandle, findKeyMaterial } from '../src/guard';
import { windowStart, retryAfter } from '../src/limits';

const wallet = () => privateKeyToAccount(generatePrivateKey());

describe('siwe', () => {
  const now = new Date('2026-11-12T10:00:00Z');
  it('accepts a correctly signed message for its purpose', async () => {
    const a = wallet();
    const nonce = newNonce();
    const message = buildMessage({ purpose: 'register', address: a.address, nonce, issuedAt: now });
    const signature = await a.signMessage({ message });
    const r = await verifySiwe({ message, signature, purpose: 'register', nonce, now: new Date(now.getTime() + 5000) });
    expect(r).toEqual({ ok: true, value: { address: a.address.toLowerCase(), nonce, issuedAt: now } });
    expect(peekSiwe(message)).toEqual({ address: a.address.toLowerCase(), nonce });
  });
  it('rejects another wallet signature, another purpose, a wrong nonce and an expired message', async () => {
    const a = wallet(), b = wallet();
    const nonce = newNonce();
    const message = buildMessage({ purpose: 'register', address: a.address, nonce, issuedAt: now });
    const later = new Date(now.getTime() + 1000);
    expect(await verifySiwe({ message, signature: await b.signMessage({ message }), purpose: 'register', now: later })).toEqual({ ok: false, error: 'invalid_signature' });
    const sig = await a.signMessage({ message });
    expect(await verifySiwe({ message, signature: sig, purpose: 'login', now: later })).toEqual({ ok: false, error: 'wrong_statement' });
    expect(await verifySiwe({ message, signature: sig, purpose: 'register', nonce: 'other123', now: later })).toEqual({ ok: false, error: 'wrong_nonce' });
    expect(await verifySiwe({ message, signature: sig, purpose: 'register', now: new Date(now.getTime() + 11 * 60_000) })).toEqual({ ok: false, error: 'expired' });
  });
  it('binds the owner into owned statements', async () => {
    const a = wallet();
    const nonce = newNonce();
    const ctx = { ownerHandle: 'alice', ownerAddress: '0x00000000000000000000000000000000000000aa' };
    const message = buildMessage({ purpose: 'link', address: a.address, nonce, issuedAt: now, ctx });
    const signature = await a.signMessage({ message });
    const later = new Date(now.getTime() + 1000);
    expect((await verifySiwe({ message, signature, purpose: 'link', ctx, now: later })).ok).toBe(true);
    expect(await verifySiwe({ message, signature, purpose: 'link', ctx: { ...ctx, ownerHandle: 'mallory' }, now: later })).toEqual({ ok: false, error: 'wrong_statement' });
  });
  it('rejects a message for another domain or chain', async () => {
    const a = wallet();
    const nonce = newNonce();
    const message = buildMessage({ purpose: 'register', address: a.address, nonce, issuedAt: now }).replace('rushr.trade wants', 'evil.trade wants');
    expect(await verifySiwe({ message, signature: await a.signMessage({ message }), purpose: 'register', now })).toEqual({ ok: false, error: 'wrong_domain' });
    const m2 = buildMessage({ purpose: 'register', address: a.address, nonce, issuedAt: now }).replace('Chain ID: 4663', 'Chain ID: 1');
    expect(await verifySiwe({ message: m2, signature: await a.signMessage({ message: m2 }), purpose: 'register', now })).toEqual({ ok: false, error: 'wrong_chain' });
  });
});

describe('keys', () => {
  it('issues keys whose secret only exists as a hash', async () => {
    const k = await newApiKey();
    const parsed = parseApiKey(k.token)!;
    expect(parsed.id).toBe(k.id);
    expect(safeEqual(await sha256Hex(parsed.secret), k.secretHash)).toBe(true);
    expect(k.secretHash).not.toContain(parsed.secret);
    expect(parseApiKey('rk_short_x')).toBeNull();
    const c = await newLinkCode();
    expect(isLinkCodeFormat(c.code)).toBe(true);
  });
});

describe('guard', () => {
  it('normalises and validates handles', () => {
    expect(checkHandle('@Alice_1')).toEqual({ ok: true, handle: 'alice_1' });
    expect(checkHandle('ab')).toEqual({ ok: false, error: 'handle_invalid' });
    expect(checkHandle('0xdeadbeef')).toEqual({ ok: false, error: 'handle_invalid' });
    expect(checkHandle('rushr_0fficial')).toEqual({ ok: false, error: 'handle_reserved' });
    expect(checkHandle('admin')).toEqual({ ok: false, error: 'handle_reserved' });
  });
  it('allows only the exact opted-in top-level fields', () => {
    const hash = generatePrivateKey();
    expect(findKeyMaterial({ txHash: hash })).toBe('txHash');
    expect(findKeyMaterial({ txHash: hash }, { allow: ['txHash'] })).toBeNull();
    expect(findKeyMaterial({ txHash: hash, privateKey: hash }, { allow: ['txHash'] })).toBe('privateKey');
    expect(findKeyMaterial({ nested: { txHash: hash } }, { allow: ['txHash'] })).toBe('nested.txHash');
    expect(findKeyMaterial({ txHash: 'abandon ability able about above absent absorb abstract absurd abuse access accident' }, { allow: ['txHash'] })).toBeNull();
  });
  it('finds private keys and seed phrases anywhere in a body', () => {
    const pk = generatePrivateKey();
    expect(findKeyMaterial({ handle: 'x', privateKey: pk })).toBe('privateKey');
    expect(findKeyMaterial({ nested: { list: ['a', pk.slice(2)] } })).toBe('nested.list[1]');
    expect(findKeyMaterial({ note: 'abandon ability able about above absent absorb abstract absurd abuse access accident' })).toBe('note');
    // Signatures, addresses and tx hashes are fine... except a 32-byte hex string, which is ambiguous: tx hashes go in typed fields.
    expect(findKeyMaterial({ signature: '0x' + 'ab'.repeat(65), address: '0x' + '11'.repeat(20), body: 'gm, aping $PONS' })).toBeNull();
  });
});

describe('limits', () => {
  it('computes fixed windows', () => {
    const t = new Date('2026-11-12T10:00:42Z');
    expect(windowStart(t, 60).toISOString()).toBe('2026-11-12T10:00:00.000Z');
    expect(retryAfter(t, 60)).toBe(18);
  });
});
