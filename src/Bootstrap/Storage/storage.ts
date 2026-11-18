import { existsSync } from 'node:fs';

import {
  PostgresDatabase,
  PostgresTables,
  databaseUrl,
} from '@Architecture/Infrastructure/DataSources/PostgresDatabase';
import { STATE_TABLE_SQL, moveFromFile } from '@Architecture/Infrastructure/DataSources/MoveFromFile';
import { OUTBOX_TABLE_SQL } from '@Architecture/Infrastructure/Outbox/PostgresOutbox';
import { INBOX_TABLE_SQL } from '@Architecture/Infrastructure/EventBus/PostgresInbox';

/**
 * Makes the database ready before the server serves (ADR 27): the tables of every context, the outbox and the bus's inbox, and, when
 * `DATABASE_PATH` names a file Tally kept (by this version or an earlier one) and the database holds nothing of Tally's yet, the move of
 * everything that file holds into it (`moveFromFile`, once). Several servers may start on one database: the set-up takes the writers' lock,
 * so the second one waits and finds it done.
 */
export async function prepareStorage(contexts: PostgresTables[]): Promise<void> {
  const database = PostgresDatabase.of(databaseUrl());
  await database.setUp(async () => {
    await database.query(STATE_TABLE_SQL + OUTBOX_TABLE_SQL + INBOX_TABLE_SQL);
  });
  for (const context of contexts) await context.ready();
  const file = process.env.DATABASE_PATH;
  if (file && existsSync(file)) await moveFromFile(database, file, contexts);
}
