import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { IBalanceCounts } from '@Contexts/Ledger/Application/Ports/IBalanceCounts';
import { IBalanceQueries } from '@Contexts/Ledger/Application/Ports/IBalanceQueries';
import { ISettledAmounts } from '@Contexts/Ledger/Application/Ports/ISettledAmounts';
import { MemberBalanceReadModel } from '@Contexts/Ledger/Application/ReadModel/MemberBalanceReadModel';
import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';
import { IMemberBalancesQueries } from '@Contexts/Ledger/Domain/Expense/Ports/IMemberBalancesQueries';
import { createLedgerTables } from '@Contexts/Ledger/Infrastructure/LedgerTables';

/**
 * The balances, in the application's file. `count` writes in the command's transaction, so the expense and its balances are
 * stored together or not at all. A balance is what the expenses give, plus what has been settled (ADR 7): the settlements are
 * read when a balance is read, through the port Ledger owns, and are never copied here. `balanceOf` is read inside a command's
 * transaction, which holds the file already; `balancesOf` is read outside any transaction, so it takes the file itself.
 */
export class SqliteMemberBalances implements IBalanceCounts, IBalanceQueries, IMemberBalancesQueries {
  constructor(
    private database: SqliteDatabase,
    private settled: ISettledAmounts,
  ) {
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

  /**
   * A member's balance in a group, read by Groups before the member leaves (ADR 4) and by the command that decides a settlement
   * (ADR 7): inside the transaction of the caller, so it takes no lock.
   */
  async balanceOf(groupId: string, memberId: string): Promise<number> {
    const recorded =
      this.database.get<{ balance: number }>(
        'SELECT balance FROM member_balances WHERE group_id = ? AND member_id = ?',
        groupId,
        memberId,
      )?.balance ?? 0;
    const settled = (await this.settled.settledOf(groupId)).find(row => row.memberId === memberId);
    return recorded + (settled?.amount ?? 0);
  }

  async balancesOf(groupId: string): Promise<MemberBalanceReadModel[]> {
    const release = await this.database.lock();
    try {
      const balances = new Map<string, number>(
        this.database
          .all<{ member_id: string; balance: number }>(
            'SELECT member_id, balance FROM member_balances WHERE group_id = ?',
            groupId,
          )
          .map(row => [row.member_id, row.balance]),
      );
      for (const settled of await this.settled.settledOf(groupId)) {
        balances.set(settled.memberId, (balances.get(settled.memberId) ?? 0) + settled.amount);
      }
      return [...balances].map(([memberId, balance]) => ({ memberId, balance }));
    } finally {
      release();
    }
  }
}
