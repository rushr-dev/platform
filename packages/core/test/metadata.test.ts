import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, parseAbiParameters } from 'viem';
import { classifyLinks, harvestStrings, metadataUris } from '../src/ingest/metadata';

describe('token metadata', () => {
  it('harvests strings from a PONS-style creation call', () => {
    const data = encodeAbiParameters(
      parseAbiParameters('uint256 a, (string name, string symbol, string image, string description) t, string[] socials'),
      [
        5n,
        { name: 'ChatFrom', symbol: 'CHAT', image: 'ipfs://bafybeifgef24tdpe6cmql6cp', description: 'Chat with anyone, from anywhere' },
        ['https://x.com/ChatFrom_io', '', 'https://t.me/chatfrom', 'https://chatfrom.io'],
      ],
    );
    // Real calldata starts with a 4-byte selector, which shifts every word.
    const strings = harvestStrings(`0xf85f8e41${data.slice(2)}`);
    expect(strings).toContain('ChatFrom');
    expect(strings).toContain('https://x.com/ChatFrom_io');
    const links = classifyLinks(strings, [], { name: 'ChatFrom', symbol: 'CHAT' });
    expect(links).toEqual({
      image: 'ipfs://bafybeifgef24tdpe6cmql6cp',
      website: 'https://chatfrom.io',
      twitter: 'https://x.com/ChatFrom_io',
      telegram: 'https://t.me/chatfrom',
      description: 'Chat with anyone, from anywhere',
    });
  });

  it('reads lift.fun and Doppler JSON shapes, JSON first', () => {
    const lift = { name: 'Elysigrow', image: 'https://api.lift.fun/api/v1/images/8a35', website: '', x: 'https://x.com/Elysigrow', telegram: '' };
    expect(classifyLinks([], [lift], { name: 'Elysigrow', symbol: 'ELYSIGROW' })).toMatchObject({
      image: 'https://api.lift.fun/api/v1/images/8a35',
      twitter: 'https://x.com/Elysigrow',
      telegram: null,
      website: null,
    });
    const doppler = {
      image: 'https://cdn.anoncoin.it/abc/image.png',
      social_links: [{ label: 'Website', url: 'https://anoncoin.it/coin/0x72' }, { label: 'X', url: 'https://x.com/mihaow' }],
      extensions: { telegram: '@mihaow' },
    };
    expect(classifyLinks([], [doppler], { name: 'ni hao cat', symbol: 'MIHAOW' })).toMatchObject({
      image: 'https://cdn.anoncoin.it/abc/image.png',
      website: 'https://anoncoin.it/coin/0x72',
      twitter: 'https://x.com/mihaow',
      telegram: 'https://t.me/mihaow',
    });
  });

  it('spots metadata URIs to follow', () => {
    expect(
      metadataUris(['https://api.lift.fun/api/v1/metadata/5004', 'https://cdn.anoncoin.it/6af/token-metadata.json', 'https://x.com/a', 'hello']),
    ).toEqual(['https://api.lift.fun/api/v1/metadata/5004', 'https://cdn.anoncoin.it/6af/token-metadata.json']);
  });
});
