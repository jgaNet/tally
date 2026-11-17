import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { IGroupCurrency } from '@Contexts/Groups/Domain/Group/Ports/IGroupCurrency';
import { GROUP_STATEMENTS } from '@Contexts/Groups/Infrastructure/groups.schema';

/**
 * Groups' currency for another context's command (ADR 8). It runs inside that command's transaction, so it reads the
 * connection the transaction holds, as the other read sides of Groups do (ADR 2, ADR 3).
 */
export class SqliteGroupCurrency implements IGroupCurrency {
  constructor(private readonly database: SqliteDatabase) {
    database.migrate(GROUP_STATEMENTS);
  }

  async currencyOf(groupId: string): Promise<string | null> {
    const row = this.database.connection.prepare('SELECT currency FROM tally_groups WHERE id = ?').get(groupId) as
      { currency: string } | undefined;
    return row?.currency ?? null;
  }
}
