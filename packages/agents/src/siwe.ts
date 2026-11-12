// Sign-In with Ethereum (EIP-4361) messages for every wallet proof on Rushr. Verification is local
// (ecrecover, EOA only): no RPC call, no key ever reaches Rushr.
import { getAddress, isAddress, recoverMessageAddress, type Address, type Hex } from 'viem';
import { createSiweMessage, parseSiweMessage, validateSiweMessage } from 'viem/siwe';

export const SIWE_DOMAIN = 'rushr.trade';
export const SIWE_URI = 'https://rushr.trade';
export const CHAIN_ID = 4663;
export const NONCE_TTL_MS = 10 * 60_000;
export const TERMS_URL = 'https://rushr.trade/terms#agents';

export type Purpose = 'human' | 'register' | 'register_owned' | 'link' | 'unlink' | 'login';
export const PURPOSES: readonly Purpose[] = ['human', 'register', 'register_owned', 'link', 'unlink', 'login'];

/** Context baked into the statement. The owner is part of the signed text, so a stolen link code can't redirect an agent. */
export interface PurposeContext {
  ownerHandle?: string;
  ownerAddress?: string;
}

export function statementFor(purpose: Purpose, ctx: PurposeContext = {}): string {
  const owner = () => {
    if (!ctx.ownerHandle || !ctx.ownerAddress) throw new Error(`${purpose} needs ownerHandle and ownerAddress`);
    return `@${ctx.ownerHandle} (${ctx.ownerAddress.toLowerCase()})`;
  };
  switch (purpose) {
    case 'human':
      return 'Sign in to Rushr as a human.';
    case 'register':
      return 'Register this wallet on Rushr as an independent AI agent. I keep my own keys and sign my own transactions.';
    case 'register_owned':
      return `Register this wallet on Rushr as an AI agent owned by ${owner()}. I keep my own keys and sign my own transactions.`;
    case 'link':
      return `Link this agent wallet to Rushr member ${owner()}.`;
    case 'unlink':
      return 'Unlink this agent wallet from its Rushr owner.';
    case 'login':
      return 'Sign in to Rushr as this agent and issue a new API key.';
  }
}

export function buildMessage(args: { purpose: Purpose; address: string; nonce: string; issuedAt: Date; ctx?: PurposeContext }): string {
  return createSiweMessage({
    domain: SIWE_DOMAIN,
    uri: SIWE_URI,
    version: '1',
    chainId: CHAIN_ID,
    address: getAddress(args.address),
    nonce: args.nonce,
    issuedAt: args.issuedAt,
    expirationTime: new Date(args.issuedAt.getTime() + NONCE_TTL_MS),
    statement: statementFor(args.purpose, args.ctx),
    resources: [TERMS_URL],
  });
}

export type SiweFailure = 'malformed' | 'wrong_domain' | 'wrong_chain' | 'expired' | 'wrong_statement' | 'wrong_nonce' | 'invalid_signature';

export interface VerifiedSiwe {
  address: string; // lowercase
  nonce: string;
  issuedAt: Date;
}

/**
 * Check a signed SIWE message for one purpose. The caller must still consume the nonce atomically
 * (exists, same address and purpose, unused, unexpired) in the same database transaction.
 */
export async function verifySiwe(args: {
  message: string;
  signature: string;
  purpose: Purpose;
  ctx?: PurposeContext;
  /** When known (the nonce row), the nonce the message must carry. */
  nonce?: string;
  now?: Date;
}): Promise<{ ok: true; value: VerifiedSiwe } | { ok: false; error: SiweFailure }> {
  const now = args.now ?? new Date();
  if (typeof args.message !== 'string' || args.message.length > 4000) return { ok: false, error: 'malformed' };
  if (typeof args.signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(args.signature)) return { ok: false, error: 'invalid_signature' };
  let parsed: ReturnType<typeof parseSiweMessage>;
  try {
    parsed = parseSiweMessage(args.message);
  } catch {
    return { ok: false, error: 'malformed' };
  }
  if (!parsed.address || !isAddress(parsed.address) || !parsed.nonce || !parsed.issuedAt) return { ok: false, error: 'malformed' };
  if (parsed.domain !== SIWE_DOMAIN || parsed.uri !== SIWE_URI || parsed.version !== '1') return { ok: false, error: 'wrong_domain' };
  if (parsed.chainId !== CHAIN_ID) return { ok: false, error: 'wrong_chain' };
  if (!validateSiweMessage({ message: parsed, domain: SIWE_DOMAIN, time: now })) return { ok: false, error: 'expired' };
  const age = now.getTime() - parsed.issuedAt.getTime();
  if (age > NONCE_TTL_MS || age < -60_000) return { ok: false, error: 'expired' };
  let expected: string;
  try {
    expected = statementFor(args.purpose, args.ctx);
  } catch {
    return { ok: false, error: 'wrong_statement' };
  }
  if (parsed.statement !== expected) return { ok: false, error: 'wrong_statement' };
  if (args.nonce !== undefined && parsed.nonce !== args.nonce) return { ok: false, error: 'wrong_nonce' };
  let signer: Address;
  try {
    signer = await recoverMessageAddress({ message: args.message, signature: args.signature as Hex });
  } catch {
    return { ok: false, error: 'invalid_signature' };
  }
  if (signer.toLowerCase() !== parsed.address.toLowerCase()) return { ok: false, error: 'invalid_signature' };
  return { ok: true, value: { address: signer.toLowerCase(), nonce: parsed.nonce, issuedAt: parsed.issuedAt } };
}

/** Read the nonce and address out of a message without trusting it (to look the nonce row up). */
export function peekSiwe(message: string): { address: string; nonce: string } | null {
  try {
    const p = parseSiweMessage(message);
    return p.address && p.nonce ? { address: p.address.toLowerCase(), nonce: p.nonce } : null;
  } catch {
    return null;
  }
}
