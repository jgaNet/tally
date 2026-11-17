import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { IExpenseQueries } from '@Contexts/Ledger/Application/Ports/IExpenseQueries';
import { ExpenseReadModel, ShareReadModel } from '@Contexts/Ledger/Application/ReadModel/ExpenseReadModel';
import { EXPENSE_STATEMENTS } from '@Contexts/Ledger/Infrastructure/expenses.schema';

/** What the screens read of the expenses, from the SQLite file, outside any transaction. */
export class SqliteExpenseQueries implements IExpenseQueries {
  constructor(private readonly database: SqliteDatabase) {
    database.migrate(EXPENSE_STATEMENTS);
  }

  findById(id: string): Promise<ExpenseReadModel | null> {
    return this.database.exclusive(connection => {
      const row = connection
        .prepare(
          'SELECT id, group_id AS groupId, description, amount, date, paid_by AS paidBy, version FROM ledger_expenses WHERE id = ?',
        )
        .get(id) as Omit<ExpenseReadModel, 'shares'> | undefined;
      if (!row) return null;
      const shares = connection
        .prepare(
          'SELECT member_id AS memberId, amount FROM ledger_expense_shares WHERE expense_id = ? ORDER BY position',
        )
        .all(id) as unknown as ShareReadModel[];
      return { ...row, shares };
    });
  }
}
