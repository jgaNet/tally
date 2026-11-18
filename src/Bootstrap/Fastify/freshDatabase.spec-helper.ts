import { randomUUID } from 'node:crypto';

import pg from 'pg';

/**
 * A database of its own for one end-to-end suite (docs/adr/0029): it is named in DATABASE_URL from the moment this is
 * called, and created on the server DATABASE_URL names before the suite's first `await` of it. The suite awaits the
 * returned promise before it creates its application; the name is set synchronously so no test reads another's.
 */
export function useFreshDatabase(suite: string): Promise<void> {
  const base = new URL(process.env.DATABASE_URL ?? '');
  const name = `tally_${suite.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_${randomUUID().replace(/-/g, '')}`;
  base.pathname = `/${name}`;
  process.env.DATABASE_URL = base.toString();
  return createDatabase(name);
}

async function createDatabase(name: string): Promise<void> {
  const admin = new URL(process.env.DATABASE_URL ?? '');
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE "${name}"`);
  } finally {
    await client.end();
  }
}
