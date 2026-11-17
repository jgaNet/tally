import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { IBalanceCounts } from '@Contexts/Ledger/Application/Ports/IBalanceCounts';
import { IBalanceQueries } from '@Contexts/Ledger/Application/Ports/IBalanceQueries';
import { MemberBalanceReadModel } from '@Contexts/Ledger/Application/ReadModel/MemberBalanceReadModel';
import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';
import { createLedgerTables } from '@Contexts/Ledger/Infrastructure/LedgerTables';

/**
 * The balances, in the application's file. `count` writes in the command's transaction, so the expense and its balances are
 * stored together or not at all; `balancesOf` is read outside any transaction, so it waits for the one in progress.
 */
export class SqliteMemberBalances implements IBalanceCounts, IBalanceQueries {
  constructor(private database: SqliteDatabase) {
    createLedgerTables(database);
  }

  async count(expense: Expense): Promise<void> {
    this.apply(expense, 1);
  }

  async uncount(expense: Expense): Promise<void> {
    this.apply(expense, -1);
  }

  private apply(expense: Expense, sign: 1 | -1): void {
    for (const { memberId, change } of expense.balanceChanges()) {
      this.database.run(
        `INSERT INTO member_balances (group_id, member_id, balance) VALUES (?, ?, ?)
         ON CONFLICT (group_id, member_id) DO UPDATE SET balance = balance + excluded.balance`,
        expense.groupId.value,
        memberId.value,
        sign * change,
      );
    }
  }

  async balancesOf(groupId: string): Promise<MemberBalanceReadModel[]> {
    return this.database.exclusive(() =>
      this.database
        .all<{ member_id: string; balance: number }>(
          'SELECT member_id, balance FROM member_balances WHERE group_id = ?',
          groupId,
        )
        .map(row => ({ memberId: row.member_id, balance: row.balance })),
    );
  }
}
