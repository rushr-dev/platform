import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, parseAbiParameters } from 'viem';
import { ambiguousUrls, classifyLinks, harvestPackedUrls, harvestStrings, httpCandidates, metadataUris } from '../src/ingest/metadata';

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

  // Real PONS launches (2026-11-11) whose icon we missed: image URLs without a file extension.
  it('flags extension-less image URLs for probing and never takes IPFS content for the website', () => {
    const san = ['GenAI Lab', 'https://dbk-vercel.vercel.app/api/ipfs/content/bafkreiauuwy6xnsxonm6wsrwgbrbvfzfst722x453t2jyj4kk2m6sqd5mu', 'https://x.com/genailab_/status/2120395869967257969'];
    const moneyfi = ['Money Fi', 'MONEYFI', 'https://ipfs.erebrus.io/ipfs/bafkreicisdeim44euysiebbq3r23g46dgdb33tumzw2o77ny2ervvjb4pe', 'https://x.com/moneyfihub', 'https://moneyyfi.fund/'];
    const kynetra = ['Kynetra', 'KYNETRA', 'https://api.dicebear.com/9.x/bottts/png?seed=KYNETRA'];
    expect(ambiguousUrls(san)).toEqual([san[1]]);
    expect(ambiguousUrls(moneyfi)).toEqual([moneyfi[2]]);
    expect(ambiguousUrls(kynetra)).toEqual([kynetra[2]]);
    // Once probed as images, they're the icon.
    expect(classifyLinks(san, [], { name: 'GenAI Lab', symbol: 'SAN' }, { images: [san[1]!] }).image).toBe(san[1]);
    const m = classifyLinks(moneyfi, [], { name: 'Money Fi', symbol: 'MONEYFI' }, { images: [moneyfi[2]!] });
    expect(m).toMatchObject({ image: moneyfi[2], website: 'https://moneyyfi.fund/', twitter: 'https://x.com/moneyfihub' });
    // Even unprobed (fetch failed), the gateway link is an image guess, not the website.
    const u = classifyLinks(moneyfi, [], { name: 'Money Fi', symbol: 'MONEYFI' });
    expect(u.website).toBe('https://moneyyfi.fund/');
    expect(classifyLinks(kynetra, [], { name: 'Kynetra', symbol: 'KYNETRA' }).image).toBe(kynetra[2]);
  });

  it('expands bare CIDs and other gateways to fast gateways first', () => {
    const cid = 'bafybeia4dzorezh2i2ih7kx3izz56kcp6laqnhivgqsztq5h2e436jrncu';
    expect(httpCandidates(`ipfs://${cid}`)[0]).toBe(`https://${cid}.ipfs.4everland.io/`);
    expect(httpCandidates(cid)[0]).toBe(`https://${cid}.ipfs.4everland.io/`);
    const other = `https://ipfs.erebrus.io/ipfs/${cid}/logo.png`;
    expect(httpCandidates(other)).toEqual([
      `https://${cid}.ipfs.4everland.io/logo.png`, `https://4everland.io/ipfs/${cid}/logo.png`, `https://gateway.pinata.cloud/ipfs/${cid}/logo.png`, other,
    ]);
    expect(httpCandidates('https://cdn.anoncoin.it/x/token-metadata.json')).toEqual(['https://cdn.anoncoin.it/x/token-metadata.json']);
  });

  it('reads Clanker metadata() JSON (socialMediaUrls)', () => {
    // Real Clanker token on Robinhood Chain: imageUrl() is a separate getter, metadata() carries socials.
    const doc = JSON.parse('{"description":"x","socialMediaUrls":[{"platform":"x","url":"https://x.com/clanker"}],"auditUrls":[]}');
    expect(classifyLinks([], [doc, { image: 'https://clankerworld.mypinata.cloud/ipfs/bafkreiaynhbpaxpbiq263vbqlmvfz2vljeqeyc3ai5bjcoeo5yb3jmcfuu' }], { name: 'Anthropic', symbol: 'Anthropic' }))
      .toMatchObject({ image: 'https://clankerworld.mypinata.cloud/ipfs/bafkreiaynhbpaxpbiq263vbqlmvfz2vljeqeyc3ai5bjcoeo5yb3jmcfuu', twitter: 'https://x.com/clanker' });
  });

  it('reads length-prefixed URLs from launch-bot calldata', () => {
    // Shape of a real GASSED launch through a bot router (2026-11-12): <len><url><len><url>, no ABI encoding.
    const enc = (t: string) => Buffer.from(t, 'latin1').toString('hex');
    const img = 'https://pbs.twimg.com/media/HW4-YUBXEAAIkEz.jpg';
    const tweet = 'https://x.com/meadgod/status/2120709746537779574';
    const ipfs = 'ipfs://bafkreigwm4l7g2c52dke4kh6mkfyefzoejkmlyxtznmbpd4hlg5vmvjw2y';
    const hex = `0x0102${enc('Gassed Up')}${img.length.toString(16)}${enc(img)}${tweet.length.toString(16)}${enc(tweet)}${ipfs.length.toString(16)}${enc(ipfs)}ff00`;
    expect(img.length).toBe(0x2f); // '/' in the printable dump
    expect(harvestPackedUrls(hex)).toEqual([img, tweet, ipfs]);
    expect(classifyLinks(harvestPackedUrls(hex), [], { name: 'Gassed Up', symbol: 'GASSED' })).toMatchObject({ image: img, twitter: tweet });
  });
});
