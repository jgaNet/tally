import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { BudgetView } from '@Contexts/Ledger/Domain/Budget/DTOs';
import { IBudgetQueries } from '@Contexts/Ledger/Domain/Budget/Ports/IBudgetQueries';
import { CATEGORIES, Category } from '@Contexts/Ledger/Domain/Expense/Category';
import { prepareLedgerSchema } from '@Contexts/Ledger/Infrastructure/SqliteExpenseRepository';
import {
  BUDGET_COLUMNS,
  BudgetRow,
  prepareBudgetSchema,
  budgetSnapshotOf,
} from '@Contexts/Ledger/Infrastructure/SqliteBudgets';

/** The read side of the budgets over SQLite: reads of the file, taken alone, outside any transaction (request 24). */
export class SqliteBudgetQueries implements IBudgetQueries {
  constructor(private readonly database: SqliteDatabase) {
    database.prepare(prepareBudgetSchema);
    database.prepare(prepareLedgerSchema);
  }

  async listOf(groupId: string, month: string): Promise<BudgetView[]> {
    return this.database.exclusive(() => {
      const connection = this.database.connection;
      const rows = connection
        .prepare(`SELECT ${BUDGET_COLUMNS} FROM budgets WHERE group_id = ? AND amount IS NOT NULL`)
        .all(groupId) as BudgetRow[];
      const spent = new Map(
        (
          connection
            .prepare(
              'SELECT category, SUM(amount) AS spent FROM expenses WHERE group_id = ? AND substr(date, 1, 7) = ? GROUP BY category',
            )
            .all(groupId, month) as Array<{ category: string; spent: number }>
        ).map(row => [String(row.category), Number(row.spent)]),
      );
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
