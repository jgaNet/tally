import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { IBalanceQueries, MemberBalance } from '@Contexts/Ledger/Domain/Expense/Ports/IBalanceQueries';
import { ISettledAmounts } from '@Contexts/Ledger/Domain/Expense/Ports/ISettledAmounts';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { defineExpensesTables } from '@Contexts/Ledger/Infrastructure/Repositories/PostgresExpenseRepository';

/**
 * The balance read model over the same file: each member's sum of the entries the expenses of a group wrote, the
 * changes the settlements paid count (ADR 8), and the balances passed on when members left (request 20, ADR 11), each
 * read at once through the port Ledger owns: nothing of them is copied. A passing lowers the member it is from and raises
 * the member it is to by its amount, so the balances of the group still add up to 0.
 */
export class PostgresBalanceQueries implements IBalanceQueries {
  constructor(
    private database: PostgresDatabase,
    private settled: ISettledAmounts,
    private groupMembers: IGroupMembers,
  ) {
    defineExpensesTables(database);
  }

  async balancesOf(groupId: string): Promise<MemberBalance[]> {
    // SUM of an INTEGER column is a bigint, which the driver returns as a string: it is read back as a number.
    const rows = await this.database.all<{ member_id: string; balance: string | number }>(
      'SELECT member_id, SUM(amount) AS balance FROM balance_entries WHERE group_id = ? GROUP BY member_id',
      [groupId],
    );
    const expenses = rows.map(row => ({ memberId: row.member_id, balance: Number(row.balance) }));
    const settled = await this.settled.settledOf(groupId);
    const passings = await this.groupMembers.passingsOf(groupId);

    const balances = new Map<string, number>();
    for (const { memberId, balance } of expenses) balances.set(memberId, balance);
    for (const { memberId, amount } of settled) balances.set(memberId, (balances.get(memberId) ?? 0) + amount);
    for (const { from, to, amount } of passings) {
      balances.set(from, (balances.get(from) ?? 0) - amount);
      balances.set(to, (balances.get(to) ?? 0) + amount);
    }
    return [...balances].map(([memberId, balance]) => ({ memberId, balance }));
  }
}
