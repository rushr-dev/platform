import { describe, expect, it } from 'vitest';
import { FEATURED_STOCK, isStockToken, stockCompanyName } from '../src';

const ISSUER = '0x2b94105fff37630f98e1f24811dad588fc5c3a87';

describe('isStockToken', () => {
  it('accepts the real ANT (issuer deployer + Robinhood Token name)', () => {
    expect(isStockToken({ deployer: ISSUER, name: 'Anthropic, PBC Class A Common Stock • Robinhood Token' })).toBe(true);
    expect(isStockToken({ deployer: ISSUER.toUpperCase().replace('0X', '0x'), name: 'NVIDIA • Robinhood Token' })).toBe(true);
  });
  it('rejects copies that use the same name from another deployer (prod has a fake SPY with the exact name)', () => {
    expect(isStockToken({ deployer: '0x8cc7414ac0d2183faeee8d53a689778612bf53bb', name: 'SPDR S&P 500 ETF Trust • Robinhood Token' })).toBe(false);
    expect(isStockToken({ deployer: '0xdf769057eb42b27bd7dd4c8643779f0dfe49a6a2', name: 'ANTHROPIC • Robinhood Token' })).toBe(false);
  });
  it('rejects issuer tokens without the suffix and missing data', () => {
    expect(isStockToken({ deployer: ISSUER, name: 'Something else' })).toBe(false);
    expect(isStockToken({ deployer: null, name: 'NVIDIA • Robinhood Token' })).toBe(false);
  });
});

describe('stockCompanyName', () => {
  it('drops the Robinhood Token suffix', () => {
    expect(stockCompanyName('Anthropic, PBC Class A Common Stock • Robinhood Token')).toBe('Anthropic, PBC Class A Common Stock');
    expect(stockCompanyName('Plain')).toBe('Plain');
  });
  it('features ANT', () => expect(FEATURED_STOCK).toBe('0xbbb6c29bcc3a1028a2b54310df73f4f7a3bcb373'));
});
