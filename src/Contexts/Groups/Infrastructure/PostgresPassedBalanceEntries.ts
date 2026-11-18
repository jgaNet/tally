import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { IPassedBalanceEntries, PassedBalanceEntry } from '@Contexts/Groups/Domain/Group/Ports/IPassedBalanceEntries';
import { GROUP_STATEMENTS } from '@Contexts/Groups/Infrastructure/groups.schema';

/** The balances that passed in a group, the earliest first, from the PostgreSQL database, outside any transaction (request 28). */
export class PostgresPassedBalanceEntries implements IPassedBalanceEntries {
  constructor(private readonly database: PostgresDatabase) {
    database.migrate(GROUP_STATEMENTS);
  }

  entriesOf(groupId: string): Promise<PassedBalanceEntry[]> {
    return this.database.exclusive(connection =>
      connection.rows<PassedBalanceEntry>(
        'SELECT position, from_id AS by, amount, passed_at AS at FROM group_balances_passed WHERE group_id = ? ORDER BY position',
        groupId,
      ),
    );
  }
}
