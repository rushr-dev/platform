'use client';

import { useEffect, useState } from 'react';
import type { Address, EIP1193Provider } from 'viem';

/** EIP-6963 injected wallet discovery, with window.ethereum as a fallback. Read-only use: we only ask for accounts. */
export interface InjectedWallet {
  id: string;
  name: string;
  icon?: string;
  provider: EIP1193Provider;
}

interface AnnounceEvent extends Event {
  detail: { info: { uuid: string; name: string; icon: string; rdns: string }; provider: EIP1193Provider };
}

export function useInjectedWallets(): InjectedWallet[] {
  const [wallets, setWallets] = useState<InjectedWallet[]>([]);
  useEffect(() => {
    const seen = new Map<string, InjectedWallet>();
    const onAnnounce = (e: Event) => {
      const { info, provider } = (e as AnnounceEvent).detail;
      seen.set(info.rdns || info.uuid, { id: info.rdns || info.uuid, name: info.name, icon: info.icon, provider });
      setWallets([...seen.values()]);
    };
    window.addEventListener('eip6963:announceProvider', onAnnounce);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    const t = setTimeout(() => {
      const eth = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
      if (!seen.size && eth) setWallets([{ id: 'injected', name: 'Browser wallet', provider: eth }]);
    }, 300);
    return () => {
      window.removeEventListener('eip6963:announceProvider', onAnnounce);
      clearTimeout(t);
    };
  }, []);
  return wallets;
}

export async function requestAccount(w: InjectedWallet): Promise<{ address: Address; chainId: number }> {
  const [address] = (await w.provider.request({ method: 'eth_requestAccounts' })) as Address[];
  const chainHex = (await w.provider.request({ method: 'eth_chainId' })) as string;
  if (!address) throw new Error('No account returned by the wallet');
  return { address, chainId: Number(chainHex) };
}
