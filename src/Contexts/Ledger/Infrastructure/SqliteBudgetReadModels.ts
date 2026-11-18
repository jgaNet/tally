import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { IBudgetQueries } from '@Contexts/Ledger/Application/Ports/IBudgetQueries';
import { IBudgetSpending } from '@Contexts/Ledger/Application/Ports/IBudgetSpending';
import { BudgetReadModel } from '@Contexts/Ledger/Application/ReadModel/BudgetReadModel';
import { CATEGORIES, CategoryName } from '@Contexts/Ledger/Domain/Expense/Category';
import { createLedgerTables } from '@Contexts/Ledger/Infrastructure/LedgerTables';

const SPENT = `SELECT COALESCE(SUM(amount), 0) AS spent FROM expenses
               WHERE group_id = ? AND category = ? AND substr(spent_on, 1, 7) = ?`;

/**
 * The budgets' read models, over Ledger's own expenses (request 24): what a month spends in a category is the sum of the amounts of
 * the expenses stored, the deleted ones being gone from the table. `ofGroup` is read outside any transaction, so it waits for the
 * one in progress; `spentIn` is read by a reaction, inside its transaction, so it takes no lock.
 */
export class SqliteBudgetReadModels implements IBudgetQueries, IBudgetSpending {
  constructor(private database: SqliteDatabase) {
    createLedgerTables(database);
  }

  async ofGroup(groupId: string, month: string): Promise<BudgetReadModel[]> {
    return this.database.exclusive(() => {
      const rows = this.database.all<{ category: CategoryName; amount: number }>(
        'SELECT category, amount FROM budgets WHERE group_id = ? AND removed = 0',
        groupId,
      );
      return rows
        .sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category))
        .map(row => ({
          category: row.category,
          amount: row.amount,
          spent: this.database.get<{ spent: number }>(SPENT, groupId, row.category, month)?.spent ?? 0,
        }));
    });
  }

  async spentIn(groupId: string, category: CategoryName, month: string): Promise<number> {
    return this.database.get<{ spent: number }>(SPENT, groupId, category, month)?.spent ?? 0;
  }
}
