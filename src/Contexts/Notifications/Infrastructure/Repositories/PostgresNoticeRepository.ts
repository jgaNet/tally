import { ConcurrencyConflictException, IResult, Result } from '@Architecture/Domain';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { Notice } from '@Contexts/Notifications/Domain/Notice/Notice';
import { INoticeRepository } from '@Contexts/Notifications/Domain/Notice/Ports/INoticeRepository';

/**
 * The table of notices: one row per notice, at most one per expense and recipient (a notice is made once from the fact). A
 * reminder has no expense (its `expense_id` is NULL, request 18): the uniqueness of a reminder is its debt watch's, not this one's.
 * A budget's notice has no expense either, and names its category, month and budget (request 24); its uniqueness is the fact's, which
 * Ledger publishes once a month. `seq` is the order the notices were made in, the tie-break of the most recent first.
 */
export function createNoticeTables(database: PostgresDatabase): void {
  database.define(`
    CREATE TABLE IF NOT EXISTS notices (
      id TEXT PRIMARY KEY,
      recipient TEXT NOT NULL,
      kind TEXT NOT NULL,
      group_id TEXT NOT NULL,
      expense_id TEXT,
      amount INTEGER NOT NULL,
      at TEXT NOT NULL,
      version INTEGER NOT NULL,
      category TEXT,
      month TEXT,
      budget_amount INTEGER,
      seq BIGSERIAL NOT NULL,
      UNIQUE (expense_id, recipient)
    );
    CREATE INDEX IF NOT EXISTS notices_by_recipient ON notices (recipient, at);
  `);
}

/**
 * The notices over the application's PostgreSQL database, inside the reaction's transaction. A notice is inserted once, at version
 * 1, and never changed; a second notice of the same expense to the same recipient, saved by another writer since the
 * reaction read who was told, inserts nothing and is refused as a ConcurrencyConflictException (CONC-OPTIMISTIC).
 */
export class PostgresNoticeRepository implements INoticeRepository {
  constructor(private database: PostgresDatabase) {
    createNoticeTables(database);
  }

  async recipientsOf(expenseId: string): Promise<string[]> {
    const rows = await this.database.all<{ recipient: string }>('SELECT recipient FROM notices WHERE expense_id = ?', [
      expenseId,
    ]);
    return rows.map(row => row.recipient);
  }

  async save(notice: Notice): Promise<IResult> {
    const snapshot = notice.toSnapshot();
    if (snapshot.version !== 0) throw new Error(`Notice ${snapshot._id} is saved again: a notice does not change`);
    const inserted = await this.database.run(
      `INSERT INTO notices (id, recipient, kind, group_id, expense_id, amount, at, version, category, month, budget_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?) ON CONFLICT DO NOTHING`,
      [
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
      ],
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
