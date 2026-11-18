import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { prepareGroupsSchema } from '@Contexts/Groups/Infrastructure/SqliteGroupRepository';
import {
  GroupView,
  IGroupQueries,
  MemberView,
  PassedBalancesView,
  PassedLeaveView,
  PassedMemberView,
} from '@Contexts/Groups/Domain/Group/Ports/IGroupQueries';

type GroupRow = { id: string; name: string; currency: string; owner_id: string; archived_at: string | null };
type MemberRow = { member_id: string; name: string; role: string; joined_at: string };

const toView = (row: GroupRow): GroupView => ({
  id: String(row.id),
  name: String(row.name),
  currency: String(row.currency),
  ownerId: String(row.owner_id),
  ...(row.archived_at === null ? {} : { archivedAt: String(row.archived_at) }),
});

/**
 * The read side of the groups over SQLite: reads of the file, taken alone, outside any transaction. Membership is the
 * join, and only a current membership counts (a member who left is not among the members): so a group a caller is not a
 * member of, or has left, is not found at all.
 */
export class SqliteGroupQueries implements IGroupQueries {
  constructor(private readonly database: SqliteDatabase) {
    database.prepare(prepareGroupsSchema);
  }

  async findGroupOf(memberId: string, groupId: string): Promise<GroupView | undefined> {
    return this.database.exclusive(() => {
      const row = this.database.connection
        .prepare(
          'SELECT g.id, g.name, g.currency, g.owner_id, g.archived_at FROM groups g JOIN group_members m ON m.group_id = g.id WHERE g.id = ? AND m.account_id = ? AND m.left_at IS NULL',
        )
        .get(groupId, memberId) as GroupRow | undefined;
      return row ? toView(row) : undefined;
    });
  }

  async listGroupsOf(memberId: string): Promise<GroupView[]> {
    return this.database.exclusive(() => {
      const rows = this.database.connection
        .prepare(
          'SELECT g.id, g.name, g.currency, g.owner_id, g.archived_at FROM groups g JOIN group_members m ON m.group_id = g.id WHERE m.account_id = ? AND m.left_at IS NULL ORDER BY g.created_at DESC, g.rowid DESC',
        )
        .all(memberId) as GroupRow[];
      return rows.map(toView);
    });
  }

  async listMembersOf(memberId: string, groupId: string): Promise<MemberView[] | undefined> {
    return this.database.exclusive(() => {
      const connection = this.database.connection;
      const asks = connection
        .prepare('SELECT 1 FROM group_members WHERE group_id = ? AND account_id = ? AND left_at IS NULL')
        .get(groupId, memberId);
      if (!asks) return undefined;
      const rows = connection
        .prepare(
          'SELECT m.account_id AS member_id, a.name, m.role, m.joined_at FROM group_members m JOIN accounts a ON a.id = m.account_id WHERE m.group_id = ? AND m.left_at IS NULL ORDER BY m.position',
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

  async passedBalancesOf(groupId: string): Promise<PassedBalancesView | undefined> {
    return this.database.exclusive(() => {
      const connection = this.database.connection;
      const group = connection.prepare('SELECT owner_id FROM groups WHERE id = ?').get(groupId) as
        { owner_id: string } | undefined;
      if (!group) return undefined;
      // A membership that never passed anything and never left is not listed: it has nothing to carry (docs/adr/0019).
      const rows = connection
        .prepare(
          'SELECT account_id, passed, left_at FROM group_members WHERE group_id = ? AND (passed <> 0 OR left_at IS NOT NULL) ORDER BY position',
        )
        .all(groupId) as Array<{ account_id: string; passed: number; left_at: string | null }>;
      return {
        ownerId: String(group.owner_id),
        members: rows.map((row): PassedMemberView => ({
          memberId: String(row.account_id),
          passed: Number(row.passed),
          current: row.left_at === null,
        })),
      };
    });
  }

  async passedLeavesOf(groupId: string): Promise<PassedLeaveView[]> {
    return this.database.exclusive(() =>
      (
        this.database.connection
          .prepare('SELECT id, at, member_id, amount FROM passed_balances WHERE group_id = ? ORDER BY at, rowid')
          .all(groupId) as Array<{ id: string; at: string; member_id: string; amount: number }>
      ).map((row): PassedLeaveView => ({
        id: String(row.id),
        at: String(row.at),
        memberId: String(row.member_id),
        amount: Number(row.amount),
      })),
    );
  }

  async currentMemberIdsOf(groupId: string): Promise<string[]> {
    return this.database.exclusive(() =>
      (
        this.database.connection
          .prepare('SELECT account_id FROM group_members WHERE group_id = ? AND left_at IS NULL ORDER BY position')
          .all(groupId) as Array<{ account_id: string }>
      ).map(row => String(row.account_id)),
    );
  }

  async isArchived(groupId: string): Promise<boolean> {
    return this.database.exclusive(() => {
      const row = this.database.connection.prepare('SELECT archived_at FROM groups WHERE id = ?').get(groupId) as
        { archived_at: string | null } | undefined;
      return row !== undefined && row.archived_at !== null;
    });
  }
  async everMemberOf(accountId: string, groupId: string): Promise<boolean> {
    return this.database.exclusive(() => {
      const row = this.database.connection
        .prepare('SELECT 1 FROM group_members WHERE group_id = ? AND account_id = ?')
        .get(groupId, accountId);
      return row !== undefined;
    });
  }
}
