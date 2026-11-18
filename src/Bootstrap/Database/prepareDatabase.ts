import { existsSync } from 'node:fs';

import { PostgresDatabase, sharedDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { LegacyUpgrade, moveSqliteFile } from '@Bootstrap/Database/moveSqliteFile';

/**
 * Makes the database what the application reads, before the server serves (docs/adr/0029). Under the advisory lock,
 * in one transaction: when the database holds nothing of Tally's yet, every schema step runs, then, if `legacyPath`
 * names a SQLite file Tally kept, everything the file holds is moved into the database, then every seed step runs.
 * A second server that waits for the lock finds the database prepared and does nothing but its seeds; from then on the file
 * is not read again. A database that holds Tally's tables is never prepared twice.
 *
 * The move and the preparation are one transaction: a failure in either leaves the database empty, and the next start
 * tries again with the file still in place.
 */
export async function prepareDatabase(
  database: PostgresDatabase = sharedDatabase,
  {
    legacyPath = process.env.DATABASE_PATH,
    legacyUpgrades = [],
  }: { legacyPath?: string; legacyUpgrades?: LegacyUpgrade[] } = {},
): Promise<void> {
  await database.transaction(async () => {
    const [{ present }] = await database.all<{ present: boolean }>('SELECT to_regclass(?) IS NOT NULL AS present', [
      'outbox',
    ]);
    if (!present) {
      for (const setup of database.setups) await setup(database);
      if (legacyPath && existsSync(legacyPath)) {
        await moveSqliteFile(database, legacyPath, legacyUpgrades);
      }
    }
    // Seeds run on every start: each is idempotent (it inserts what is missing and reads back what is there), so a
    // restart finds the session key the database already holds.
    for (const step of database.seeds) await step(database);
  });
}
