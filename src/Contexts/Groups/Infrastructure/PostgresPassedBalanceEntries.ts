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
        `SELECT COALESCE(o.origin, p.group_id || ':' || p.position) AS key, p.from_id AS by, p.amount, p.passed_at AS at
           FROM group_balances_passed p
           LEFT JOIN group_balances_passed_origins o ON o.group_id = p.group_id AND o.position = p.position
          WHERE p.group_id = ? ORDER BY p.position`,
        groupId,
      ),
    );
  }
}
