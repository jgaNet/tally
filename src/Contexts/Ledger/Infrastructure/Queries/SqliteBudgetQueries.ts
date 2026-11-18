import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { CATEGORIES, Category } from '@Contexts/Ledger/Domain/Expense/Category';
import { BudgetView, IBudgetQueries } from '@Contexts/Ledger/Domain/Budget/Ports/IBudgetQueries';
import { createExpensesTables } from '@Contexts/Ledger/Infrastructure/Repositories/SqliteExpenseRepository';
import { createBudgetTables } from '@Contexts/Ledger/Infrastructure/Repositories/SqliteBudgetRepository';

/**
 * The read side of budgets over the same file (request 24): the budgets that are set, each with what the month spends in its
 * category, the expenses dated in the month in UTC (YYYY-MM is the first seven characters of the day), deleted ones left out.
 */
export class SqliteBudgetQueries implements IBudgetQueries {
  constructor(private database: SqliteDatabase) {
    createExpensesTables(database);
    createBudgetTables(database);
  }

  async listGroupBudgets(groupId: string, month: string): Promise<BudgetView[]> {
    const rows = this.database.connection
      .prepare('SELECT category, amount FROM budgets WHERE group_id = ? AND amount IS NOT NULL')
      .all(groupId) as { category: Category; amount: number }[];
    return rows
      .sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category))
      .map(row => ({
        category: row.category,
        amount: row.amount,
        spent: this.sumIn(groupId, row.category, month),
      }));
  }

  async spentIn(groupId: string, category: Category, month: string): Promise<number> {
    return this.sumIn(groupId, category, month);
  }

  private sumIn(groupId: string, category: Category, month: string): number {
    const row = this.database.connection
      .prepare(
        'SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE group_id = ? AND category = ? AND substr(spent_on, 1, 7) = ?',
      )
      .get(groupId, category, month) as { total: number };
    return row.total;
  }
}
