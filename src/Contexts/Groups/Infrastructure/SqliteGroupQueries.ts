import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { GROUPS_SCHEMA } from '@Contexts/Groups/Infrastructure/SqliteGroupRepository';
import { GroupView, IGroupQueries } from '@Contexts/Groups/Domain/Group/Ports/IGroupQueries';

type GroupRow = { id: string; name: string; currency: string; owner_id: string };

const toView = (row: GroupRow): GroupView => ({
  id: String(row.id),
  name: String(row.name),
  currency: String(row.currency),
  ownerId: String(row.owner_id),
});

/**
 * The read side of the groups over SQLite: reads of the file, taken alone, outside any transaction. Membership is the
 * join, so a group that a caller is not a member of is not found at all.
 */
export class SqliteGroupQueries implements IGroupQueries {
  constructor(private readonly database: SqliteDatabase) {
    database.prepare(connection => connection.exec(GROUPS_SCHEMA));
  }

  async findGroupOf(memberId: string, groupId: string): Promise<GroupView | undefined> {
    return this.database.exclusive(() => {
      const row = this.database.connection
        .prepare(
          'SELECT g.id, g.name, g.currency, g.owner_id FROM groups g JOIN group_members m ON m.group_id = g.id WHERE g.id = ? AND m.account_id = ?',
        )
        .get(groupId, memberId) as GroupRow | undefined;
      return row ? toView(row) : undefined;
    });
  }

  async listGroupsOf(memberId: string): Promise<GroupView[]> {
    return this.database.exclusive(() => {
      const rows = this.database.connection
        .prepare(
          'SELECT g.id, g.name, g.currency, g.owner_id FROM groups g JOIN group_members m ON m.group_id = g.id WHERE m.account_id = ? ORDER BY g.created_at DESC, g.rowid DESC',
        )
        .all(memberId) as GroupRow[];
      return rows.map(toView);
    });
  }
}
