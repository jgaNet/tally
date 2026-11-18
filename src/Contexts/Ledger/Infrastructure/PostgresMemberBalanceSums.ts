import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { IMemberBalanceSums } from '@Contexts/Ledger/Domain/Expense/Ports/IMemberBalanceSums';
import { ISettledAmounts } from '@Contexts/Ledger/Domain/Expense/Ports/ISettledAmounts';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { EXPENSE_STATEMENTS } from '@Contexts/Ledger/Infrastructure/expenses.schema';
import { Id } from '@Architecture/Domain';

/**
 * Ledger's balance of one member, inside the asking command's transaction: the expenses' entries over the connection the
 * transaction holds (ADR 2, ADR 22), plus what the settlements paid to the member, and what passed to or from it when a member left
 * (request 20), all read in the same transaction.
 */
export class PostgresMemberBalanceSums implements IMemberBalanceSums {
  constructor(
    private readonly database: PostgresDatabase,
    private readonly settled: ISettledAmounts,
    private readonly members: IGroupMembers,
  ) {
    database.migrate(EXPENSE_STATEMENTS);
  }

  async balanceOf(groupId: string, memberId: string): Promise<number> {
    const row = await this.database.connection.row<{ balance: number }>(
      'SELECT COALESCE(SUM(amount), 0) AS balance FROM ledger_balance_entries WHERE group_id = ? AND member_id = ?',
      groupId,
      memberId,
    );
    const settled = (await this.settled.settledByMember(groupId)).get(memberId) ?? 0;
    const passed = (await this.members.balancesPassed(new Id(groupId))).get(memberId) ?? 0;
    return Number(row?.balance ?? 0) + settled + passed;
  }
}
