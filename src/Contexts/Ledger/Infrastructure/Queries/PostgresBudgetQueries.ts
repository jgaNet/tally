import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { CATEGORIES, Category } from '@Contexts/Ledger/Domain/Expense/Category';
import { BudgetView, IBudgetQueries } from '@Contexts/Ledger/Domain/Budget/Ports/IBudgetQueries';
import { defineExpensesTables } from '@Contexts/Ledger/Infrastructure/Repositories/PostgresExpenseRepository';
import { defineBudgetTables } from '@Contexts/Ledger/Infrastructure/Repositories/PostgresBudgetRepository';

/**
 * The read side of budgets over the same database (request 24): the budgets that are set, each with what the month spends in its
 * category, the expenses dated in the month in UTC (YYYY-MM is the first seven characters of the day), deleted ones left out.
 */
export class PostgresBudgetQueries implements IBudgetQueries {
  constructor(private database: PostgresDatabase) {
    defineExpensesTables(database);
    defineBudgetTables(database);
  }

  async listGroupBudgets(groupId: string, month: string): Promise<BudgetView[]> {
    const rows = await this.database.all<{ category: Category; amount: number }>(
      'SELECT category, amount FROM budgets WHERE group_id = ? AND amount IS NOT NULL',
      [groupId],
    );
    const views: BudgetView[] = [];
    for (const row of rows.sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category))) {
      views.push({
        category: row.category,
        amount: row.amount,
        spent: await this.sumIn(groupId, row.category, month),
      });
    }
    return views;
  }

  async spentIn(groupId: string, category: Category, month: string): Promise<number> {
    return this.sumIn(groupId, category, month);
  }

  /** A SUM is a bigint, which the driver returns as a string: it is read back as a number. */
  private async sumIn(groupId: string, category: Category, month: string): Promise<number> {
    const row = await this.database.get<{ total: string | number }>(
      'SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE group_id = ? AND category = ? AND substr(spent_on, 1, 7) = ?',
      [groupId, category, month],
    );
    return Number(row?.total ?? 0);
  }
}
