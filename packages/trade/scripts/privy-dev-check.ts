/**
 * Live check of the one-click signer design against Privy's API with a Privy DEV app.
 * SIGNING ONLY: it calls eth_signTransaction and never broadcasts (no eth_sendTransaction, no RPC send).
 * The test wallet holds no funds. Keys are throwaway P-256 keys generated in memory for this run:
 * - "user" key  -> simulates the end user's owner key quorum (owns the wallet and the policy);
 * - "rushr" key -> Rushr's authorization key (session signer with the policy);
 * - "agent" key -> a second signer, to test revoking one signer at a time.
 *
 *   RUSHR_MAIN_CHECKOUT=/path/to/main/checkout pnpm --filter @rushr/trade exec tsx scripts/privy-dev-check.ts
 *
 * Credentials come from <main>/apps/indexer/.dev.vars.privy (PRIVY_APP_ID, PRIVY_APP_SECRET) and are
 * never printed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { encodeFunctionData, parseTransaction, recoverTransactionAddress, toHex, zeroAddress, type Address, type Hex } from 'viem';
import { buildDailyValueAggregation, buildSignerPolicy, defaultCaps } from '../src/policy';
import { rushrRouterAbi } from '../src/rushr-router';
import { signPrivyRequest, WebCryptoAuthorizationKey, type AuthorizationKey } from '../src/signer';

const API = 'https://api.privy.io';
// RushrRouter is not deployed: the policy allowlists this stand-in address (no code anywhere).
const TEST_ROUTER: Address = '0x00000000000000000000000000000000000057a9';
const PONS: Address = '0x39dbed3a2bd333467115de45665cc57f813c4571';
const WETH: Address = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';

function creds(): { appId: string; appSecret: string } {
  const main = process.env.RUSHR_MAIN_CHECKOUT;
  if (!main) throw new Error('set RUSHR_MAIN_CHECKOUT');
  const vars = fs.readFileSync(path.join(main, 'apps/indexer/.dev.vars.privy'), 'utf8');
  const get = (k: string) => vars.match(new RegExp(`^${k}\\s*=\\s*"?([^"\\n]+)"?`, 'm'))?.[1]?.trim();
  const appId = get('PRIVY_APP_ID');
  const appSecret = get('PRIVY_APP_SECRET');
  if (!appId || !appSecret) throw new Error('PRIVY_APP_ID / PRIVY_APP_SECRET missing');
  return { appId, appSecret };
}
const { appId, appSecret } = creds();

async function newKey(): Promise<{ key: AuthorizationKey; publicKey: string }> {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey));
  return { key: new WebCryptoAuthorizationKey(kp.privateKey), publicKey: btoa(String.fromCharCode(...spki)) };
}

/** Never logs credentials or keys; errors show status and Privy's message only. */
async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', p: string, body?: unknown, keys: AuthorizationKey[] = []) {
  const url = `${API}${p}`;
  const t0 = performance.now();
  let res: Response;
  if (method === 'GET') {
    res = await fetch(url, { headers: { authorization: `Basic ${btoa(`${appId}:${appSecret}`)}`, 'privy-app-id': appId } });
  } else {
    const { init } = await signPrivyRequest({ method, url, body: body ?? {}, appId, appSecret, keys, expiryMs: Date.now() + 60_000 });
    res = await fetch(url, init);
  }
  const ms = Math.round(performance.now() - t0);
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, ok: res.ok, json: json as Record<string, unknown> | null, text: text.slice(0, 300), ms };
}

const results: { name: string; expected: string; got: string; pass: boolean; ms?: number }[] = [];
function record(name: string, expected: 'allow' | 'deny', r: { ok: boolean; status: number; text: string; ms: number }) {
  const got = r.ok ? 'allow' : 'deny';
  results.push({ name, expected, got: `${got} (${r.status}${r.ok ? '' : `: ${r.text.replace(/\s+/g, ' ').slice(0, 140)}`})`, pass: got === expected, ms: r.ms });
}

const tx = (to: Address, data: Hex, valueWei: bigint, chainId = 4663, nonce = 0) => ({
  method: 'eth_signTransaction',
  params: { transaction: { to, data, value: toHex(valueWei), chain_id: chainId, nonce, gas_limit: 400_000, max_fee_per_gas: 100_000_000, max_priority_fee_per_gas: 0, type: 2 } },
});

const route = { kind: 1, token: PONS, quote: WETH, fee: 3000, tickSpacing: 0, hooks: zeroAddress };
const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
const buyData = encodeFunctionData({ abi: rushrRouterAbi, functionName: 'buy', args: [route, 1n, deadline, false] });
const sellData = encodeFunctionData({ abi: rushrRouterAbi, functionName: 'sell', args: [route, 10n ** 18n, 1n, deadline, false] });
const sellAnyData = encodeFunctionData({ abi: rushrRouterAbi, functionName: 'sellAnyPool', args: [route, 10n ** 18n, 1n, deadline, false] });
const approve = (spender: Address) =>
  encodeFunctionData({ abi: [{ type: 'function', name: 'approve', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' }], functionName: 'approve', args: [spender, 2n ** 256n - 1n] });
const E = (eth: number) => BigInt(Math.round(eth * 1e6)) * 10n ** 12n;

async function main() {
  const user = await newKey();
  const rushr = await newKey();
  const agent = await newKey();

  const q = async (label: string, pub: string) => {
    const r = await call('POST', '/v1/key_quorums', { public_keys: [pub], authorization_threshold: 1, display_name: label });
    if (!r.ok) throw new Error(`key quorum ${label}: ${r.status} ${r.text}`);
    return (r.json as { id: string }).id;
  };
  const userQ = await q('rushr-test-user', user.publicKey);
  const rushrQ = await q('rushr-test-signer', rushr.publicKey);
  const agentQ = await q('rushr-test-agent', agent.publicKey);
  console.log('key quorums created (user, rushr, agent)');

  const agg = await call('POST', '/v1/aggregations', buildDailyValueAggregation(`rushr-test 24h ${Date.now()}`));
  if (!agg.ok) throw new Error(`aggregation: ${agg.status} ${agg.text}`);
  const aggId = (agg.json as { id: string }).id;
  console.log('aggregation created');

  const now = Math.floor(Date.now() / 1000);
  const policyBody = buildSignerPolicy({ purpose: 'quick-trade-test', wallet: zeroAddress, rushrRouter: TEST_ROUTER, caps: defaultCaps(now), dailyAggregationId: aggId, ownerId: userQ });
  const pol = await call('POST', '/v1/policies', policyBody);
  if (!pol.ok) throw new Error(`policy: ${pol.status} ${pol.text}`);
  const policyId = (pol.json as { id: string }).id;
  console.log(`policy created, owner_id = user quorum: ${(pol.json as { owner_id?: string }).owner_id === userQ}`);

  const w = await call('POST', '/v1/wallets', {
    chain_type: 'ethereum',
    owner_id: userQ,
    additional_signers: [
      { signer_id: rushrQ, override_policy_ids: [policyId] },
      { signer_id: agentQ, override_policy_ids: [policyId] },
    ],
  });
  if (!w.ok) throw new Error(`wallet: ${w.status} ${w.text}`);
  const wallet = w.json as { id: string; address: Address };
  console.log(`wallet created ${wallet.address} (no funds)`);

  const rpc = (body: unknown, keys: AuthorizationKey[]) => call('POST', `/v1/wallets/${wallet.id}/rpc`, body, keys);

  // (a) allowed RushrRouter.buy, signed by the session signer
  const a = await rpc(tx(TEST_ROUTER, buyData, E(0.01)), [rushr.key]);
  record('RushrRouter.buy 0.01 ETH (session signer)', 'allow', a);
  if (a.ok) {
    const signed = (a.json as { data: { signed_transaction: Hex } }).data.signed_transaction;
    const parsed = parseTransaction(signed);
    const from = await recoverTransactionAddress({ serializedTransaction: signed as never });
    console.log(`  signed tx: chainId ${parsed.chainId}, to ${parsed.to}, from ${from} (= wallet: ${from.toLowerCase() === wallet.address.toLowerCase()}). NOT broadcast.`);
  }
  // (b) denied: plain ETH transfer
  record('plain ETH transfer 0.01 ETH', 'deny', await rpc(tx('0x000000000000000000000000000000000000dEaD', '0x', E(0.01)), [rushr.key]));
  record('RushrRouter.sell (value 0)', 'allow', await rpc(tx(TEST_ROUTER, sellData, 0n), [rushr.key]));
  record('RushrRouter.sellAnyPool (user-only)', 'deny', await rpc(tx(TEST_ROUTER, sellAnyData, 0n), [rushr.key]));
  record('RushrRouter.buy 0.30 ETH (> 0.25 cap)', 'deny', await rpc(tx(TEST_ROUTER, buyData, E(0.3)), [rushr.key]));
  record('RushrRouter.buy on chain 1', 'deny', await rpc(tx(TEST_ROUTER, buyData, E(0.01), 1), [rushr.key]));
  record('RushrRouter.sell with ETH value', 'deny', await rpc(tx(TEST_ROUTER, sellData, E(0.01)), [rushr.key]));
  record('approve(RushrRouter) on a token', 'allow', await rpc(tx(PONS, approve(TEST_ROUTER), 0n), [rushr.key]));
  record('approve(other spender)', 'deny', await rpc(tx(PONS, approve('0x000000000000000000000000000000000000bEEF'), 0n), [rushr.key]));
  record('call to another contract', 'deny', await rpc(tx(WETH, buyData, E(0.01)), [rushr.key]));
  record('no authorization signature', 'deny', await rpc(tx(TEST_ROUTER, buyData, E(0.01)), []));

  // Rolling 24 h cap: 0.01 + 0.25 per buy until denied (cap 1 ETH).
  let sum = 0.01 + 0;
  let firstDenied: number | null = null;
  for (let i = 0; i < 6; i++) {
    const r = await rpc(tx(TEST_ROUTER, buyData, E(0.25), 4663, i + 1), [rushr.key]);
    if (!r.ok) {
      firstDenied = sum;
      results.push({ name: `24h cap: buy #${i + 1} of 0.25 after ${sum.toFixed(2)} ETH signed`, expected: 'deny when sum would pass 1 ETH', got: `deny (${r.status})`, pass: sum + 0.25 > 1, ms: r.ms });
      break;
    }
    sum += 0.25;
  }
  if (firstDenied === null) results.push({ name: '24h cap', expected: 'deny by ~1 ETH', got: `never denied (sum ${sum})`, pass: false });

  // Q2: can Rushr (app secret, or app secret + its authorization key) loosen the user-owned policy?
  const loosen = { rules: [{ name: 'allow everything', method: 'eth_signTransaction', conditions: [{ field_source: 'ethereum_transaction', field: 'chain_id', operator: 'eq', value: '4663' }], action: 'ALLOW' }] };
  record('PATCH policy with app secret only', 'deny', await call('PATCH', `/v1/policies/${policyId}`, loosen, []));
  record('PATCH policy with Rushr authorization key', 'deny', await call('PATCH', `/v1/policies/${policyId}`, loosen, [rushr.key]));
  record('PATCH wallet signers with Rushr key (add itself unrestricted)', 'deny', await call('PATCH', `/v1/wallets/${wallet.id}`, { additional_signers: [{ signer_id: rushrQ }] }, [rushr.key]));

  // Q3: revoke one signer (agent) with the owner's key, keep the other.
  record('agent signer before revoke', 'allow', await rpc(tx(TEST_ROUTER, sellData, 0n), [agent.key]));
  const revoke = await call('PATCH', `/v1/wallets/${wallet.id}`, { additional_signers: [{ signer_id: rushrQ, override_policy_ids: [policyId] }] }, [user.key]);
  record('owner removes only the agent signer', 'allow', revoke);
  record('agent signer after revoke', 'deny', await rpc(tx(TEST_ROUTER, sellData, 0n), [agent.key]));
  record('Rushr signer after agent revoke', 'allow', await rpc(tx(TEST_ROUTER, sellData, 0n), [rushr.key]));

  // Owner (user) can always sign anything (e.g. a withdrawal), outside the signer policy.
  record('owner key signs a plain transfer (withdrawal path)', 'allow', await rpc(tx('0x000000000000000000000000000000000000dEaD', '0x', E(0.01)), [user.key]));

  console.log('\nresults:');
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name.padEnd(62)} expected ${r.expected.padEnd(6)} got ${r.got}${r.ms ? `  ${r.ms} ms` : ''}`);
  const signMs = results.filter((r) => r.ms && r.got.startsWith('allow') && r.name.includes('Router')).map((r) => r.ms!);
  if (signMs.length) console.log(`\nallowed sign latency (from this machine): min ${Math.min(...signMs)} ms, median ${signMs.sort((x, y) => x - y)[Math.floor(signMs.length / 2)]} ms`);
  console.log(`\ntest artifacts (dev app): wallet ${wallet.id}, policy ${policyId}, aggregation ${aggId}`);
  process.exitCode = results.every((r) => r.pass) ? 0 : 1;
}

main().catch((e) => {
  console.error('check failed:', String((e as Error).message ?? e).replace(/Basic [A-Za-z0-9+/=]+/g, 'Basic <redacted>'));
  process.exitCode = 1;
});
