import { randomUUID } from 'node:crypto';

// Each test file has a PostgreSQL database of its own (ADR 22), on the server DATABASE_URL names: the application creates it
// at its first use. A suite that starts two servers on one database starts both in the same file.
if (process.env.DATABASE_URL) {
  process.env.TALLY_TEST_SERVER_URL ||= process.env.DATABASE_URL;
  const url = new URL(process.env.TALLY_TEST_SERVER_URL);
  url.pathname = `/tally_test_${randomUUID().replace(/-/g, '')}`;
  process.env.DATABASE_URL = url.toString();
}
