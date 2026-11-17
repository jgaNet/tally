import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { IGroupBalanceSums } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupBalanceSums';
import { ISettledAmounts } from '@Contexts/Ledger/Domain/Expense/Ports/ISettledAmounts';
import { EXPENSE_STATEMENTS } from '@Contexts/Ledger/Infrastructure/expenses.schema';
import { entrySumsOf, withSettled } from '@Contexts/Ledger/Infrastructure/BalanceEntries';

/**
 * The balances of a group, inside the asking command's transaction (ADR 7): the connection the transaction holds, so a
 * settlement decided on them sees what that transaction sees, the settlements that were paid included.
 */
export class SqliteGroupBalanceSumsInCommand implements IGroupBalanceSums {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly settled: ISettledAmounts,
  ) {
    database.migrate(EXPENSE_STATEMENTS);
  }

  async sumsByMember(groupId: string): Promise<Map<string, number>> {
    const entries = entrySumsOf(this.database.connection, groupId);
    return withSettled(entries, await this.settled.settledByMember(groupId));
  }
}
