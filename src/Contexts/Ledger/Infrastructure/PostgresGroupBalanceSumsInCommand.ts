import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { IGroupBalanceSums } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupBalanceSums';
import { ISettledAmounts } from '@Contexts/Ledger/Domain/Expense/Ports/ISettledAmounts';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { EXPENSE_STATEMENTS } from '@Contexts/Ledger/Infrastructure/expenses.schema';
import { entrySumsOf, groupIdsOf, withPassed, withSettled } from '@Contexts/Ledger/Infrastructure/BalanceEntries';
import { Id } from '@Architecture/Domain';

/**
 * The balances of a group, inside the asking command's transaction (ADR 7): the connection the transaction holds, so a
 * settlement decided on them sees what that transaction sees, the settlements that were paid and the balances that passed
 * included (request 20).
 */
export class PostgresGroupBalanceSumsInCommand implements IGroupBalanceSums {
  constructor(
    private readonly database: PostgresDatabase,
    private readonly settled: ISettledAmounts,
    private readonly members: IGroupMembers,
  ) {
    database.migrate(EXPENSE_STATEMENTS);
  }

  async sumsByMember(groupId: string): Promise<Map<string, number>> {
    const entries = await entrySumsOf(this.database.connection, groupId);
    const settled = await this.settled.settledByMember(groupId);
    const passed = await this.members.balancesPassed(new Id(groupId));
    return withPassed(withSettled(entries, settled), passed);
  }

  async groupIds(): Promise<string[]> {
    return groupIdsOf(this.database.connection);
  }
}
