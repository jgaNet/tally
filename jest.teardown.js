import { afterAll } from '@jest/globals';
import pg from 'pg';

const schema = process.env.DATABASE_SCHEMA;

// The suite is over: its connections close, and the schema it made goes with it.
afterAll(async () => {
  const opened = globalThis.__tallyDatabases;
  if (opened) await Promise.all([...opened].map(database => database.close()));
  if (!schema?.startsWith('suite_')) return;
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } catch {
    // Nothing to drop is not a failure of the suite.
  } finally {
    await client.end().catch(() => undefined);
  }
});
