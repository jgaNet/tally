import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { ExpenseView, IExpenseQueries } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseQueries';
import { createExpensesTables } from '@Contexts/Ledger/Infrastructure/Repositories/SqliteExpenseRepository';

interface ExpenseViewRow {
  id: string;
  group_id: string;
  description: string;
  amount: number;
  spent_on: string;
  paid_by: string;
  version: number;
}

/** The read side of expenses over the same file: each expense as recorded, its shares in the order of the split. */
export class SqliteExpenseQueries implements IExpenseQueries {
  constructor(private database: SqliteDatabase) {
    createExpensesTables(database);
  }

  findExpense(id: string): Promise<ExpenseView | null> {
    return this.database.exclusive(connection => {
      const row = connection.prepare('SELECT * FROM expenses WHERE id = ?').get(id) as ExpenseViewRow | undefined;
      if (!row) return null;

      const shares = connection
        .prepare('SELECT member_id, amount FROM expense_shares WHERE expense_id = ? ORDER BY position')
        .all(id) as unknown as { member_id: string; amount: number }[];
      return {
        id: row.id,
        groupId: row.group_id,
        description: row.description,
        amount: row.amount,
        date: row.spent_on,
        paidBy: row.paid_by,
        shares: shares.map(share => ({ memberId: share.member_id, amount: share.amount })),
        version: row.version,
      };
    });
  }
}
