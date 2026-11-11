import { createPublicClient, http, hexToString, parseAbi } from 'viem';
const c = createPublicClient({ transport: http(process.env.RPC!) });
const toks: Record<string, [string, bigint]> = {
  doppler: ['0x729aa4c5b7525aec02823d923b975adbeda8d09e', 111593646n],
  lift: ['0xbba12262192bba147c1ad88c65a05d07a7390087', 111595724n],
  pons: ['0x9471a5ee29e31afce383da2e81ecd1e95e93a391', 111599095n],
  v4: ['0x44fa91a1734b391c51aa93adc68db3a158b32beb', 111599187n],
};
const fns = ['tokenURI', 'uri', 'metadataURI', 'metadataUri', 'image', 'imageURI', 'website', 'twitter', 'telegram', 'description', 'contractURI', 'tokenInfo'];
const printable = (hex: string) => {
  const s = Buffer.from(hex.slice(2), 'hex').toString('latin1');
  return (s.match(/[\x20-\x7e]{6,}/g) ?? []).join(' | ');
};
for (const [pad, [addr, block]] of Object.entries(toks)) {
  console.log('==', pad, addr);
  for (const f of fns) {
    try {
      const r = await c.readContract({ address: addr as `0x${string}`, abi: parseAbi([`function ${f}() view returns (string)`]), functionName: f });
      console.log('  fn', f, '=>', String(r).slice(0, 300));
    } catch {}
  }
  // strings in the creation-block logs that mention this token
  const logs = await c.getLogs({ fromBlock: block - 2n, toBlock: block + 2n });
  for (const l of logs) {
    if (!l.topics.some((t) => t?.toLowerCase().includes(addr.slice(2))) && !l.data.toLowerCase().includes(addr.slice(2))) continue;
    const p = printable(l.data);
    if (p) console.log('  log', l.address, l.topics[0]?.slice(0, 10), '=>', p.slice(0, 600));
  }
  // creation tx input strings
  const tx = logs.find((l) => l.topics.some((t) => t?.toLowerCase().includes(addr.slice(2))))?.transactionHash;
  if (tx) {
    const t = await c.getTransaction({ hash: tx });
    console.log('  txinput =>', printable(t.input).slice(0, 800));
  }
}
