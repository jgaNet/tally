import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { IGroupQueries } from '@Contexts/Groups/Application/Ports/IGroupQueries';
import { GroupReadModel } from '@Contexts/Groups/Application/ReadModel/GroupReadModel';
import { GROUP_STATEMENTS } from '@Contexts/Groups/Infrastructure/groups.schema';

const READ_MODEL = 'SELECT g.id, g.name, g.currency, g.owner_id AS ownerId FROM tally_groups g';

/**
 * What the screens read of the groups, from the SQLite file, outside any transaction. Membership is the join: a
 * group an account is not in is not read at all, so the answer for it is the answer for a group that does not exist.
 */
export class SqliteGroupQueries implements IGroupQueries {
  constructor(private readonly database: SqliteDatabase) {
    database.migrate(GROUP_STATEMENTS);
  }

  async findForMember(id: string, accountId: string): Promise<GroupReadModel | null> {
    const row = await this.database.exclusive(
      connection =>
        connection
          .prepare(`${READ_MODEL} JOIN group_members m ON m.group_id = g.id WHERE g.id = ? AND m.account_id = ?`)
          .get(id, accountId) as unknown,
    );
    return (row as GroupReadModel | undefined) ?? null;
  }

  async listForMember(accountId: string): Promise<GroupReadModel[]> {
    const rows = await this.database.exclusive(
      connection =>
        connection
          .prepare(
            `${READ_MODEL} JOIN group_members m ON m.group_id = g.id WHERE m.account_id = ? ORDER BY g.created_at DESC, g.rowid DESC`,
          )
          .all(accountId) as unknown,
    );
    return rows as GroupReadModel[];
  }
}
