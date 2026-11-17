import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { IExpenseQueries } from '@Contexts/Ledger/Application/Ports/IExpenseQueries';
import { ExpenseReadModel } from '@Contexts/Ledger/Application/ReadModel/ExpenseReadModel';
import { createLedgerTables } from '@Contexts/Ledger/Infrastructure/LedgerTables';

interface Row {
  id: string;
  group_id: string;
  description: string;
  amount: number;
  spent_on: string;
  paid_by: string;
  version: number;
}

/** The expenses' read models: read outside any command's transaction, so it waits for the one in progress. */
export class SqliteExpenseReadModels implements IExpenseQueries {
  constructor(private database: SqliteDatabase) {
    createLedgerTables(database);
  }

  async findById(id: string): Promise<ExpenseReadModel | null> {
    return this.database.exclusive(() => {
      const row = this.database.get<Row>(
        'SELECT id, group_id, description, amount, spent_on, paid_by, version FROM expenses WHERE id = ?',
        id,
      );
      if (!row) return null;
      const shares = this.database.all<{ member_id: string; amount: number }>(
        'SELECT member_id, amount FROM expense_shares WHERE expense_id = ? ORDER BY position',
        id,
      );
      return {
        id: row.id,
        groupId: row.group_id,
        description: row.description,
        amount: row.amount,
        date: row.spent_on,
        paidBy: row.paid_by,
        version: row.version,
        shares: shares.map(share => ({ memberId: share.member_id, amount: share.amount })),
      };
    });
  }
}
