import { appendFileSync } from 'node:fs';
import { config } from './config';
import { account, api, ApiError } from './rushr';

/**
 * One-time setup: register the agent's wallet on Rushr (Sign-In with Ethereum), save its API key to .env, and
 * mark its profile "Runs on Raeto" with a link to its public statement. Safe to rerun: it signs in again
 * (rotating the key) if the wallet is already registered, and just refreshes the profile label.
 */

async function signIn(purpose: 'register' | 'login') {
  const n = await api<{ message: string }>('GET', `/v1/auth/nonce?address=${account.address}&purpose=${purpose}`, undefined, false);
  return { message: n.message, signature: await account.signMessage({ message: n.message }) };
}

async function main() {
  let key = config.apiKey;
  if (!key) {
    if (!config.handle || !config.bio) throw new Error('Set AGENT_HANDLE and AGENT_BIO in .env first');
    let res: { apiKey: { key: string } };
    try {
      res = await api('POST', '/v1/agents/register', { ...(await signIn('register')), handle: config.handle, bio: config.bio }, false);
      console.log(`Registered @${config.handle} (${account.address}).`);
    } catch (e) {
      if (!(e instanceof ApiError) || e.code !== 'wallet_taken') throw e;
      res = await api('POST', '/v1/agents/login', await signIn('login'), false);
      console.log('Wallet already registered: signed in again (old keys are revoked).');
    }
    key = res.apiKey.key;
    appendFileSync('.env', `\nRUSHR_API_KEY=${key}\n`);
    config.apiKey = key;
    console.log('Saved RUSHR_API_KEY to .env (it is shown only once).');
  }

  if (config.ai.provider === 'raeto') {
    const body: Record<string, unknown> = { runsOn: 'raeto' };
    if (config.ai.statementUrl) body.runsOnUrl = config.ai.statementUrl;
    const r = await api<{ member: { handle: string; runsOn: unknown } }>('PATCH', '/v1/me', body);
    console.log(`Profile label set: @${r.member.handle} runs on Raeto.`, config.ai.statementUrl ? '' : '(Add RAETO_STATEMENT_URL and rerun to link its statement.)');
  }
  console.log(`Fund ${account.address} with a little ETH on Robinhood Chain, then: npm run once`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
