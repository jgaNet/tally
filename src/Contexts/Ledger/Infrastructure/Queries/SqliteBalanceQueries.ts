import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { IBalanceQueries, MemberBalance } from '@Contexts/Ledger/Domain/Expense/Ports/IBalanceQueries';
import { ISettledAmounts } from '@Contexts/Ledger/Domain/Expense/Ports/ISettledAmounts';
import { createExpensesTables } from '@Contexts/Ledger/Infrastructure/Repositories/SqliteExpenseRepository';

/**
 * The balance read model over the same file: each member's sum of the entries the expenses of a group wrote, and the
 * changes the settlements paid count (ADR 8), read at once through the port Ledger owns: nothing of them is copied.
 */
export class SqliteBalanceQueries implements IBalanceQueries {
  constructor(
    private database: SqliteDatabase,
    private settled: ISettledAmounts,
  ) {
    createExpensesTables(database);
  }

  async balancesOf(groupId: string): Promise<MemberBalance[]> {
    const expenses = await this.database.exclusive(connection => {
      const rows = connection
        .prepare('SELECT member_id, SUM(amount) AS balance FROM balance_entries WHERE group_id = ? GROUP BY member_id')
        .all(groupId) as unknown as { member_id: string; balance: number }[];
      return rows.map(row => ({ memberId: row.member_id, balance: row.balance }));
    });
    const settled = await this.settled.settledOf(groupId);

    const balances = new Map<string, number>();
    for (const { memberId, balance } of expenses) balances.set(memberId, balance);
    for (const { memberId, amount } of settled) balances.set(memberId, (balances.get(memberId) ?? 0) + amount);
    return [...balances].map(([memberId, balance]) => ({ memberId, balance }));
  }
}
