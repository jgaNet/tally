import { ConcurrencyConflictException, IResult, Result } from '@Architecture/Domain';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { DebtWatch } from '@Contexts/Notifications/Domain/Debt/DebtWatch';
import { IDebtWatches, IDebtWatchQueries } from '@Contexts/Notifications/Domain/Debt/Ports/IDebtWatches';

/**
 * The table of the debt watches: one row per member and group (the key), holding when the debt was noted and when the member was last
 * reminded, and the version a save checks (request 18, docs/adr/0018).
 */
export async function prepareDebtWatchSchema(database: PostgresDatabase): Promise<void> {
  await database.exec(
    'CREATE TABLE IF NOT EXISTS debt_watches (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, group_id TEXT NOT NULL, noted_since TEXT, last_reminded_at TEXT, version INTEGER NOT NULL, UNIQUE (account_id, group_id))',
  );
}

type WatchRow = {
  id: string;
  account_id: string;
  group_id: string;
  noted_since: string | null;
  last_reminded_at: string | null;
  version: number;
};

const watchOf = (row: WatchRow): DebtWatch =>
  DebtWatch.fromSnapshot({
    id: String(row.id),
    version: Number(row.version),
    accountId: String(row.account_id),
    groupId: String(row.group_id),
    ...(row.noted_since === null ? {} : { notedSince: String(row.noted_since) }),
    ...(row.last_reminded_at === null ? {} : { lastRemindedAt: String(row.last_reminded_at) }),
  });

const changedSinceRead = () =>
  new ConcurrencyConflictException('Notifications', 'The debt watch of the member changed since it was read');

/** The debt watches' store over PostgreSQL. Its methods run inside the sweep's transaction (docs/adr/0018). */
export class PostgresDebtWatches implements IDebtWatches {
  constructor(private readonly database: PostgresDatabase) {
    database.prepare(prepareDebtWatchSchema);
  }

  async get(accountId: string, groupId: string): Promise<DebtWatch> {
    this.database.assertInTransaction();
    const row = await this.database.get<WatchRow>(
      'SELECT id, account_id, group_id, noted_since, last_reminded_at, version FROM debt_watches WHERE account_id = ? AND group_id = ?',
      [accountId, groupId],
    );
    return row ? watchOf(row) : DebtWatch.open({ accountId, groupId });
  }

  async save(watch: DebtWatch): Promise<IResult<undefined>> {
    this.database.assertInTransaction();
    const s = watch.toSnapshot();
    if (watch.version === 0) {
      const { changes } = await this.database.run(
        'INSERT INTO debt_watches (id, account_id, group_id, noted_since, last_reminded_at, version) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (account_id, group_id) DO NOTHING',
        [s.id, s.accountId, s.groupId, s.notedSince ?? null, s.lastRemindedAt ?? null, 1],
      );
      if (Number(changes) === 0) return Result.fail(changedSinceRead());
    } else {
      const { changes } = await this.database.run(
        'UPDATE debt_watches SET noted_since = ?, last_reminded_at = ?, version = ? WHERE id = ? AND version = ?',
        [s.notedSince ?? null, s.lastRemindedAt ?? null, watch.version + 1, s.id, watch.version],
      );
      if (Number(changes) === 0) return Result.fail(changedSinceRead());
    }
    return Result.ok(undefined);
  }
}

/** The read side of the debt watches, over the same table (request 18). */
export class PostgresDebtWatchQueries implements IDebtWatchQueries {
  constructor(private readonly database: PostgresDatabase) {
    database.prepare(prepareDebtWatchSchema);
  }

  async noted(): Promise<Array<{ accountId: string; groupId: string }>> {
    return this.database.exclusive(async () =>
      (
        await this.database.all<{ account_id: string; group_id: string }>(
          'SELECT account_id, group_id FROM debt_watches WHERE noted_since IS NOT NULL',
        )
      ).map(row => ({ accountId: String(row.account_id), groupId: String(row.group_id) })),
    );
  }
}
