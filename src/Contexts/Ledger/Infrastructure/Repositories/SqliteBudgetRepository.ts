import { ConcurrencyConflictException, IResult, Result } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { Budget } from '@Contexts/Ledger/Domain/Budget/Budget';
import { IBudgetSnapshot } from '@Contexts/Ledger/Domain/Budget/DTOs';
import { IBudgetRepository } from '@Contexts/Ledger/Domain/Budget/Ports/IBudgetRepository';
import { Category } from '@Contexts/Ledger/Domain/Expense/Category';

/**
 * The tables of budgets (request 24): one row per group and category, with its amount (NULL once removed) and its version,
 * and one row per month a budget passed, so that a month is notified once, whatever the budget does after.
 */
export function createBudgetTables(database: SqliteDatabase): void {
  database.connection.exec(`
    CREATE TABLE IF NOT EXISTS budgets (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      category TEXT NOT NULL,
      amount INTEGER,
      version INTEGER NOT NULL,
      UNIQUE (group_id, category)
    );
    CREATE TABLE IF NOT EXISTS budget_passings (
      budget_id TEXT NOT NULL,
      month TEXT NOT NULL,
      PRIMARY KEY (budget_id, month)
    );
  `);
}

interface BudgetRow {
  id: string;
  group_id: string;
  category: string;
  amount: number | null;
  version: number;
}

/** The budgets as aggregates, over the application's SQLite file, inside the transaction of the command or the reaction. */
export class SqliteBudgetRepository implements IBudgetRepository {
  constructor(private database: SqliteDatabase) {
    createBudgetTables(database);
  }

  async findFor(groupId: string, category: Category): Promise<Budget | null> {
    const connection = this.database.connection;
    const row = connection
      .prepare('SELECT * FROM budgets WHERE group_id = ? AND category = ?')
      .get(groupId, category) as BudgetRow | undefined;
    if (!row) return null;

    const months = connection
      .prepare('SELECT month FROM budget_passings WHERE budget_id = ? ORDER BY month')
      .all(row.id) as { month: string }[];
    const snapshot: IBudgetSnapshot = {
      _id: row.id,
      groupId: row.group_id,
      category: row.category as Category,
      amount: row.amount,
      passedMonths: months.map(passing => passing.month),
      version: row.version,
    };
    return Budget.fromSnapshot(snapshot);
  }

  /**
   * A new budget is inserted at version 1; one read at a version is updated only where the row is still at it, as SQL makes
   * the check atomic. A new budget whose category already has one stored, or a changed one no longer at its version, is
   * refused as a ConcurrencyConflictException (CONC-OPTIMISTIC).
   */
  async save(budget: Budget): Promise<IResult> {
    const snapshot = budget.toSnapshot();
    const connection = this.database.connection;

    if (snapshot.version === 0) {
      const inserted = connection
        .prepare(
          'INSERT INTO budgets (id, group_id, category, amount, version) VALUES (?, ?, ?, ?, 1) ON CONFLICT DO NOTHING',
        )
        .run(snapshot._id, snapshot.groupId, snapshot.category, snapshot.amount);
      if (inserted.changes === 0) {
        return Result.fail(
          new ConcurrencyConflictException('Ledger', 'The category already has a budget', {
            category: snapshot.category,
          }),
        );
      }
    } else {
      const updated = connection
        .prepare('UPDATE budgets SET amount = ?, version = ? WHERE id = ? AND version = ?')
        .run(snapshot.amount, snapshot.version + 1, snapshot._id, snapshot.version);
      if (updated.changes === 0) {
        return Result.fail(
          new ConcurrencyConflictException('Ledger', 'The budget changed since it was read', { id: snapshot._id }),
        );
      }
    }

    const passing = connection.prepare(
      'INSERT INTO budget_passings (budget_id, month) VALUES (?, ?) ON CONFLICT DO NOTHING',
    );
    for (const month of snapshot.passedMonths) passing.run(snapshot._id, month);
    return Result.ok();
  }
}
