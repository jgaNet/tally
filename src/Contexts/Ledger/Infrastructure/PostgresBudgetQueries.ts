import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { BudgetView } from '@Contexts/Ledger/Domain/Budget/DTOs';
import { IBudgetQueries } from '@Contexts/Ledger/Domain/Budget/Ports/IBudgetQueries';
import { CATEGORIES, Category } from '@Contexts/Ledger/Domain/Expense/Category';
import { prepareLedgerSchema } from '@Contexts/Ledger/Infrastructure/PostgresExpenseRepository';
import {
  BUDGET_COLUMNS,
  BudgetRow,
  prepareBudgetSchema,
  budgetSnapshotOf,
} from '@Contexts/Ledger/Infrastructure/PostgresBudgets';

/** The read side of the budgets over PostgreSQL: reads taken alone, outside any transaction (request 24). */
export class PostgresBudgetQueries implements IBudgetQueries {
  constructor(private readonly database: PostgresDatabase) {
    database.prepare(prepareBudgetSchema);
    database.prepare(prepareLedgerSchema);
  }

  async listOf(groupId: string, month: string): Promise<BudgetView[]> {
    return this.database.exclusive(async () => {
      const rows = await this.database.all<BudgetRow>(
        `SELECT ${BUDGET_COLUMNS} FROM budgets WHERE group_id = ? AND amount IS NOT NULL`,
        [groupId],
      );
      const spentRows = await this.database.all<{ category: string; spent: number }>(
        'SELECT category, SUM(amount) AS spent FROM expenses WHERE group_id = ? AND substr(date, 1, 7) = ? GROUP BY category',
        [groupId, month],
      );
      const spent = new Map(spentRows.map(row => [String(row.category), Number(row.spent)]));
      return rows
        .map(row => budgetSnapshotOf(row))
        .map((budget): BudgetView => ({
          category: budget.category,
          amount: budget.amount ?? 0,
          spent: spent.get(budget.category) ?? 0,
        }))
        .sort((a, b) => CATEGORIES.indexOf(a.category as Category) - CATEGORIES.indexOf(b.category as Category));
    });
  }
}
