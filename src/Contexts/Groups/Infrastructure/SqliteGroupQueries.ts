import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { prepareGroupsSchema } from '@Contexts/Groups/Infrastructure/SqliteGroupRepository';
import { GroupView, IGroupQueries, MemberView } from '@Contexts/Groups/Domain/Group/Ports/IGroupQueries';

type GroupRow = { id: string; name: string; currency: string; owner_id: string };
type MemberRow = { member_id: string; name: string; role: string; joined_at: string };

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
    database.prepare(prepareGroupsSchema);
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

  async listMembersOf(memberId: string, groupId: string): Promise<MemberView[] | undefined> {
    return this.database.exclusive(() => {
      const connection = this.database.connection;
      const asks = connection
        .prepare('SELECT 1 FROM group_members WHERE group_id = ? AND account_id = ?')
        .get(groupId, memberId);
      if (!asks) return undefined;
      const rows = connection
        .prepare(
          'SELECT m.account_id AS member_id, a.name, m.role, m.joined_at FROM group_members m JOIN accounts a ON a.id = m.account_id WHERE m.group_id = ? ORDER BY m.position',
        )
        .all(groupId) as MemberRow[];
      return rows.map((row): MemberView => ({
        memberId: String(row.member_id),
        name: String(row.name),
        role: row.role === 'owner' ? 'owner' : 'member',
        joinedAt: String(row.joined_at),
      }));
    });
  }
}
