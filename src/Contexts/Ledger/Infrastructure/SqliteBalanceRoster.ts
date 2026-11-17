import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { ISettledAmounts } from '@Contexts/Ledger/Application/ISettledAmounts';
import { IBalanceRoster, RosterBalance } from '@Contexts/Ledger/Domain/Expense/Ports/IBalanceRoster';

/**
 * The balances of a group's members in SQLite, over the `expense_balances` rows the expenses wrote in their transactions
 * (feature 5), and the changes the settlements made to them (feature 12, ADR 10): a member's balance is the sum of their rows of the
 * group, plus what the settlements moved, 0 when there is none. Reads the committed data only.
 */
export class SqliteBalanceRoster implements IBalanceRoster {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly settled: ISettledAmounts,
  ) {}

  async balanceOf(groupId: string, memberId: string): Promise<number> {
    const row = (await this.balancesOf(groupId)).find(each => each.memberId === memberId);
    return row?.balance ?? 0;
  }

  async balancesOf(groupId: string): Promise<RosterBalance[]> {
    const rows = this.database.read(db =>
      db
        .prepare(
          'SELECT member_id AS memberId, SUM(amount) AS balance FROM expense_balances WHERE group_id = ? GROUP BY member_id',
        )
        .all(groupId),
    ) as { memberId: string; balance: number }[];
    const counted = new Map(rows.map(({ memberId, balance }) => [memberId, balance]));
    for (const { memberId, change } of await this.settled.settledOf(groupId)) {
      counted.set(memberId, (counted.get(memberId) ?? 0) + change);
    }
    return [...counted].map(([memberId, balance]) => ({ memberId, balance }));
  }
}
