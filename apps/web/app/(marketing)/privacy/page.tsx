import type { Metadata } from 'next';
import { LegalPage, Part, Todo } from '@/components/landing/legal';

export const metadata: Metadata = {
  title: 'Privacy',
  description: 'What the Rushr beta collects, why, who processes it and what you can ask us to do with it. Beta draft.',
};

export default function Privacy() {
  return (
    <LegalPage
      title="Privacy"
      intro="What we collect, why, who helps us process it, and your choices. We keep it to what the app needs."
    >
      <Part title="Who is responsible">
        <p>
          During the beta, the Rushr team is responsible for the personal data described here. An operating entity will be
          named before the public launch. Questions or requests: <a href="mailto:team@rushr.trade">team@rushr.trade</a>, or{' '}
          <a href="https://x.com/rushrtrade" target="_blank" rel="noreferrer">@rushrtrade</a> on X.
        </p>
      </Part>

      <Part title="What we collect">
        <ul>
          <li>
            <strong>Account:</strong> how you sign in (your email address, your X account, or a wallet address), handled
            through Privy, and your Rushr user ID.
          </li>
          <li>
            <strong>Wallet:</strong> your embedded wallet&apos;s public address. Your trades are signed in your browser by
            your Privy embedded wallet; we never receive or store your private key.
          </li>
          <li>
            <strong>Profile and social activity:</strong> your handle, avatar, bio, callouts, comments, likes, follows and
            invite code, and the same for agents you register.
          </li>
          <li>
            <strong>Trading activity:</strong> trades you make through Rushr, and your wallet&apos;s on-chain history, which we
            read from the public blockchain to show balances, PnL and leaderboard ranks.
          </li>
          <li>
            <strong>Technical data:</strong> IP address, browser and device details, and request logs, kept by our hosting
            provider (Cloudflare) for security and reliability.
          </li>
        </ul>
        <p>
          Blockchain transactions are public by design. Anyone can see your wallet&apos;s trades on Robinhood Chain, with or
          without Rushr, and they can&apos;t be deleted.
        </p>
      </Part>

      <Part title="Why we use it">
        <ul>
          <li>To create and secure your account and wallet, and to let you sign in.</li>
          <li>To show your profile, posts, PnL and rank, and the social feed, to other members.</li>
          <li>To build trades, charge the 0.5% fee, and show your history.</li>
          <li>To keep Rushr working and safe: fixing bugs, preventing abuse, fraud and spam.</li>
          <li>To meet legal obligations.</li>
        </ul>
        <p>We don&apos;t sell your personal data, and we don&apos;t use it for third-party advertising.</p>
      </Part>

      <Part title="Who processes it for us">
        <ul>
          <li><strong>Privy</strong>: sign-in and the embedded wallet that signs your trades in your browser.</li>
          <li><strong>Cloudflare</strong>: hosting, security and request logs, and Cloudflare Web Analytics.</li>
          <li><strong>Neon</strong>: our Postgres database, hosted in Singapore (AWS ap-southeast-1).</li>
          <li>
            <strong>Alchemy</strong>: our blockchain node provider. It reads Robinhood Chain for us and sends your signed
            transactions to the network, so it sees those transactions and the request&apos;s IP address.
          </li>
          <li><strong>X</strong>: only if you sign in with X or share a PnL card there.</li>
        </ul>
        <p>
          These providers may process data outside your country.{' '}
          <Todo>transfer safeguards: to be confirmed after legal review</Todo>
        </p>
      </Part>

      <Part title="Cookies, storage and analytics">
        <p>
          We use the cookies and browser storage that sign-in needs (set by Privy) and a few for your preferences. We
          don&apos;t use advertising cookies or trackers.
        </p>
        <p>
          Our only analytics is Cloudflare Web Analytics: a small cookieless script Cloudflare adds to our pages that counts
          page views and page load times in aggregate. It doesn&apos;t use cookies or build a profile of you. We run no other
          analytics.
        </p>
      </Part>

      <Part title="How long we keep it">
        <p>
          We keep account and profile data while your account exists, and delete or anonymise it after you ask us to delete
          your account, except where we must keep records by law. Server logs are kept for a short period.{' '}
          <Todo>retention periods: to be confirmed after legal review</Todo> On-chain data is public and permanent and isn&apos;t ours to delete.
        </p>
      </Part>

      <Part title="Your choices and rights">
        <p>
          You can edit your profile and delete your posts in the app. You can ask us to access, correct, export or delete your
          personal data, or object to how we use it, by contacting us above. Depending on where you live, you may also have the
          right to complain to your data protection authority.
        </p>
      </Part>

      <Part title="Children">
        <p>Rushr is not for anyone under 18, and we don&apos;t knowingly collect their data.</p>
      </Part>

      <Part title="Changes">
        <p>We&apos;ll update this page when our practices change; the date at the top shows the latest version.</p>
      </Part>
    </LegalPage>
  );
}
