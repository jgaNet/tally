import { Group } from '@Contexts/Groups/Domain/Group/Group';
import { IGroupRepository } from '@Contexts/Groups/Application/IGroupRepository';
import { GroupView, IGroupQueries } from '@Contexts/Groups/Application/IGroupQueries';

import { GroupsDatabase } from './GroupsDatabase';

type GroupRow = { id: string; name: string; currency: string; owner_id: string };

const GROUP_COLUMNS = 'g.id, g.name, g.currency, g.owner_id';
const MEMBER_OF_GROUP = 'JOIN expense_group_members m ON m.group_id = g.id';

const viewOf = (row: GroupRow): GroupView => ({
  id: row.id,
  name: row.name,
  currency: row.currency,
  ownerId: row.owner_id,
});

/**
 * The groups in SQLite: the repository `CreateGroup` inserts into, and the read side `GetGroup` and `GetMyGroups`
 * read. The owner's membership is written with the group, in one transaction, so a group always has its first member.
 */
export class SqliteGroups implements IGroupRepository, IGroupQueries {
  constructor(private readonly database: GroupsDatabase) {}

  async insert(group: Group): Promise<void> {
    const { id, name, currency, ownerId, createdAt } = group.toSnapshot();
    const connection = this.database.connection;
    connection.exec('BEGIN IMMEDIATE');
    try {
      connection
        .prepare('INSERT INTO expense_groups (id, name, currency, owner_id, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, name, currency, ownerId, createdAt);
      connection.prepare('INSERT INTO expense_group_members (group_id, account_id) VALUES (?, ?)').run(id, ownerId);
      connection.exec('COMMIT');
    } catch (error) {
      connection.exec('ROLLBACK');
      throw error;
    }
  }

  async groupOf(id: string, memberId: string): Promise<GroupView | undefined> {
    const row = this.database.connection
      .prepare(`SELECT ${GROUP_COLUMNS} FROM expense_groups g ${MEMBER_OF_GROUP} WHERE g.id = ? AND m.account_id = ?`)
      .get(id, memberId) as GroupRow | undefined;
    return row && viewOf(row);
  }

  async groupsOf(memberId: string): Promise<GroupView[]> {
    const rows = this.database.connection
      .prepare(
        `SELECT ${GROUP_COLUMNS} FROM expense_groups g ${MEMBER_OF_GROUP} WHERE m.account_id = ? ORDER BY g.created_at DESC, g.rowid DESC`,
      )
      .all(memberId) as GroupRow[];
    return rows.map(viewOf);
  }
}
