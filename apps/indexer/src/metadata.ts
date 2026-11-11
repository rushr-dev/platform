import type { Sql } from 'postgres';
import { decodeFunctionResult, encodeFunctionData, parseAbi, type Hex } from 'viem';
import { classifyLinks, harvestStrings, httpCandidates, metadataUris } from '@rushr/core';
import type { Rpc } from './rpc';

const GETTERS = parseAbi(['function tokenURI() view returns (string)', 'function description() view returns (string)']);
const FETCH_TIMEOUT_MS = 4_000;

interface RawTx {
  input: Hex;
}
interface RawReceipt {
  logs: { data: Hex }[];
}

/**
 * Resolve a token's icon, socials and description from its launchpad data and store them.
 * Safe to re-run: existing values are only replaced by non-empty ones.
 */
export async function resolveMetadata(sql: Sql, rpc: Rpc, token: string): Promise<boolean> {
  const [row] = await sql<{ name: string; symbol: string; created_block: string }[]>`
    select name, symbol, created_block from tokens where address = ${token}`;
  if (!row) return false;
  const block = BigInt(row.created_block);

  // The creation tx is the one where the token contract first emitted a log (its mint).
  const logs = await rpc.call<{ transactionHash: Hex }[]>('eth_getLogs', [
    { fromBlock: `0x${(block - 1n).toString(16)}`, toBlock: `0x${(block + 1n).toString(16)}`, address: token },
  ]);
  const hash = logs[0]?.transactionHash;

  const strings: string[] = [];
  if (hash) {
    const [tx, receipt] = await rpc.batch<RawTx | RawReceipt>([
      { method: 'eth_getTransactionByHash', params: [hash] },
      { method: 'eth_getTransactionReceipt', params: [hash] },
    ]);
    if (tx && 'input' in tx) strings.push(...harvestStrings(tx.input));
    if (receipt && 'logs' in receipt) for (const l of receipt.logs) strings.push(...harvestStrings(l.data));
  }
  // Getters some launchpads expose on the token itself. tokenURI (Doppler) always points at JSON.
  const [uriRaw, descRaw] = await rpc.batch<Hex>(
    (['tokenURI', 'description'] as const).map((fn) => ({
      method: 'eth_call',
      params: [{ to: token, data: encodeFunctionData({ abi: GETTERS, functionName: fn }) }, 'latest'],
    })),
  );
  const uris = new Set<string>();
  if (uriRaw && uriRaw !== '0x') {
    try {
      const u = decodeFunctionResult({ abi: GETTERS, functionName: 'tokenURI', data: uriRaw });
      if (u) uris.add(u);
    } catch {
      // not a string-returning tokenURI
    }
  }
  if (descRaw && descRaw !== '0x') strings.push(...harvestStrings(descRaw));
  for (const u of metadataUris(strings)) uris.add(u);

  const docs: Record<string, unknown>[] = [];
  for (const uri of [...uris].slice(0, 2)) {
    const doc = await fetchJson(uri);
    if (doc) docs.push(doc);
  }

  const links = classifyLinks(strings, docs, { name: row.name, symbol: row.symbol });
  await sql`
    update tokens set
      image_url = coalesce(${links.image}, image_url),
      website = coalesce(${links.website}, website),
      twitter = coalesce(${links.twitter}, twitter),
      telegram = coalesce(${links.telegram}, telegram),
      description = coalesce(${links.description}, description),
      metadata_at = now()
    where address = ${token}`;
  return Boolean(links.image || links.website || links.twitter || links.telegram);
}

/** Fetch a metadata document, trying each gateway for ipfs:// links. Data URIs are decoded inline. */
async function fetchJson(uri: string): Promise<Record<string, unknown> | null> {
  const inline = uri.match(/^data:application\/json(;base64)?,(.*)$/i);
  if (inline) {
    try {
      return asObject(JSON.parse(inline[1] ? atob(inline[2]!) : decodeURIComponent(inline[2]!)));
    } catch {
      return null;
    }
  }
  for (const url of httpCandidates(uri)) {
    if (!/^https:\/\//i.test(url)) continue;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: 'application/json' } });
      if (!res.ok) continue;
      const text = await res.text();
      if (text.length > 200_000) continue;
      const obj = asObject(JSON.parse(text));
      if (obj) return obj;
    } catch {
      // try the next gateway
    }
  }
  return null;
}

function asObject(j: unknown): Record<string, unknown> | null {
  return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
}
