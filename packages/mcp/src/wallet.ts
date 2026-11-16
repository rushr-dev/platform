import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Address, Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { ConfigError, type Config } from './config.ts';

/** The keyfile format Talos writes (`.agent-wallet.json`). Only `privateKey` is required. */
export interface WalletFile {
  address?: Address;
  privateKey: Hex;
  createdAt?: string;
  handle?: string;
  memberId?: string;
  apiKeyId?: string;
  apiKey?: string;
}

export interface Registration {
  handle: string;
  memberId: string;
  apiKeyId: string;
  apiKey: string;
}

/**
 * The agent's wallet. The private key stays inside the viem account: this object never exposes it,
 * and nothing in the server returns or logs it. The rk_ API key is kept next to it:
 * - with RUSHR_WALLET_FILE, inside that file (Talos's format, mode 600);
 * - with RUSHR_PRIVATE_KEY, from RUSHR_API_KEY or `<stateDir>/<address>.json` (mode 600).
 */
export interface AgentWallet {
  readonly account: PrivateKeyAccount;
  readonly address: Address;
  apiKey(): string | undefined;
  handle(): string | undefined;
  saveRegistration(r: Registration): void;
  /** Where the API key is stored, for messages (never the key itself). */
  readonly keyLocation: string;
}

const HEX_KEY = /^0x[0-9a-fA-F]{64}$/;

function writePrivate(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function readJson<T>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (e) {
    // Never echo file contents: the file holds a private key.
    throw new ConfigError(`can't read ${path} as JSON (${e instanceof SyntaxError ? 'invalid JSON' : 'unreadable'})`);
  }
}

/** Loads the wallet from the config, or returns null when none is configured (read-only mode). */
export function loadWallet(c: Config): AgentWallet | null {
  if (c.walletFile) {
    const path = c.walletFile;
    if (!existsSync(path)) throw new ConfigError(`RUSHR_WALLET_FILE ${path} doesn't exist`);
    const w = readJson<WalletFile>(path);
    if (!HEX_KEY.test(w.privateKey ?? '')) throw new ConfigError(`${path} has no valid privateKey (0x + 64 hex characters)`);
    const account = privateKeyToAccount(w.privateKey);
    if (w.address && w.address.toLowerCase() !== account.address.toLowerCase()) throw new ConfigError(`${path}: address doesn't match its privateKey`);
    let state = w;
    return {
      account,
      address: account.address,
      apiKey: () => c.apiKey ?? state.apiKey,
      handle: () => state.handle,
      saveRegistration(r) {
        state = { ...readJson<WalletFile>(path), address: account.address, ...r };
        writePrivate(path, state);
      },
      keyLocation: path,
    };
  }
  if (c.privateKey) {
    if (!HEX_KEY.test(c.privateKey)) throw new ConfigError('RUSHR_PRIVATE_KEY must be 0x followed by 64 hex characters');
    const account = privateKeyToAccount(c.privateKey as Hex);
    const path = join(c.stateDir, `${account.address.toLowerCase()}.json`);
    let state: Partial<Registration> = existsSync(path) ? readJson<Partial<Registration>>(path) : {};
    return {
      account,
      address: account.address,
      apiKey: () => c.apiKey ?? state.apiKey,
      handle: () => state.handle,
      saveRegistration(r) {
        state = r;
        writePrivate(path, { address: account.address, ...r });
      },
      keyLocation: c.apiKey ? 'RUSHR_API_KEY' : path,
    };
  }
  return null;
}

/**
 * Writes a brand-new keyfile (mode 600) and returns only its address. Refuses to overwrite an existing file:
 * that file may hold the only copy of a funded key. The key itself is never returned or logged.
 */
export function createWalletFile(path: string): Address {
  if (existsSync(path)) throw new ConfigError(`${path} already exists; not overwriting it`);
  const privateKey = generatePrivateKey();
  const address = privateKeyToAccount(privateKey).address;
  writePrivate(path, { address, privateKey, createdAt: new Date().toISOString() } satisfies WalletFile);
  return address;
}
