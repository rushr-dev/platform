'use client';

import { useEffect, useRef } from 'react';
import { PrivyProvider, useExportWallet, usePrivy, useSendTransaction, useSignTransaction, useWallets } from '@privy-io/react-auth';
import { robinhoodChain } from '@rushr/trade';
import { privyAppId, setAuthActions, setAuthState, type AuthUser } from '@/lib/auth';

/**
 * Privy, loaded lazily by AuthRoot. It wraps only a bridge component (never the page), so loading
 * it doesn't remount anything: the bridge copies Privy's state into lib/auth and exposes its actions.
 *
 * Sign-in: email or an external EVM wallet (no X sign-in for now). Every user gets an embedded wallet on Robinhood Chain
 * at sign-up; Privy's own wallet prompts are off because quick trades must not ask for
 * confirmation, and the trade UI shows status itself.
 */
export default function PrivyHost() {
  return (
    <PrivyProvider
      appId={privyAppId()}
      config={{
        loginMethods: ['email', 'wallet'],
        appearance: {
          theme: 'dark',
          accentColor: '#36d42a',
          logo: '/logo-mark-64.png',
          landingHeader: 'Sign in to Rushr',
          walletChainType: 'ethereum-only',
        },
        embeddedWallets: { ethereum: { createOnLogin: 'all-users' }, showWalletUIs: false },
        // Privy's modal links Terms and Privacy; the Risk disclosure is linked in our own sign-up step.
        legal: { termsAndConditionsUrl: `${window.location.origin}/terms`, privacyPolicyUrl: `${window.location.origin}/privacy` },
        defaultChain: robinhoodChain,
        supportedChains: [robinhoodChain],
      }}
    >
      <Bridge />
    </PrivyProvider>
  );
}

function Bridge() {
  const { ready, authenticated, user, login, logout, getAccessToken } = usePrivy();
  const { wallets } = useWallets();
  const { exportWallet } = useExportWallet();
  const { sendTransaction } = useSendTransaction();
  const { signTransaction } = useSignTransaction();

  const embedded = wallets.find((w) => w.walletClientType === 'privy');

  // Warm the wallet as soon as it exists, so the first quick trade isn't cold: a fresh access token
  // (signing needs one) and the embedded wallet's provider. Nothing is signed.
  const warmed = useRef<string | null>(null);
  useEffect(() => {
    if (!ready || !authenticated || !embedded || warmed.current === embedded.address) return;
    warmed.current = embedded.address;
    void getAccessToken().catch(() => null);
    void embedded.getEthereumProvider().catch(() => null);
  }, [ready, authenticated, embedded, getAccessToken]);

  useEffect(() => {
    const u: AuthUser | null = user
      ? {
          id: user.id,
          email: user.email?.address ?? null,
          twitter: user.twitter?.username ? { username: user.twitter.username, avatar: user.twitter.profilePictureUrl ?? null } : null,
          wallet: ((embedded?.address ?? (user.wallet?.walletClientType === 'privy' ? user.wallet.address : null)) as `0x${string}` | null) ?? null,
          externalWallet: (wallets.find((w) => w.walletClientType !== 'privy')?.address as `0x${string}` | undefined) ?? null,
        }
      : null;
    setAuthState({ ready, authenticated, user: u });
  }, [ready, authenticated, user, embedded?.address, wallets]);

  useEffect(() => {
    setAuthActions({
      login,
      logout,
      exportWallet: () => exportWallet(embedded ? { address: embedded.address } : undefined),
      async sendTransaction(tx) {
        if (!embedded) throw new Error('No embedded wallet yet');
        const { hash } = await sendTransaction(
          { to: tx.to, data: tx.data, value: tx.value, gasLimit: tx.gas, chainId: robinhoodChain.id },
          { address: embedded.address, uiOptions: { showWalletUIs: false } },
        );
        return hash;
      },
      // Quick trades: sign only, with every field given (Privy then fetches nothing), and broadcast
      // from the trade UI to the chain's RPC (components/trade/fast-send). Privy's UI stays off.
      async signTransaction(tx) {
        if (!embedded) throw new Error('No embedded wallet yet');
        const { signature } = await signTransaction(
          {
            type: 2,
            chainId: tx.chainId,
            nonce: tx.nonce,
            to: tx.to,
            data: tx.data,
            value: tx.value,
            gasLimit: tx.gas,
            maxFeePerGas: tx.maxFeePerGas,
            maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
          },
          { address: embedded.address, uiOptions: { showWalletUIs: false } },
        );
        return signature;
      },
      getAccessToken,
    });
    return () => setAuthActions(null);
  }, [login, logout, exportWallet, sendTransaction, signTransaction, getAccessToken, embedded]);

  return null;
}
