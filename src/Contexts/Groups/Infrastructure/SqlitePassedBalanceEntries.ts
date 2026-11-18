import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { IPassedBalanceEntries, PassedBalanceEntry } from '@Contexts/Groups/Domain/Group/Ports/IPassedBalanceEntries';
import { GROUP_STATEMENTS } from '@Contexts/Groups/Infrastructure/groups.schema';

/** The balances that passed in a group, the earliest first, from the SQLite file, outside any transaction (request 28). */
export class SqlitePassedBalanceEntries implements IPassedBalanceEntries {
  constructor(private readonly database: SqliteDatabase) {
    database.migrate(GROUP_STATEMENTS);
  }

  entriesOf(groupId: string): Promise<PassedBalanceEntry[]> {
    return this.database.exclusive(connection => {
      const rows = connection
        .prepare(
          'SELECT position, from_id AS by, amount, passed_at AS at FROM group_balances_passed WHERE group_id = ? ORDER BY position',
        )
        .all(groupId) as unknown as PassedBalanceEntry[];
      return rows.map(row => ({ ...row, amount: Number(row.amount) }));
    });
  }
}
