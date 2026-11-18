import { randomUUID } from 'crypto';

import { afterAll } from '@jest/globals';
import pg from 'pg';

/**
 * A database of its own on the PostgreSQL server DATABASE_URL names, for the tests: empty, dropped (its connections cut) when the file's
 * tests end. Its URL is what `PostgresDatabase.open()` and `createApplication({ databaseUrl })` are given; whoever shares the URL shares it.
 */
const created: string[] = [];

export async function freshDatabase(): Promise<string> {
  const base = new URL(process.env.DATABASE_URL ?? 'postgresql://postgres@127.0.0.1/postgres');
  const name = `tally_test_${randomUUID().replace(/-/g, '')}`;
  const admin = new pg.Client({ connectionString: base.toString() });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  created.push(name);
  base.pathname = `/${name}`;
  return base.toString();
}

afterAll(async () => {
  const names = created.splice(0);
  if (names.length === 0) return;
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  try {
    for (const name of names) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
});
