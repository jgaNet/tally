import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { IBalanceQueries } from '@Contexts/Ledger/Application/Ports/IBalanceQueries';
import { EXPENSE_STATEMENTS } from '@Contexts/Ledger/Infrastructure/expenses.schema';

/** What the screens read of the balances, from the SQLite file's balance entries, outside any transaction. */
export class SqliteBalanceQueries implements IBalanceQueries {
  constructor(private readonly database: SqliteDatabase) {
    database.migrate(EXPENSE_STATEMENTS);
  }

  sumsByMember(groupId: string): Promise<Map<string, number>> {
    return this.database.exclusive(connection => {
      const rows = connection
        .prepare(
          'SELECT member_id AS memberId, SUM(amount) AS balance FROM ledger_balance_entries WHERE group_id = ? GROUP BY member_id',
        )
        .all(groupId) as { memberId: string; balance: number }[];
      return new Map(rows.map(row => [row.memberId, Number(row.balance)]));
    });
  }
}
