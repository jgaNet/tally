import { DatabaseSync } from 'node:sqlite';

import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { Notice } from '@Contexts/Notifications/Domain/Notice/Notice';
import { INotices } from '@Contexts/Notifications/Domain/Notice/Ports/INotices';

/**
 * The table of the notices: one row per notice. At most one for a person and an expense (the key `expense_id`), so that a fact handed to
 * the reaction twice across a restart, which the bus's in-memory inbox does not remember, still makes one (request 17). A reminder names no
 * expense (request 18): its `expense_id` is NULL, and NULLs do not meet in the key. A budget's notice (request 24, docs/adr/0023) names no
 * expense either, so it has a key of its own: one per person, group, category and month, in `budget_key`.
 */
export function prepareNoticeSchema(connection: DatabaseSync): void {
  connection.exec(
    'CREATE TABLE IF NOT EXISTS notices (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, kind TEXT NOT NULL, group_id TEXT NOT NULL, expense_id TEXT, amount INTEGER NOT NULL, at TEXT NOT NULL, UNIQUE (account_id, expense_id))',
  );
  // A file made before budgets (request 24) has none of these columns: a budget's notice names its category, month and budget.
  const columns = (connection.prepare('PRAGMA table_info(notices)').all() as Array<{ name: string }>).map(
    column => column.name,
  );
  for (const [name, type] of [
    ['category', 'TEXT'],
    ['month', 'TEXT'],
    ['budget', 'INTEGER'],
    ['budget_key', 'TEXT'],
  ] as const) {
    if (!columns.includes(name)) connection.exec(`ALTER TABLE notices ADD COLUMN ${name} ${type}`);
  }
  connection.exec('CREATE UNIQUE INDEX IF NOT EXISTS notices_by_budget ON notices (account_id, budget_key)');
}

/** The notices' store over SQLite: its methods run inside the reaction's transaction. */
export class SqliteNotices implements INotices {
  constructor(private readonly database: SqliteDatabase) {
    database.prepare(prepareNoticeSchema);
  }

  async save(notice: Notice): Promise<boolean> {
    this.database.assertInTransaction();
    const s = notice.toSnapshot();
    // A budget's notice is one per person, group, category and month: the key a fact handed twice finds.
    const budgetKey = s.kind === 'budget' ? `${s.groupId}|${s.category}|${s.month}` : null;
    const { changes } = this.database.connection
      .prepare(
        'INSERT INTO notices (id, account_id, kind, group_id, expense_id, amount, at, category, month, budget, budget_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
      )
      .run(
        s.id,
        s.accountId,
        s.kind,
        s.groupId,
        s.expenseId ?? null,
        s.amount,
        s.at,
        s.category ?? null,
        s.month ?? null,
        s.budget ?? null,
        budgetKey,
      );
    return Number(changes) > 0;
  }
}
