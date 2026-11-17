import { ConcurrencyConflictException, IResult, Result } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { Notice } from '@Contexts/Notifications/Domain/Notice/Notice';
import { INoticeRepository } from '@Contexts/Notifications/Domain/Notice/Ports/INoticeRepository';

/** The table of notices: one row per notice, at most one per expense and recipient (a notice is made once from the fact). */
export function createNoticeTables(database: SqliteDatabase): void {
  database.connection.exec(`
    CREATE TABLE IF NOT EXISTS notices (
      id TEXT PRIMARY KEY,
      recipient TEXT NOT NULL,
      kind TEXT NOT NULL,
      group_id TEXT NOT NULL,
      expense_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      at TEXT NOT NULL,
      version INTEGER NOT NULL,
      UNIQUE (expense_id, recipient)
    );
    CREATE INDEX IF NOT EXISTS notices_by_recipient ON notices (recipient, at);
  `);
}

/**
 * The notices over the application's SQLite file, inside the reaction's transaction. A notice is inserted once, at version
 * 1, and never changed; a second notice of the same expense to the same recipient, saved by another writer since the
 * reaction read who was told, inserts nothing and is refused as a ConcurrencyConflictException (CONC-OPTIMISTIC).
 */
export class SqliteNoticeRepository implements INoticeRepository {
  constructor(private database: SqliteDatabase) {
    createNoticeTables(database);
  }

  async recipientsOf(expenseId: string): Promise<string[]> {
    const rows = this.database.connection
      .prepare('SELECT recipient FROM notices WHERE expense_id = ?')
      .all(expenseId) as { recipient: string }[];
    return rows.map(row => row.recipient);
  }

  async save(notice: Notice): Promise<IResult> {
    const snapshot = notice.toSnapshot();
    if (snapshot.version !== 0) throw new Error(`Notice ${snapshot._id} is saved again: a notice does not change`);
    const inserted = this.database.connection
      .prepare(
        `INSERT INTO notices (id, recipient, kind, group_id, expense_id, amount, at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1) ON CONFLICT DO NOTHING`,
      )
      .run(
        snapshot._id,
        snapshot.recipient,
        snapshot.kind,
        snapshot.groupId,
        snapshot.expenseId,
        snapshot.amount,
        snapshot.at.toISOString(),
      );
    if (inserted.changes === 0) {
      return Result.fail(
        new ConcurrencyConflictException('Notifications', 'The member was already told of this expense', {
          expenseId: snapshot.expenseId,
          recipient: snapshot.recipient,
        }),
      );
    }
    return Result.ok();
  }
}
