import type { Address, PublicClient } from 'viem';
import { TRADE_ADDRESSES } from './addresses.ts';
import { erc20Abi, permit2Abi } from './abis.ts';
import type { PermitSingle } from './universal-router.ts';

const MAX_UINT160 = (1n << 160n) - 1n;

/** EIP-712 typed data for a Permit2 PermitSingle. The user's wallet signs it; we never hold keys. */
export function permitSingleTypedData(permit: PermitSingle, chainId: number = TRADE_ADDRESSES.chainId) {
  return {
    domain: { name: 'Permit2', chainId, verifyingContract: TRADE_ADDRESSES.permit2 },
    types: {
      PermitSingle: [
        { name: 'details', type: 'PermitDetails' },
        { name: 'spender', type: 'address' },
        { name: 'sigDeadline', type: 'uint256' },
      ],
      PermitDetails: [
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint160' },
        { name: 'expiration', type: 'uint48' },
        { name: 'nonce', type: 'uint48' },
      ],
    },
    primaryType: 'PermitSingle' as const,
    message: permit,
  };
}

export function makePermitSingle(p: { token: Address; spender: Address; amount: bigint; nonce: number; now: number; expirySeconds?: number; sigSeconds?: number }): PermitSingle {
  return {
    details: { token: p.token, amount: p.amount > MAX_UINT160 ? MAX_UINT160 : p.amount, expiration: p.now + (p.expirySeconds ?? 30 * 86400), nonce: p.nonce },
    spender: p.spender,
    sigDeadline: BigInt(p.now + (p.sigSeconds ?? 1800)),
  };
}

export interface AllowanceState {
  /** token.allowance(owner, Permit2) */
  erc20ToPermit2: bigint;
  /** Permit2.allowance(owner, token, spender) */
  permit2Amount: bigint;
  permit2Expiration: number;
  permit2Nonce: number;
}

export async function readAllowances(client: PublicClient, owner: Address, token: Address, spender: Address): Promise<AllowanceState> {
  const [erc20ToPermit2, [amount, expiration, nonce]] = await Promise.all([
    client.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, TRADE_ADDRESSES.permit2] }),
    client.readContract({ address: TRADE_ADDRESSES.permit2, abi: permit2Abi, functionName: 'allowance', args: [owner, token, spender] }),
  ]);
  return { erc20ToPermit2, permit2Amount: amount, permit2Expiration: Number(expiration), permit2Nonce: Number(nonce) };
}

/** Which approval steps are still needed for `amount` at time `now`. */
export function neededApprovals(state: AllowanceState, amount: bigint, now: number): { erc20: boolean; permit2: boolean } {
  return { erc20: state.erc20ToPermit2 < amount, permit2: state.permit2Amount < amount || state.permit2Expiration <= now };
}
