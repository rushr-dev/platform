// Agent buy honeypot check (src/agents/honeypot.ts): curve exemption and the pass cache's lifetime.
import { beforeEach, describe, expect, it } from 'vitest';
import { PASS_TTL_MS, checkBuy, resetHoneypotCache } from '../src/agents/honeypot';

const pass = { buyOk: true, sellOk: true, buyTaxBps: 0, sellTaxBps: 100, roundTripBps: 9800, honeypot: false };

describe('checkBuy', () => {
  beforeEach(() => resetHoneypotCache());
  it('exempts PONS curve quotes without probing', async () => {
    let n = 0;
    expect(await checkBuy('0xA', 'pons-curve', async () => (n++, pass))).toMatchObject({ checked: 'exempt' });
    expect(n).toBe(0);
  });
  it('caches a pass for 10 minutes, then probes again', async () => {
    let n = 0;
    const probe = async () => (n++, pass);
    await checkBuy('0xA', 'uniswap-v4', probe, 0);
    expect((await checkBuy('0xa', 'uniswap-v4', probe, PASS_TTL_MS - 1)).checked).toBe('cached');
    expect((await checkBuy('0xa', 'uniswap-v4', probe, PASS_TTL_MS)).checked).toBe('probe');
    expect(n).toBe(2);
  });
  it('does not cache failures', async () => {
    let n = 0;
    const probe = async () => (n++, { ...pass, buyOk: false, sellOk: false });
    await expect(checkBuy('0xb', 'uniswap-v4', probe)).rejects.toMatchObject({ code: 'safety_unverified', status: 503 });
    await expect(checkBuy('0xb', 'uniswap-v4', probe)).rejects.toMatchObject({ code: 'safety_unverified' });
    expect(n).toBe(2);
  });
});
