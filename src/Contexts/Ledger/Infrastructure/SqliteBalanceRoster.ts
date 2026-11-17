import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { IBalanceRoster } from '@Contexts/Ledger/Domain/Expense/Ports/IBalanceRoster';

/**
 * The balances of a group's members in SQLite, over the `expense_balances` rows the expenses wrote in their transactions
 * (feature 5): a member's balance is the sum of their rows of the group, 0 when there is none. Reads the committed data only.
 */
export class SqliteBalanceRoster implements IBalanceRoster {
  constructor(private readonly database: SqliteDatabase) {}

  async balanceOf(groupId: string, memberId: string): Promise<number> {
    const row = this.database.read(db =>
      db
        .prepare('SELECT SUM(amount) AS balance FROM expense_balances WHERE group_id = ? AND member_id = ?')
        .get(groupId, memberId),
    ) as { balance: number | null } | undefined;
    return row?.balance ?? 0;
  }
}
