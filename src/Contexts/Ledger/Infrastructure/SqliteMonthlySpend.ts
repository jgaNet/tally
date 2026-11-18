import { Id } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { Category } from '@Contexts/Ledger/Domain/Expense/Category';
import { IMonthlySpend } from '@Contexts/Ledger/Domain/Budget/Ports/IMonthlySpend';
import { EXPENSE_STATEMENTS } from '@Contexts/Ledger/Infrastructure/expenses.schema';

/** A month's spending in a category, read from the expenses' rows inside the reaction's transaction, which holds the connection. */
export class SqliteMonthlySpend implements IMonthlySpend {
  constructor(private readonly database: SqliteDatabase) {
    database.migrate(EXPENSE_STATEMENTS);
  }

  async spentInMonth(groupId: Id, category: Category, month: string): Promise<number> {
    const row = this.database.connection
      .prepare(
        `SELECT COALESCE(SUM(e.amount), 0) AS spent
           FROM ledger_expenses e JOIN ledger_expense_categories c ON c.expense_id = e.id
          WHERE e.group_id = ? AND c.category = ? AND substr(e.date, 1, 7) = ?`,
      )
      .get(groupId.value, category, month) as { spent: number };
    return row.spent;
  }
}
