import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { CATEGORIES } from '@Contexts/Ledger/Domain/Expense/Category';
import { IBudgetQueries } from '@Contexts/Ledger/Application/Ports/IBudgetQueries';
import { BudgetReadModel } from '@Contexts/Ledger/Application/ReadModel/BudgetReadModel';
import { BUDGET_STATEMENTS } from '@Contexts/Ledger/Infrastructure/budgets.schema';
import { EXPENSE_STATEMENTS } from '@Contexts/Ledger/Infrastructure/expenses.schema';

/** What the screens read of the budgets, from the SQLite file, outside any transaction: in the order of the categories. */
export class SqliteBudgetQueries implements IBudgetQueries {
  constructor(private readonly database: SqliteDatabase) {
    database.migrate(BUDGET_STATEMENTS);
    database.migrate(EXPENSE_STATEMENTS);
  }

  listByGroup(groupId: string, month: string): Promise<BudgetReadModel[]> {
    return this.database.exclusive(connection => {
      const rows = connection
        .prepare(
          `SELECT b.category, b.amount,
                  COALESCE((
                    SELECT SUM(e.amount) FROM ledger_expenses e JOIN ledger_expense_categories c ON c.expense_id = e.id
                     WHERE e.group_id = b.group_id AND c.category = b.category AND substr(e.date, 1, 7) = ?
                  ), 0) AS spent
             FROM ledger_budgets b
            WHERE b.group_id = ? AND b.active = 1`,
        )
        .all(month, groupId) as unknown as BudgetReadModel[];
      return rows.sort((a, b) => CATEGORIES.indexOf(a.category as never) - CATEGORIES.indexOf(b.category as never));
    });
  }
}
