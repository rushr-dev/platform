/**
 * Read-only research script: would an EIP-7702 batch let a wallet pay a fee and trade on a PONS curve
 * in ONE transaction? The test address is given the 7702 delegation designator (0xef0100 ‖ delegate)
 * as a state override in eth_simulateV1. It then calls its own executeBatch with
 * [fee transfer, curve.buy], then [approve, curve.sell, fee transfer]. Nothing is signed or broadcast.
 * See docs/trading.md, "Fees on curve trades".
 *
 *   pnpm --filter @rushr/trade exec tsx scripts/batch7702-sim.ts <token> [--eth 0.01]
 */
import { concat, createPublicClient, decodeFunctionResult, encodeFunctionData, formatEther, http, parseAbi, toHex, type Address, type Hex, type PublicClient } from 'viem';
import { robinhoodChain } from '../src/chain';
import { discoverPools } from '../src/pools';
import { ponsBuyCapped } from '../src/math';
import { quickBuy, quickSell } from '../src/quick';
import type { PonsPool } from '../src/types';

/** eth-infinitism Simple7702Account (v0.8). Same bytecode on chain 4663 as on Ethereum mainnet. */
const SIMPLE_7702: Address = '0x4Cd241E8d1510e30b2076397afc7508Ae59C66c9';
const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';
const FEE_TO: Address = '0x000000000000000000000000000000000000fee5'; // stand-in for the treasury
const FEE_BPS = 50n;
const acct: Address = '0x00000000000000000000000000000000b0b0b0b0';

const accountAbi = parseAbi(['struct Call { address target; uint256 value; bytes data; }', 'function executeBatch(Call[] calls)']);
const mcAbi = parseAbi(['function getEthBalance(address) view returns (uint256)']);
const client = createPublicClient({ chain: robinhoodChain, transport: http() }) as PublicClient;

const args = process.argv.slice(2);
const i = args.indexOf('--eth');
const total = BigInt(Math.round(Number(i >= 0 ? args[i + 1] : '0.01') * 1e6)) * 10n ** 12n;
const token = args.find((a, j) => a.startsWith('0x') && (i < 0 || j !== i + 1)) as Address;

const pools = await discoverPools(client, token, { quoteAsset: 'ETH', venues: ['pons-curve'], trader: acct });
const curve = pools.find((p): p is PonsPool => p.venue === 'pons-curve' && !p.graduated);
if (!curve) throw new Error('no live curve');
const fund = 10n ** 18n;
const opts = { simulate: false, acknowledgedHighRisk: true, settings: { maxTradeWei: fund }, assume: { ethWei: fund } } as const;

// Buy: the fee comes off the top; the curve gets the rest.
const buyFee = (total * FEE_BPS) / 10_000n;
const buy = await quickBuy(client, { token, ethWei: total - buyFee, trader: acct }, { ...opts, discover: { pools: [curve] } });
const tokens = buy.quote!.amountOut;
const used = ponsBuyCapped(total - buyFee, curve).used;
const net = used - (used * BigInt(curve.feeBps)) / 10_000n - (used * BigInt(curve.creatorTaxBps)) / 10_000n;
const after: PonsPool = { ...curve, quoteReserve: curve.quoteReserve + net, tokenReserve: curve.tokenReserve - tokens, realQuoteReserve: curve.realQuoteReserve + net };
// Sell: a plain batch fixes every amount at signing time, so the fee is taken on the quoted
// proceeds. If the trade fills below the quote (but above the minimum), the fee is still that fixed amount.
const sell = await quickSell(client, { token, trader: acct, amount: tokens }, { ...opts, discover: { pools: [after] }, assume: { ethWei: fund, tokenWei: tokens } });
const sellFee = (sell.quote!.amountOut * FEE_BPS) / 10_000n;

const batch = (calls: { to: Address; value?: bigint; data: Hex }[]) =>
  encodeFunctionData({ abi: accountAbi, functionName: 'executeBatch', args: [calls.map((c) => ({ target: c.to, value: c.value ?? 0n, data: c.data }))] });
const buyBatch = batch([{ to: FEE_TO, value: buyFee, data: '0x' }, ...buy.calls]);
const sellBatch = batch([...sell.calls, { to: FEE_TO, value: sellFee, data: '0x' }]);
const bal = (a: Address) => ({ to: MULTICALL3, data: encodeFunctionData({ abi: mcAbi, functionName: 'getEthBalance', args: [a] }) });

type SimCall = { status: string; gasUsed: Hex; returnData: Hex; error?: { message: string } };
const [block] = (await client.request({
  method: 'eth_simulateV1' as never,
  params: [
    {
      blockStateCalls: [
        {
          stateOverrides: { [acct]: { balance: toHex(fund), code: concat(['0xef0100', SIMPLE_7702]) } },
          calls: [
            bal(FEE_TO),
            { from: acct, to: acct, data: buyBatch, gas: toHex(1_000_000n) },
            bal(FEE_TO),
            { from: acct, to: acct, data: sellBatch, gas: toHex(1_000_000n) },
            bal(FEE_TO),
            bal(acct),
            // Control: the same buy batch from an address WITHOUT the designator must not run the batch.
            { from: '0x00000000000000000000000000000000c0c0c0c0', to: '0x00000000000000000000000000000000c0c0c0c0', data: buyBatch, gas: toHex(1_000_000n) },
          ],
        },
      ],
      validation: false,
    },
    'latest',
  ] as never,
})) as { calls: SimCall[] }[];
const c = block!.calls;
const num = (h: Hex) => decodeFunctionResult({ abi: mcAbi, functionName: 'getEthBalance', data: h });
const c0 = num(c.shift()!.returnData); // the stand-in address may already hold dust
for (const [k, n] of [[0, 'buy batch'], [2, 'sell batch']] as const) console.log(`${n}: ${c[k]!.status === '0x1' ? 'ok' : `REVERT ${c[k]!.error?.message}`}, gas ${BigInt(c[k]!.gasUsed)}`);
console.log(`fee received on the buy  ${formatEther(num(c[1]!.returnData) - c0)} ETH (expected ${formatEther(buyFee)})`);
console.log(`fee received on the sell ${formatEther(num(c[3]!.returnData) - num(c[1]!.returnData))} ETH (expected ${formatEther(sellFee)})`);
console.log(`account: started ${formatEther(fund)}, ended ${formatEther(num(c[4]!.returnData))} ETH; spent ${formatEther(total)} on the buy, sell quoted ${formatEther(sell.quote!.amountOut)}`);
console.log(`tokens bought ${formatEther(tokens)}; control (no designator): ${c[5]!.status === '0x1' && BigInt(c[5]!.gasUsed) > 30_000n ? 'RAN (unexpected)' : `no batch executed (status ${c[5]!.status}, gas ${BigInt(c[5]!.gasUsed)})`}`);
