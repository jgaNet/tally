import { Client } from 'pg';

// Drops the databases this run made on the server `DATABASE_URL` names. Other runs' databases are not touched.
export default async function globalTeardown(): Promise<void> {
  const serverUrl = process.env.DATABASE_URL;
  const run = process.env.TALLY_TEST_RUN;
  if (!serverUrl || !run) {
    return;
  }
  const admin = new Client({ connectionString: serverUrl });
  await admin.connect();
  try {
    const { rows } = await admin.query<{ datname: string }>('SELECT datname FROM pg_database WHERE datname LIKE $1', [
      `tally_test_${run}_%`,
    ]);
    for (const { datname } of rows) {
      await admin.query(`DROP DATABASE IF EXISTS ${datname} WITH (FORCE)`);
    }
  } finally {
    await admin.end();
  }
}
