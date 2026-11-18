import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { Notice } from '@Contexts/Notifications/Domain/Notice/Notice';
import { INotices } from '@Contexts/Notifications/Domain/Notice/Ports/INotices';

/**
 * The table of the notices: one row per notice. At most one for a person and an expense (the key `expense_id`), so that a fact handed to
 * the reaction twice across a restart, which the bus's in-memory inbox does not remember, still makes one (request 17). A reminder names no
 * expense (request 18): its `expense_id` is NULL, and NULLs do not meet in the key. A budget's notice (request 24, docs/adr/0023) names no
 * expense either, so it has a key of its own: one per person, group, category and month, in `budget_key`. `seq` numbers the rows in the
 * order they were made, the order a person's notices are listed in when they share a time.
 */
export async function prepareNoticeSchema(database: PostgresDatabase): Promise<void> {
  await database.exec(
    'CREATE TABLE IF NOT EXISTS notices (seq BIGSERIAL NOT NULL UNIQUE, id TEXT PRIMARY KEY, account_id TEXT NOT NULL, kind TEXT NOT NULL, group_id TEXT NOT NULL, expense_id TEXT, amount INTEGER NOT NULL, at TEXT NOT NULL, category TEXT, month TEXT, budget INTEGER, budget_key TEXT, UNIQUE (account_id, expense_id))',
  );
  await database.exec('CREATE UNIQUE INDEX IF NOT EXISTS notices_by_budget ON notices (account_id, budget_key)');
}

/** The notices' store over PostgreSQL: its methods run inside the reaction's transaction. */
export class PostgresNotices implements INotices {
  constructor(private readonly database: PostgresDatabase) {
    database.prepare(prepareNoticeSchema);
  }

  async save(notice: Notice): Promise<boolean> {
    this.database.assertInTransaction();
    const s = notice.toSnapshot();
    // A budget's notice is one per person, group, category and month: the key a fact handed twice finds.
    const budgetKey = s.kind === 'budget' ? `${s.groupId}|${s.category}|${s.month}` : null;
    const { changes } = await this.database.run(
      'INSERT INTO notices (id, account_id, kind, group_id, expense_id, amount, at, category, month, budget, budget_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
      [
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
      ],
    );
    return Number(changes) > 0;
  }
}
