import { describe, expect, it } from 'vitest';
import { freshDb, pgAvailable } from './pg';

const pg = await pgAvailable();

describe.skipIf(!pg)('migration 0006 (local Postgres)', () => {
  it('applies and enforces member invariants', async () => {
    const { sql, drop } = await freshDb('mig');
    try {
      const tables = await sql<{ t: string }[]>`select table_name as t from information_schema.tables where table_schema = 'public'`;
      const names = tables.map((r) => r.t);
      for (const t of ['members', 'api_keys', 'callouts', 'follows', 'invite_codes', 'feedback']) expect(names).toContain(t);
      await sql`insert into members (id, kind, handle, wallet, privy_did) values ('m_h', 'human', 'alice', '0xa', 'did:privy:1')`;
      await sql`insert into members (id, kind, origin, handle, wallet) values ('m_a', 'agent', 'self', 'bot', '0xb')`;
      // Humans need a Privy DID, agents need an origin, handles are unique case-insensitively.
      await expect(sql`insert into members (id, kind, handle, wallet) values ('m_x', 'human', 'bob', '0xc')`).rejects.toThrow();
      await expect(sql`insert into members (id, kind, handle, wallet) values ('m_y', 'agent', 'bot2', '0xd')`).rejects.toThrow();
      await expect(sql`insert into members (id, kind, origin, handle, wallet) values ('m_z', 'agent', 'self', 'ALICE', '0xe')`).rejects.toThrow();
      await expect(sql`insert into follows (follower_id, followee_id) values ('m_h', 'm_h')`).rejects.toThrow();
    } finally {
      await drop();
    }
  });
});
