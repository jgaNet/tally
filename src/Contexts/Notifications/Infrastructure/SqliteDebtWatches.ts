import { DatabaseSync } from 'node:sqlite';

import { ConcurrencyConflictException, IResult, Result } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { DebtWatch } from '@Contexts/Notifications/Domain/Debt/DebtWatch';
import { IDebtWatches, IDebtWatchQueries } from '@Contexts/Notifications/Domain/Debt/Ports/IDebtWatches';

/**
 * The table of the debt watches: one row per member and group (the key), holding when the debt was noted and when the member was last
 * reminded, and the version a save checks (request 18, docs/adr/0018).
 */
export function prepareDebtWatchSchema(connection: DatabaseSync): void {
  connection.exec(
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

/** The debt watches' store over SQLite. Its methods run inside the sweep's transaction (docs/adr/0018). */
export class SqliteDebtWatches implements IDebtWatches {
  constructor(private readonly database: SqliteDatabase) {
    database.prepare(prepareDebtWatchSchema);
  }

  async get(accountId: string, groupId: string): Promise<DebtWatch> {
    this.database.assertInTransaction();
    const row = this.database.connection
      .prepare(
        'SELECT id, account_id, group_id, noted_since, last_reminded_at, version FROM debt_watches WHERE account_id = ? AND group_id = ?',
      )
      .get(accountId, groupId) as WatchRow | undefined;
    return row ? watchOf(row) : DebtWatch.open({ accountId, groupId });
  }

  async save(watch: DebtWatch): Promise<IResult<undefined>> {
    this.database.assertInTransaction();
    const s = watch.toSnapshot();
    const connection = this.database.connection;
    if (watch.version === 0) {
      const { changes } = connection
        .prepare(
          'INSERT INTO debt_watches (id, account_id, group_id, noted_since, last_reminded_at, version) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (account_id, group_id) DO NOTHING',
        )
        .run(s.id, s.accountId, s.groupId, s.notedSince ?? null, s.lastRemindedAt ?? null, 1);
      if (Number(changes) === 0) return Result.fail(changedSinceRead());
    } else {
      const { changes } = connection
        .prepare(
          'UPDATE debt_watches SET noted_since = ?, last_reminded_at = ?, version = ? WHERE id = ? AND version = ?',
        )
        .run(s.notedSince ?? null, s.lastRemindedAt ?? null, watch.version + 1, s.id, watch.version);
      if (Number(changes) === 0) return Result.fail(changedSinceRead());
    }
    return Result.ok(undefined);
  }
}

/** The read side of the debt watches, over the same table (request 18). */
export class SqliteDebtWatchQueries implements IDebtWatchQueries {
  constructor(private readonly database: SqliteDatabase) {
    database.prepare(prepareDebtWatchSchema);
  }

  async noted(): Promise<Array<{ accountId: string; groupId: string }>> {
    return this.database.exclusive(() =>
      (
        this.database.connection
          .prepare('SELECT account_id, group_id FROM debt_watches WHERE noted_since IS NOT NULL')
          .all() as Array<{ account_id: string; group_id: string }>
      ).map(row => ({ accountId: String(row.account_id), groupId: String(row.group_id) })),
    );
  }
}
