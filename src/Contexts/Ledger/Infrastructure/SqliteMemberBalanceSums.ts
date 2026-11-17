import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { IMemberBalanceSums } from '@Contexts/Ledger/Domain/Expense/Ports/IMemberBalanceSums';
import { EXPENSE_STATEMENTS } from '@Contexts/Ledger/Infrastructure/expenses.schema';

/**
 * Ledger's balance of one member, over the SQLite file's balance entries, inside the asking command's transaction: it
 * reads the connection the transaction holds (ADR 2), as the repositories do.
 */
export class SqliteMemberBalanceSums implements IMemberBalanceSums {
  constructor(private readonly database: SqliteDatabase) {
    database.migrate(EXPENSE_STATEMENTS);
  }

  async balanceOf(groupId: string, memberId: string): Promise<number> {
    const row = this.database.connection
      .prepare(
        'SELECT COALESCE(SUM(amount), 0) AS balance FROM ledger_balance_entries WHERE group_id = ? AND member_id = ?',
      )
      .get(groupId, memberId) as { balance: number };
    return Number(row.balance);
  }
}
