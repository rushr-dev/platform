import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema';

/**
 * Create a Drizzle client. On Workers pass the Hyperdrive connection string
 * (`env.HYPERDRIVE.connectionString`); locally pass DATABASE_URL.
 */
export function createDb(connectionString: string) {
  const sql = postgres(connectionString, { max: 5, fetch_types: false, prepare: false });
  return drizzle(sql, { schema });
}

export type Db = ReturnType<typeof createDb>;
