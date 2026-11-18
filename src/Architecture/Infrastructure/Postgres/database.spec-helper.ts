import { randomUUID } from 'node:crypto';

import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

/** A database of its own, on the server the tests run against (jest.setup.js), for a spec that needs a clean one. */
export function freshDatabase(): PostgresDatabase {
  const url = new URL(process.env.TALLY_TEST_SERVER_URL ?? process.env.DATABASE_URL ?? '');
  url.pathname = `/tally_test_${randomUUID().replace(/-/g, '')}`;
  return new PostgresDatabase(url.toString());
}
