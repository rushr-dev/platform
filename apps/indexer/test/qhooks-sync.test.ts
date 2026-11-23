import { describe, expect, it } from 'vitest';
import { qhooksMarket, qhooksUpdate } from '../src/qhooks-sync';

const base = {
  chainId: '4663',
  token: '0xEBF69BB14D80E7C68F648FBAE6050494923E480F',
  poolId: '0x084a4faeaff8bf8105c72974b33a1aca37cdc4f29bcb27ea7c2512e1f1f12a6f',
  key: { hooks: '0x34ac8c4e6ca3d5b70a5321b648d0db9451c060cc' },
  progressBps: 1744,
  targetBps: 8000,
  bonded: false,
};

describe('QHooks launch sync', () => {
  it('turns progress into a 0..1 share of the bonding target', () => {
    const u = qhooksUpdate(base)!;
    expect(u.token).toBe('0xebf69bb14d80e7c68f648fbae6050494923e480f');
    expect(u.progress).toBeCloseTo(0.218, 3);
    expect(u.bonded).toBe(false);
    expect(u.hook).toBe('0x34ac8c4e6ca3d5b70a5321b648d0db9451c060cc');
  });

  it('counts a bonded launch as fully bonded, with its bond time', () => {
    const u = qhooksUpdate({ ...base, progressBps: 9090, bonded: true, bondedAt: 1794000000 })!;
    expect(u.progress).toBe(1);
    expect(u.bondedAt?.getTime()).toBe(1794000000 * 1000);
  });

  it('takes the token image as an absolute URL, never a data: URI', () => {
    expect(qhooksUpdate({ ...base, logo: '/api/token-profiles/4663/0xebf6/image?v=1' })!.image).toBe('https://qhooks.com/api/token-profiles/4663/0xebf6/image?v=1');
    expect(qhooksUpdate({ ...base, logo: 'https://qhooks.com/qhooks-logo.jpg' })!.image).toBe('https://qhooks.com/qhooks-logo.jpg');
    expect(qhooksUpdate({ ...base, logo: 'data:image/jpeg;base64,AAAA' })!.image).toBeNull();
    expect(qhooksUpdate({ ...base, links: { website: 'https://qhooks.com', x: 'javascript:1' } })).toMatchObject({ website: 'https://qhooks.com', twitter: null });
  });

  it('caps progress at 1 and ignores other chains and bad addresses', () => {
    expect(qhooksUpdate({ ...base, progressBps: 9000 })!.progress).toBe(1);
    expect(qhooksUpdate({ ...base, chainId: '8453' })).toBeNull();
    expect(qhooksUpdate({ ...base, token: 'not-an-address' })).toBeNull();
  });

  it('reads an auction-style market: token, both pool hooks, image', () => {
    const m = qhooksMarket({
      meta: {
        token: '0x965C490D5C501A500B7152629AF87DB50EC62AC3',
        pools: [
          { key: { hooks: '0x08a7c13fd8bfeae5726abd8332c627a7ab01eacc' } },
          { key: { hooks: '0xa484309dcc556bb9e1c4d6e94c369cb5cb102acc' } },
          { key: { hooks: '0x0000000000000000000000000000000000000000' } },
        ],
        logo: '/api/token-profiles/4663/0x965c/image?v=2',
      },
    })!;
    expect(m.token).toBe('0x965c490d5c501a500b7152629af87db50ec62ac3');
    expect(m.hooks).toEqual(['0x08a7c13fd8bfeae5726abd8332c627a7ab01eacc', '0xa484309dcc556bb9e1c4d6e94c369cb5cb102acc']);
    expect(m.image).toBe('https://qhooks.com/api/token-profiles/4663/0x965c/image?v=2');
    expect(qhooksMarket({ meta: { token: 'solana-mint' } })).toBeNull();
  });
});
