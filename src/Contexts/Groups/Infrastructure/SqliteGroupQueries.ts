import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { IGroupQueries } from '@Contexts/Groups/Application/Ports/IGroupQueries';
import { IGroupMembership } from '@Contexts/Groups/Domain/Group/Ports/IGroupMembership';
import { GroupReadModel } from '@Contexts/Groups/Application/ReadModel/GroupReadModel';
import { MemberReadModel } from '@Contexts/Groups/Application/ReadModel/MemberReadModel';
import { GROUP_STATEMENTS } from '@Contexts/Groups/Infrastructure/groups.schema';

const READ_MODEL =
  'SELECT g.id, g.name, g.currency, g.owner_id AS ownerId, a.archived_at AS archivedAt FROM tally_groups g LEFT JOIN group_archives a ON a.group_id = g.id';

/** A group as a read reads it: `archivedAt` is there once the group is archived, and only then (request 27). */
function groupOf(row: GroupReadModel & { archivedAt: string | null }): GroupReadModel {
  const { archivedAt, ...group } = row;
  return archivedAt === null ? group : { ...group, archivedAt };
}

/**
 * What the screens read of the groups, from the SQLite file, outside any transaction. Membership is the join, and only
 * a current one (`left_at IS NULL`): a group an account is not in, or has left, is not read at all, so the answer for it
 * is the answer for a group that does not exist.
 */
export class SqliteGroupQueries implements IGroupQueries, IGroupMembership {
  constructor(private readonly database: SqliteDatabase) {
    database.migrate(GROUP_STATEMENTS);
  }

  async findForMember(id: string, accountId: string): Promise<GroupReadModel | null> {
    const row = await this.database.exclusive(
      connection =>
        connection
          .prepare(
            `${READ_MODEL} JOIN group_members m ON m.group_id = g.id WHERE g.id = ? AND m.account_id = ? AND m.left_at IS NULL`,
          )
          .get(id, accountId) as unknown,
    );
    const found = row as (GroupReadModel & { archivedAt: string | null }) | undefined;
    return found ? groupOf(found) : null;
  }

  async listForMember(accountId: string): Promise<GroupReadModel[]> {
    const rows = await this.database.exclusive(
      connection =>
        connection
          .prepare(
            `${READ_MODEL} JOIN group_members m ON m.group_id = g.id WHERE m.account_id = ? AND m.left_at IS NULL ORDER BY g.created_at DESC, g.rowid DESC`,
          )
          .all(accountId) as unknown,
    );
    return (rows as (GroupReadModel & { archivedAt: string | null })[]).map(groupOf);
  }

  async listMemberIds(groupId: string): Promise<string[]> {
    const members = await this.listMembers(groupId);
    return members.map(member => member.memberId);
  }

  async roleOf(groupId: string, accountId: string): Promise<'owner' | 'member' | null> {
    const row = await this.database.exclusive(
      connection =>
        connection
          .prepare(
            `SELECT CASE WHEN m.account_id = g.owner_id THEN 'owner' ELSE 'member' END AS role
               FROM group_members m JOIN tally_groups g ON g.id = m.group_id
              WHERE m.group_id = ? AND m.account_id = ? AND m.left_at IS NULL`,
          )
          .get(groupId, accountId) as unknown,
    );
    return (row as { role: 'owner' | 'member' } | undefined)?.role ?? null;
  }

  async balancesPassed(groupId: string): Promise<{ fromId: string; toId: string; amount: number }[]> {
    const rows = await this.database.exclusive(
      connection =>
        connection
          .prepare(
            'SELECT from_id AS fromId, to_id AS toId, amount FROM group_balances_passed WHERE group_id = ? ORDER BY position',
          )
          .all(groupId) as unknown,
    );
    return (rows as { fromId: string; toId: string; amount: number }[]).map(row => ({
      ...row,
      amount: Number(row.amount),
    }));
  }

  async isArchived(groupId: string): Promise<boolean> {
    const row = await this.database.exclusive(
      connection =>
        connection.prepare('SELECT 1 AS found FROM group_archives WHERE group_id = ?').get(groupId) as unknown,
    );
    return row !== undefined;
  }

  async hasBeenMember(groupId: string, accountId: string): Promise<boolean> {
    const row = await this.database.exclusive(
      connection =>
        connection
          .prepare('SELECT 1 AS found FROM group_members WHERE group_id = ? AND account_id = ?')
          .get(groupId, accountId) as unknown,
    );
    return row !== undefined;
  }

  async listMembers(groupId: string): Promise<MemberReadModel[]> {
    const rows = await this.database.exclusive(
      connection =>
        connection
          .prepare(
            `SELECT m.account_id AS memberId, a.name AS name,
                    CASE WHEN m.account_id = g.owner_id THEN 'owner' ELSE 'member' END AS role,
                    m.joined_at AS joinedAt
               FROM group_members m
               JOIN tally_groups g ON g.id = m.group_id
               JOIN accounts a ON a.id = m.account_id
              WHERE m.group_id = ? AND m.left_at IS NULL ORDER BY m.position`,
          )
          .all(groupId) as unknown,
    );
    return rows as MemberReadModel[];
  }
}
