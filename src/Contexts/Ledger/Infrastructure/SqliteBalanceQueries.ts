import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { IBalanceQueries } from '@Contexts/Ledger/Application/Ports/IBalanceQueries';
import { ISettledAmounts } from '@Contexts/Ledger/Domain/Expense/Ports/ISettledAmounts';
import { EXPENSE_STATEMENTS } from '@Contexts/Ledger/Infrastructure/expenses.schema';
import { entrySumsOf, groupIdsOf, withSettled } from '@Contexts/Ledger/Infrastructure/BalanceEntries';

/**
 * What the screens read of the balances, outside any transaction: the expenses' entries, and what the settlements paid
 * (SettledAmounts, ADR 7), read as the settlements' own read side answers it.
 */
export class SqliteBalanceQueries implements IBalanceQueries {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly settled: ISettledAmounts,
  ) {
    database.migrate(EXPENSE_STATEMENTS);
  }

  async sumsByMember(groupId: string): Promise<Map<string, number>> {
    const entries = await this.database.exclusive(connection => entrySumsOf(connection, groupId));
    return withSettled(entries, await this.settled.settledByMember(groupId));
  }

  groupIds(): Promise<string[]> {
    return this.database.exclusive(groupIdsOf);
  }
}
