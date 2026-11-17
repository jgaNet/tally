import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { ISettledAmounts } from '@Contexts/Ledger/Application/ISettledAmounts';
import { IGroupMembers } from '@Contexts/Ledger/Application/IGroupMembers';
import { IBalanceRoster, RosterBalance } from '@Contexts/Ledger/Domain/Expense/Ports/IBalanceRoster';

/**
 * The balances of a group's members in SQLite, over the `expense_balances` rows the expenses wrote in their transactions
 * (feature 5), the changes the settlements made to them (feature 12, ADR 10), and the balances that passed from the members who
 * left to the owner (request 20, ADR 15): a member's balance is the sum of their rows of the group, plus what the settlements moved,
 * less what they passed on leaving, plus what was passed to them; 0 when there is none. Reads the committed data only.
 */
export class SqliteBalanceRoster implements IBalanceRoster {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly settled: ISettledAmounts,
    private readonly groupMembers: IGroupMembers,
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
    for (const { from, to, amount } of await this.groupMembers.passedBalancesOf(groupId)) {
      counted.set(from, (counted.get(from) ?? 0) - amount);
      counted.set(to, (counted.get(to) ?? 0) + amount);
    }
    return [...counted].map(([memberId, balance]) => ({ memberId, balance }));
  }
}
