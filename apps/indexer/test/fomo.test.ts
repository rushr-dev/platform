import { describe, expect, it } from 'vitest';
import { thesisBody, toRow, type FomoAlert } from '../src/fomo';

const base: FomoAlert = {
  id: 'alrt_1',
  type: 'thesis',
  trader: 'CryptoBuck_',
  userId: 'u1',
  tokenAddress: '0x7FE995A80075DF3DC8AE11A9B82C7FE4202CD87F',
  chainId: 4663,
  usdValue: null,
  text: 'CryptoBuck_ posted a thesis on $HMM: Slowly then all at once.',
  ts: 1795353285000,
  avatar: null,
};

describe('fomo alerts', () => {
  it('strips the thesis prefix', () => {
    expect(thesisBody(base.text)).toBe('Slowly then all at once.');
    expect(thesisBody('no prefix here')).toBe('no prefix here');
    expect(thesisBody('')).toBeNull();
  });

  it('maps a Robinhood thesis to a row with a lowercase token', () => {
    const r = toRow(base)!;
    expect(r.kind).toBe('thesis');
    expect(r.token).toBe('0x7fe995a80075df3dc8ae11a9b82c7fe4202cd87f');
    expect(r.body).toBe('Slowly then all at once.');
    expect(r.ts.toISOString()).toBe(new Date(1795353285000).toISOString());
  });

  it('keeps buys with their position size', () => {
    const r = toRow({ ...base, type: 'buy', text: 'X bought $HMM ($2K size)', usdValue: 1933.19, positionValueUsd: 1933.19 })!;
    expect(r.kind).toBe('buy');
    expect(r.usd).toBe(1933.19);
  });

  it('drops other chains, other types and perps without a token', () => {
    expect(toRow({ ...base, chainId: 1399811149 })).toBeNull();
    expect(toRow({ ...base, type: 'perp' })).toBeNull();
    expect(toRow({ ...base, tokenAddress: null })).toBeNull();
  });

  it('only keeps https avatars', () => {
    expect(toRow({ ...base, avatar: 'javascript:alert(1)' })!.avatar_url).toBeNull();
    expect(toRow({ ...base, avatar: 'https://x.test/a.jpg' })!.avatar_url).toBe('https://x.test/a.jpg');
  });
});
