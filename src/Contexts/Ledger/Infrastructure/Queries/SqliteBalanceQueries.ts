import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { IBalanceQueries, MemberBalance } from '@Contexts/Ledger/Domain/Expense/Ports/IBalanceQueries';
import { createExpensesTables } from '@Contexts/Ledger/Infrastructure/Repositories/SqliteExpenseRepository';

/** The balance read model over the same file: each member's sum of the entries the expenses of a group wrote. */
export class SqliteBalanceQueries implements IBalanceQueries {
  constructor(private database: SqliteDatabase) {
    createExpensesTables(database);
  }

  balancesOf(groupId: string): Promise<MemberBalance[]> {
    return this.database.exclusive(connection => {
      const rows = connection
        .prepare('SELECT member_id, SUM(amount) AS balance FROM balance_entries WHERE group_id = ? GROUP BY member_id')
        .all(groupId) as unknown as { member_id: string; balance: number }[];
      return rows.map(row => ({ memberId: row.member_id, balance: row.balance }));
    });
  }
}
