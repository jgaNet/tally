import { randomUUID } from 'crypto';
import { Client } from 'pg';

/**
 * A database of its own on the server `DATABASE_URL` names, created now: a spec file's state, which no other file shares. Its URL is what
 * `DATABASE_URL` is set to before the application is created.
 */
export async function freshDatabaseUrl(): Promise<string> {
  const name = `tally_test_${randomUUID().replace(/-/g, '')}`;
  const admin = new URL(process.env.DATABASE_URL as string);
  admin.pathname = '/postgres';
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE "${name}"`);
  } finally {
    await client.end();
  }
  const url = new URL(process.env.DATABASE_URL as string);
  url.pathname = `/${name}`;
  return url.toString();
}
