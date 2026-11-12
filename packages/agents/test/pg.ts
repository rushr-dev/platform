// Local Postgres for tests: the docker-compose database on :5433, in a throwaway database per run.
// Never points at Neon or production. Tests that need it are skipped when it isn't running.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres, { type Sql } from 'postgres';

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? 'postgres://rushr:rushr@127.0.0.1:5433/rushr';
const MIGRATIONS = join(import.meta.dirname, '../../db/migrations');

export async function pgAvailable(): Promise<boolean> {
  const sql = postgres(ADMIN_URL, { max: 1, connect_timeout: 2, onnotice: () => {} });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end({ timeout: 1 });
  }
}

/** Create a fresh database with every migration in the journal applied. Returns its URL and a client. */
export async function freshDb(name: string): Promise<{ url: string; sql: Sql; drop: () => Promise<void> }> {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error('bad db name');
  const db = `rushr_test_${name}_${process.pid}`;
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`drop database if exists ${db}`);
  await admin.unsafe(`create database ${db}`);
  const url = ADMIN_URL.replace(/\/[^/]+$/, `/${db}`);
  const sql = postgres(url, { max: 4, onnotice: () => {}, fetch_types: false, prepare: false });
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
  for (const { tag } of journal.entries) {
    const text = readFileSync(join(MIGRATIONS, `${tag}.sql`), 'utf8');
    for (const stmt of text.split('--> statement-breakpoint')) if (stmt.trim()) await sql.unsafe(stmt);
  }
  return {
    url,
    sql,
    drop: async () => {
      await sql.end({ timeout: 1 });
      await admin.unsafe(`drop database if exists ${db} with (force)`);
      await admin.end({ timeout: 1 });
    },
  };
}
