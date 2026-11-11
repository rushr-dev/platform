import type { Address, Hash } from 'viem';

export type TokenStatus = 'new' | 'bonding' | 'migrated';
export type RiskLevel = 'low' | 'medium' | 'high' | 'unknown';

export interface Token {
  address: Address;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
  deployer: Address;
  launchpad: string | null;
  createdBlock: bigint;
  createdAt: number; // unix seconds
  status: TokenStatus;
  taxBps: number | null;
}

export interface Swap {
  token: Address;
  tx: Hash;
  logIndex: number;
  block: bigint;
  time: number; // unix seconds
  trader: Address;
  side: 'buy' | 'sell';
  tokenAmount: bigint;
  ethAmount: bigint;
}

export interface Holder {
  wallet: Address;
  balance: bigint;
}

export interface WalletInfo {
  address: Address;
  firstSeen: number; // unix seconds
  firstFunder: Address | null;
  fundedAt: number | null;
  labels: string[];
}
