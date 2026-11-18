import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { IBalanceQueries } from '@Contexts/Ledger/Application/Ports/IBalanceQueries';
import { ISettledAmounts } from '@Contexts/Ledger/Domain/Expense/Ports/ISettledAmounts';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { EXPENSE_STATEMENTS } from '@Contexts/Ledger/Infrastructure/expenses.schema';
import { entrySumsOf, groupIdsOf, withPassed, withSettled } from '@Contexts/Ledger/Infrastructure/BalanceEntries';
import { Id } from '@Architecture/Domain';

/**
 * What the screens read of the balances, outside any transaction: the expenses' entries, what the settlements paid
 * (SettledAmounts, ADR 7), and what passed when a member left (request 20), read as the other sides answer them.
 */
export class PostgresBalanceQueries implements IBalanceQueries {
  constructor(
    private readonly database: PostgresDatabase,
    private readonly settled: ISettledAmounts,
    private readonly members: IGroupMembers,
  ) {
    database.migrate(EXPENSE_STATEMENTS);
  }

  async sumsByMember(groupId: string): Promise<Map<string, number>> {
    const entries = await this.database.exclusive(connection => entrySumsOf(connection, groupId));
    const settled = await this.settled.settledByMember(groupId);
    const passed = await this.members.balancesPassed(new Id(groupId));
    return withPassed(withSettled(entries, settled), passed);
  }

  groupIds(): Promise<string[]> {
    return this.database.exclusive(groupIdsOf);
  }
}
