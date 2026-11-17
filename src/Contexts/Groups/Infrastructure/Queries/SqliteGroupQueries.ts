import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import {
  GroupMembership,
  GroupView,
  IGroupQueries,
  MemberView,
} from '@Contexts/Groups/Domain/Group/Ports/IGroupQueries';
import { createGroupsTables } from '@Contexts/Groups/Infrastructure/Repositories/SqliteGroupRepository';
import { createAccountsTable } from '@Contexts/Groups/Infrastructure/Repositories/SqliteAccountRepository';

interface GroupViewRow {
  id: string;
  name: string;
  currency: string;
  owner_id: string;
}

interface MemberViewRow {
  account_id: string;
  name: string;
  joined_at: string;
  owner_id: string;
}

const SELECT_GROUPS = `
  SELECT g.id, g.name, g.currency, g.owner_id FROM groups g
  JOIN group_members m ON m.group_id = g.id`;

/**
 * The read side of groups over the same file. Membership is part of every statement: a group is read only through
 * a row that names the caller as a current member, so nothing is filtered after the read, and a former member finds
 * no group. Reads take the file's turn, so they never see a transaction still in progress.
 */
export class SqliteGroupQueries implements IGroupQueries {
  constructor(private database: SqliteDatabase) {
    createGroupsTables(database);
    createAccountsTable(database);
  }

  findGroupOf(memberId: string, groupId: string): Promise<GroupView | null> {
    return this.database.exclusive(connection => {
      const row = connection.prepare(`${SELECT_GROUPS} WHERE g.id = ? AND m.account_id = ?`).get(groupId, memberId) as
        GroupViewRow | undefined;
      return row ? toView(row) : null;
    });
  }

  listGroupsOf(memberId: string): Promise<GroupView[]> {
    return this.database.exclusive(connection => {
      const rows = connection
        .prepare(`${SELECT_GROUPS} WHERE m.account_id = ? ORDER BY g.created_at DESC, g.rowid DESC`)
        .all(memberId) as unknown as GroupViewRow[];
      return rows.map(toView);
    });
  }

  listMembersOf(memberId: string, groupId: string): Promise<MemberView[] | null> {
    return this.database.exclusive(connection => {
      const isMember = connection
        .prepare('SELECT 1 FROM group_members WHERE group_id = ? AND account_id = ?')
        .get(groupId, memberId);
      if (!isMember) return null;

      const rows = connection
        .prepare(
          `SELECT m.account_id, a.name, m.joined_at, g.owner_id FROM group_members m
           JOIN groups g ON g.id = m.group_id
           JOIN accounts a ON a.id = m.account_id
           WHERE m.group_id = ? ORDER BY m.position`,
        )
        .all(groupId) as unknown as MemberViewRow[];
      return rows.map(row => ({
        memberId: row.account_id,
        name: row.name,
        role: row.account_id === row.owner_id ? 'owner' : 'member',
        joinedAt: row.joined_at,
      }));
    });
  }

  membersOfEveryGroup(): Promise<GroupMembership[]> {
    return this.database.exclusive(connection => {
      const rows = connection
        .prepare('SELECT group_id, account_id FROM group_members ORDER BY group_id, position')
        .all() as { group_id: string; account_id: string }[];
      return rows.map(row => ({ groupId: row.group_id, memberId: row.account_id }));
    });
  }

  hasBeenMemberOf(askedBy: string, groupId: string, accountId: string): Promise<boolean | null> {
    return this.database.exclusive(connection => {
      const isMember = connection
        .prepare('SELECT 1 FROM group_members WHERE group_id = ? AND account_id = ?')
        .get(groupId, askedBy);
      if (!isMember) return null;

      const has = connection
        .prepare(
          `SELECT 1 FROM group_members WHERE group_id = :group AND account_id = :account
           UNION ALL
           SELECT 1 FROM former_members WHERE group_id = :group AND account_id = :account`,
        )
        .get({ group: groupId, account: accountId });
      return has !== undefined;
    });
  }
}

function toView(row: GroupViewRow): GroupView {
  return { id: row.id, name: row.name, currency: row.currency, ownerId: row.owner_id };
}
