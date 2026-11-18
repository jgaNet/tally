import { ConcurrencyConflictException, IResult, Result } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { Notice } from '@Contexts/Notifications/Domain/Notice/Notice';
import { INoticeRepository } from '@Contexts/Notifications/Domain/Notice/Ports/INoticeRepository';

/**
 * The table of notices: one row per notice, at most one per expense and recipient (a notice is made once from the fact). A
 * reminder has no expense (its `expense_id` is NULL, request 18): the uniqueness of a reminder is its debt watch's, not this one's.
 * A budget's notice has no expense either, and names its category, month and budget (request 24); its uniqueness is the fact's, which
 * Ledger publishes once a month.
 */
export function createNoticeTables(database: SqliteDatabase): void {
  database.connection.exec(`
    CREATE TABLE IF NOT EXISTS notices (
      id TEXT PRIMARY KEY,
      recipient TEXT NOT NULL,
      kind TEXT NOT NULL,
      group_id TEXT NOT NULL,
      expense_id TEXT,
      amount INTEGER NOT NULL,
      at TEXT NOT NULL,
      version INTEGER NOT NULL,
      UNIQUE (expense_id, recipient)
    );
    CREATE INDEX IF NOT EXISTS notices_by_recipient ON notices (recipient, at);
  `);
  // The budget a notice of a passed budget names (request 24): NULL for every other notice, and for those made before it.
  const columns = database.connection.prepare('PRAGMA table_info(notices)').all() as unknown as { name: string }[];
  for (const [name, type] of [
    ['category', 'TEXT'],
    ['month', 'TEXT'],
    ['budget_amount', 'INTEGER'],
  ]) {
    if (!columns.some(column => column.name === name)) {
      database.connection.exec(`ALTER TABLE notices ADD COLUMN ${name} ${type}`);
    }
  }
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
        `INSERT INTO notices (id, recipient, kind, group_id, expense_id, amount, at, version, category, month, budget_amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?) ON CONFLICT DO NOTHING`,
      )
      .run(
        snapshot._id,
        snapshot.recipient,
        snapshot.kind,
        snapshot.groupId,
        snapshot.expenseId,
        snapshot.amount,
        snapshot.at.toISOString(),
        snapshot.passing?.category ?? null,
        snapshot.passing?.month ?? null,
        snapshot.passing?.budget ?? null,
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
