import { ConcurrencyConflictException, IResult, Result } from '@Architecture/Domain';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { Budget } from '@Contexts/Ledger/Domain/Budget/Budget';
import { IBudgetSnapshot } from '@Contexts/Ledger/Domain/Budget/DTOs';
import { IBudgetRepository } from '@Contexts/Ledger/Domain/Budget/Ports/IBudgetRepository';
import { Category } from '@Contexts/Ledger/Domain/Expense/Category';

/**
 * The tables of budgets (request 24): one row per group and category, with its amount (NULL once removed) and its version,
 * and one row per month a budget passed, so that a month is notified once, whatever the budget does after.
 * Declared with the database, which makes them when it opens (ADR 20).
 */
export function defineBudgetTables(database: PostgresDatabase): void {
  database.define(`
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

/** The budgets as aggregates, over the application's PostgreSQL database, inside the transaction of the command or the reaction. */
export class PostgresBudgetRepository implements IBudgetRepository {
  constructor(private database: PostgresDatabase) {
    defineBudgetTables(database);
  }

  async findFor(groupId: string, category: Category): Promise<Budget | null> {
    const row = await this.database.get<BudgetRow>('SELECT * FROM budgets WHERE group_id = ? AND category = ?', [
      groupId,
      category,
    ]);
    if (!row) return null;

    const months = await this.database.all<{ month: string }>(
      'SELECT month FROM budget_passings WHERE budget_id = ? ORDER BY month',
      [row.id],
    );
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

    if (snapshot.version === 0) {
      const inserted = await this.database.run(
        'INSERT INTO budgets (id, group_id, category, amount, version) VALUES (?, ?, ?, ?, 1) ON CONFLICT DO NOTHING',
        [snapshot._id, snapshot.groupId, snapshot.category, snapshot.amount],
      );
      if (inserted.changes === 0) {
        return Result.fail(
          new ConcurrencyConflictException('Ledger', 'The category already has a budget', {
            category: snapshot.category,
          }),
        );
      }
    } else {
      const updated = await this.database.run(
        'UPDATE budgets SET amount = ?, version = ? WHERE id = ? AND version = ?',
        [snapshot.amount, snapshot.version + 1, snapshot._id, snapshot.version],
      );
      if (updated.changes === 0) {
        return Result.fail(
          new ConcurrencyConflictException('Ledger', 'The budget changed since it was read', { id: snapshot._id }),
        );
      }
    }

    for (const month of snapshot.passedMonths) {
      await this.database.run('INSERT INTO budget_passings (budget_id, month) VALUES (?, ?) ON CONFLICT DO NOTHING', [
        snapshot._id,
        month,
      ]);
    }
    return Result.ok();
  }
}
