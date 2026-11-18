import { Connection, PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { IGroupCurrency } from '@Contexts/Groups/Domain/Group/Ports/IGroupCurrency';
import { GROUP_STATEMENTS } from '@Contexts/Groups/Infrastructure/groups.schema';

/**
 * Groups' currency for another context's command (ADR 8). It runs inside that command's transaction, so it reads the
 * connection the transaction holds, as the other read sides of Groups do (ADR 2, ADR 3, ADR 22). A query reads it the
 * same way, outside a transaction (request 22), when it is built `forQueries`: through `exclusive()`.
 */
export class PostgresGroupCurrency implements IGroupCurrency {
  constructor(
    private readonly database: PostgresDatabase,
    private readonly forQueries = false,
  ) {
    database.migrate(GROUP_STATEMENTS);
  }

  async currencyOf(groupId: string): Promise<string | null> {
    const read = (connection: Connection) =>
      connection.row<{ currency: string }>('SELECT currency FROM tally_groups WHERE id = ?', groupId);
    const row = this.forQueries ? await this.database.exclusive(read) : await read(this.database.connection);
    return row?.currency ?? null;
  }
}
