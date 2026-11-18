import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { prepareGroupsSchema } from '@Contexts/Groups/Infrastructure/PostgresGroupRepository';
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
 * The read side of the groups over PostgreSQL: reads taken alone, outside any transaction. Membership is the
 * join, and only a current membership counts (a member who left is not among the members): so a group a caller is not a
 * member of, or has left, is not found at all.
 */
export class PostgresGroupQueries implements IGroupQueries {
  constructor(private readonly database: PostgresDatabase) {
    database.prepare(prepareGroupsSchema);
  }

  async findGroupOf(memberId: string, groupId: string): Promise<GroupView | undefined> {
    return this.database.exclusive(async () => {
      const row = await this.database.get<GroupRow>(
        'SELECT g.id, g.name, g.currency, g.owner_id, g.archived_at FROM groups g JOIN group_members m ON m.group_id = g.id WHERE g.id = ? AND m.account_id = ? AND m.left_at IS NULL',
        [groupId, memberId],
      );
      return row ? toView(row) : undefined;
    });
  }

  async listGroupsOf(memberId: string): Promise<GroupView[]> {
    return this.database.exclusive(async () => {
      const rows = await this.database.all<GroupRow>(
        'SELECT g.id, g.name, g.currency, g.owner_id, g.archived_at FROM groups g JOIN group_members m ON m.group_id = g.id WHERE m.account_id = ? AND m.left_at IS NULL ORDER BY g.created_at DESC, g.seq DESC',
        [memberId],
      );
      return rows.map(toView);
    });
  }

  async listMembersOf(memberId: string, groupId: string): Promise<MemberView[] | undefined> {
    return this.database.exclusive(async () => {
      const asks = await this.database.get(
        'SELECT 1 FROM group_members WHERE group_id = ? AND account_id = ? AND left_at IS NULL',
        [groupId, memberId],
      );
      if (!asks) return undefined;
      const rows = await this.database.all<MemberRow>(
        'SELECT m.account_id AS member_id, a.name, m.role, m.joined_at FROM group_members m JOIN accounts a ON a.id = m.account_id WHERE m.group_id = ? AND m.left_at IS NULL ORDER BY m.position',
        [groupId],
      );
      return rows.map((row): MemberView => ({
        memberId: String(row.member_id),
        name: String(row.name),
        role: row.role === 'owner' ? 'owner' : 'member',
        joinedAt: String(row.joined_at),
      }));
    });
  }

  async passedBalancesOf(groupId: string): Promise<PassedBalancesView | undefined> {
    return this.database.exclusive(async () => {
      const group = await this.database.get<{ owner_id: string }>('SELECT owner_id FROM groups WHERE id = ?', [
        groupId,
      ]);
      if (!group) return undefined;
      // A membership that never passed anything and never left is not listed: it has nothing to carry (docs/adr/0019).
      const rows = await this.database.all<{ account_id: string; passed: number; left_at: string | null }>(
        'SELECT account_id, passed, left_at FROM group_members WHERE group_id = ? AND (passed <> 0 OR left_at IS NOT NULL) ORDER BY position',
        [groupId],
      );
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
    return this.database.exclusive(async () =>
      (
        await this.database.all<{ id: string; at: string; member_id: string; amount: number }>(
          'SELECT id, at, member_id, amount FROM passed_balances WHERE group_id = ? ORDER BY at, seq',
          [groupId],
        )
      ).map((row): PassedLeaveView => ({
        id: String(row.id),
        at: String(row.at),
        memberId: String(row.member_id),
        amount: Number(row.amount),
      })),
    );
  }

  async currentMemberIdsOf(groupId: string): Promise<string[]> {
    return this.database.exclusive(async () =>
      (
        await this.database.all<{ account_id: string }>(
          'SELECT account_id FROM group_members WHERE group_id = ? AND left_at IS NULL ORDER BY position',
          [groupId],
        )
      ).map(row => String(row.account_id)),
    );
  }

  async isSuspended(accountId: string): Promise<boolean> {
    return this.database.exclusive(async () => {
      const row = await this.database.get<{ suspended: boolean }>('SELECT suspended FROM accounts WHERE id = ?', [
        accountId,
      ]);
      return row?.suspended === true;
    });
  }

  async isArchived(groupId: string): Promise<boolean> {
    return this.database.exclusive(async () => {
      const row = await this.database.get<{ archived_at: string | null }>(
        'SELECT archived_at FROM groups WHERE id = ?',
        [groupId],
      );
      return row !== undefined && row.archived_at !== null;
    });
  }

  async everMemberOf(accountId: string, groupId: string): Promise<boolean> {
    return this.database.exclusive(async () => {
      const row = await this.database.get('SELECT 1 FROM group_members WHERE group_id = ? AND account_id = ?', [
        groupId,
        accountId,
      ]);
      return row !== undefined;
    });
  }
}
