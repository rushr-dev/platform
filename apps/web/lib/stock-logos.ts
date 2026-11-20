/**
 * Logos for Robinhood's tokenized stocks, by token address (only the verified stock tokens, see
 * packages/core/src/stocks.ts, so a copycat token with the same ticker never gets a real company's logo).
 * Files live in public/stock-logos/<TICKER>.png: 128px tiles, company logos from public stock-logo data
 * (financialmodelingprep image-stock), checked by eye on 2026-11-20. FLY and GME are left out (the source
 * image was the wrong company or cropped). Shown before the token's own image, which for these tokens is Robinhood's generic token icon.
 */
const STOCK_LOGOS: Record<string, string> = {
  '0x521cf887e6531c6f667b5bc4d896e5d9bfe8eb2e': 'AAOI',
  '0xaf3d76f1834a1d425780943c99ea8a608f8a93f9': 'AAPL',
  '0x12f190a9f9d7d37a250758b26824b97ce941bf54': 'AMZN',
  '0xbbb6c29bcc3a1028a2b54310df73f4f7a3bcb373': 'ANT',
  '0xa249baf1063af884807c1e1400aef7784836917e': 'APP',
  '0x1af6446f07eb1d97c546afc8c9544cbdf3ad5137': 'ASTS',
  '0x373c06c4f7bde527d7dae4ba169e42b55e393ced': 'AUR',
  '0x48e39e56acdba37b09020c0b734a613c9a2f100a': 'BB',
  '0x822cc93ffd030293e9842c30bbd678f530701867': 'BE',
  '0x9a7842eded60b0fe1e03eec342c82a397c821ed0': 'BMNR',
  '0xdf0992e440dd0be65bd8439b609d6d4366bf1cb5': 'CRCL',
  '0x5f10a1c971b69e47e059e1dc91901b59b3fb49c3': 'CRWV',
  '0x27c99fbde9d0d2aa4f4bfb4943f237843ddf6958': 'DDOG',
  '0x501b1b3b79750313ad2c4cccd08586c4c17d7283': 'DIS',
  '0x9ece29a4a2397c0a35fb5fa8ee2b9509130a98cc': 'FISV',
  '0x3fb8976980d486084b2eb4a404bd12e72823958f': 'FTNT',
  '0xbdfa7a06458aa26b8e736e0fc87ad37c3bb8ac2e': 'GDX',
  '0xc9a981fee1f9dec688bb123ccdecc63d0debfc4e': 'GLD',
  '0x2d427692e928fa156ec22acfabafa0447c5805b7': 'GLXY',
  '0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3': 'GOOGL',
  '0xeb61c0ed490a367d4e3631ccf8a74b3bfc7e775d': 'HII',
  '0xccee82fe024c36fa15e1005ede3e9e4787e23d09': 'HIMS',
  '0x59dd09d4900c2e4b5f75b7c0d4e6796fcc234cb1': 'HPE',
  '0xacef2e09adb47ad6abebad9ff06689e60615c2b6': 'INDA',
  '0xc72b96e0e48ecd4dc75e1e45396e26300bc39681': 'INTC',
  '0x07c44da0848960bff894f17584db8b2f60b2409e': 'JPM',
  '0x8005d266423c7ea827372c9c864491e5786600ea': 'LLY',
  '0xc0d6457c16cc70d6790dd43521c899c87ce02f35': 'META',
  '0x43b07d15ce533bec5476d70c22a78a1b2b662155': 'MRNA',
  '0xec262a75e413fafd0df80480274532c79d42da09': 'MSTR',
  '0xff080c8ce2e5feadaca0da81314ae59d232d4afd': 'MU',
  '0x116f00968269b7bfbad4109ce591d6e74c0601d4': 'NET',
  '0xbef75684c43c4ea7bd18dd532a2244674ee8b926': 'NNE',
  '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec': 'NVDA',
  '0xb039597ed45cba7b6e2fb9e8be51802969cee5be': 'PANW',
  '0x9b23573b156b52565012f5ce02cdf60afbaa70be': 'PENG',
  '0x7066a64c24e4206cd62e83bf198c1e7eb361f51e': 'PFE',
  '0x894e1ec2d74ffe5aef8dc8a9e84686accb964f2a': 'PLTR',
  '0xa45abdc77918f7b9199b022eee400c0bc5712bd2': 'PYPL',
  '0xc583c60aef9dc401da72cec1b404743a93cea1cc': 'QBTS',
  '0xd5f3879160bc7c32ebb4dc785f8a4f505888de68': 'QQQ',
  '0xfde6b5d9bb419b10c23268c74e369abff39c0460': 'RCAT',
  '0x756bc80af765c82da966a788858d65adf14f3793': 'RUN',
  '0x411efb0e7f985935daec3d4c3ebaea0d0ad7d89f': 'SLV',
  '0x1eebee7f74517e0279dfb09d25b0407beec3fdd6': 'SMR',
  '0xb90a19ff0af67f7779aff50a882a9cff42446400': 'SNDK',
  '0xba0cab75495255d0cb58e22b648bfed4ecd1f47e': 'SNOW',
  '0x98e75885157c80992a8d41b696d8c9c6fb30a926': 'SOFI',
  '0x6e3dfd9f7e1649baa14d25cac18c94d62db10a54': 'SOUN',
  '0x117cc2133c37b721f49de2a7a74833232b3b4c0c': 'SPY',
  '0xb1969f6604ca1ae7a2cd3f1827876e914594ca2d': 'TE',
  '0x322f0929c4625ed5bad873c95208d54e1c003b2d': 'TSLA',
  '0x58ffe4a942d3885baa22d7520691f611ef09e7aa': 'TSM',
  '0x0b5fb4031cae9163db10b169ee72685f0edc8545': 'TTD',
  '0x5e81213613b6b86eab4c6c50d718d34359459786': 'TTWO',
  '0xbd335aa5a1693f0121a5c0ef18a080e9958da78b': 'UBER',
  '0xa30fa36db767ad9ed3f7a60fc79526fb4d56d344': 'USO',
  '0x9bff87700337babf5099e99f322f888dafb1d551': 'V',
  '0x26dcbfb34fc83cabd6990f449674efdc6097ff85': 'VSAT',
  '0xf52597345a8edf418bc4071b4a35112472277d3e': 'WDC',
  '0x44c4f142009036cf477ed2d09932051843137cf1': 'ZM',
};

/** Our hosted logo for a stock token, or null. */
export function stockLogo(address: string | null | undefined): string | null {
  const t = address ? STOCK_LOGOS[address.toLowerCase()] : undefined;
  return t ? `/stock-logos/${t}.png` : null;
}
