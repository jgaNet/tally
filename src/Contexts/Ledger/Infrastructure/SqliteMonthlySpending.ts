import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { Category } from '@Contexts/Ledger/Domain/Expense/Category';
import { IMonthlySpending } from '@Contexts/Ledger/Domain/Expense/Ports/IMonthlySpending';
import { prepareLedgerSchema } from '@Contexts/Ledger/Infrastructure/SqliteExpenseRepository';

/**
 * What a month spends in a category, read inside the reaction's transaction (request 24, docs/adr/0023): the expenses are the ledger's own
 * table, and a deleted expense is not in it. The month is the first seven characters of an expense's date, which is a day in UTC.
 */
export class SqliteMonthlySpending implements IMonthlySpending {
  constructor(private readonly database: SqliteDatabase) {
    database.prepare(prepareLedgerSchema);
  }

  async spentIn(groupId: string, category: Category, month: string): Promise<number> {
    this.database.assertInTransaction();
    const row = this.database.connection
      .prepare(
        'SELECT COALESCE(SUM(amount), 0) AS spent FROM expenses WHERE group_id = ? AND category = ? AND substr(date, 1, 7) = ?',
      )
      .get(groupId, category, month) as { spent: number };
    return Number(row.spent);
  }
}
