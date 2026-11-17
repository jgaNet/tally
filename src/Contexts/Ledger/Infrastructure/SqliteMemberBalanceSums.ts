import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { IMemberBalanceSums } from '@Contexts/Ledger/Domain/Expense/Ports/IMemberBalanceSums';
import { ISettledAmounts } from '@Contexts/Ledger/Domain/Expense/Ports/ISettledAmounts';
import { EXPENSE_STATEMENTS } from '@Contexts/Ledger/Infrastructure/expenses.schema';

/**
 * Ledger's balance of one member, inside the asking command's transaction: the expenses' entries over the connection the
 * transaction holds (ADR 2), plus what the settlements paid to the member, read in the same transaction (ADR 7).
 */
export class SqliteMemberBalanceSums implements IMemberBalanceSums {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly settled: ISettledAmounts,
  ) {
    database.migrate(EXPENSE_STATEMENTS);
  }

  async balanceOf(groupId: string, memberId: string): Promise<number> {
    const row = this.database.connection
      .prepare(
        'SELECT COALESCE(SUM(amount), 0) AS balance FROM ledger_balance_entries WHERE group_id = ? AND member_id = ?',
      )
      .get(groupId, memberId) as { balance: number };
    const settled = (await this.settled.settledByMember(groupId)).get(memberId) ?? 0;
    return Number(row.balance) + settled;
  }
}
