import { DatabaseSync } from 'node:sqlite';

import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { Notice } from '@Contexts/Notifications/Domain/Notice/Notice';
import { INotices } from '@Contexts/Notifications/Domain/Notice/Ports/INotices';

/**
 * The table of the notices: one row per notice, at most one for a person and an expense (the key), so that a fact handed to the
 * reaction twice across a restart, which the bus's in-memory inbox does not remember, still makes one (request 17).
 */
export function prepareNoticeSchema(connection: DatabaseSync): void {
  connection.exec(
    'CREATE TABLE IF NOT EXISTS notices (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, kind TEXT NOT NULL, group_id TEXT NOT NULL, expense_id TEXT NOT NULL, amount INTEGER NOT NULL, at TEXT NOT NULL, UNIQUE (account_id, expense_id))',
  );
}

/** The notices' store over SQLite: its methods run inside the reaction's transaction. */
export class SqliteNotices implements INotices {
  constructor(private readonly database: SqliteDatabase) {
    database.prepare(prepareNoticeSchema);
  }

  async save(notice: Notice): Promise<boolean> {
    this.database.assertInTransaction();
    const s = notice.toSnapshot();
    const { changes } = this.database.connection
      .prepare(
        'INSERT INTO notices (id, account_id, kind, group_id, expense_id, amount, at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (account_id, expense_id) DO NOTHING',
      )
      .run(s.id, s.accountId, s.kind, s.groupId, s.expenseId, s.amount, s.at);
    return Number(changes) > 0;
  }
}
