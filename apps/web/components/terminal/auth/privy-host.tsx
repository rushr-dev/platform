'use client';

import { useEffect } from 'react';
import { PrivyProvider, useExportWallet, usePrivy, useSendTransaction, useWallets } from '@privy-io/react-auth';
import { robinhoodChain } from '@rushr/trade';
import { privyAppId, setAuthActions, setAuthState, type AuthUser } from '@/lib/auth';

/**
 * Privy, loaded lazily by AuthRoot. It wraps only a bridge component (never the page), so loading
 * it doesn't remount anything: the bridge copies Privy's state into lib/auth and exposes its actions.
 *
 * Sign-in: email, X or an external wallet. Every user gets an embedded wallet on Robinhood Chain
 * at sign-up; Privy's own wallet prompts are off because quick trades must not ask for
 * confirmation (beta spec), and the trade UI shows status itself.
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

  const embedded = wallets.find((w) => w.walletClientType === 'privy');

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
      getAccessToken,
    });
    return () => setAuthActions(null);
  }, [login, logout, exportWallet, sendTransaction, getAccessToken, embedded]);

  return null;
}
