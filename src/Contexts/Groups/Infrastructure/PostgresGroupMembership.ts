import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { IGroupMembership } from '@Contexts/Groups/Domain/Group/Ports/IGroupMembership';
import { GROUP_STATEMENTS } from '@Contexts/Groups/Infrastructure/groups.schema';

/**
 * Groups' read side for another context's command (ADR 3). It runs inside that command's transaction, so it reads the
 * connection the transaction holds, as the repositories do (ADR 2, ADR 22). A query of another context reads through
 * `PostgresGroupQueries`, outside any transaction, through `exclusive()`.
 */
/** The groups two accounts are members of now, the earliest created first (request 32); shared by the two read sides of Groups. */
export const SHARED_GROUPS_SQL = `
  SELECT g.id AS "groupId", g.currency AS currency,
         EXISTS (SELECT 1 FROM group_archives a WHERE a.group_id = g.id) AS archived
    FROM tally_groups g
    JOIN group_members m ON m.group_id = g.id AND m.account_id = ? AND m.left_at IS NULL
    JOIN group_members n ON n.group_id = g.id AND n.account_id = ? AND n.left_at IS NULL
   ORDER BY g.created_at, g.rowid`;

export class PostgresGroupMembership implements IGroupMembership {
  constructor(private readonly database: PostgresDatabase) {
    database.migrate(GROUP_STATEMENTS);
  }

  async listMemberIds(groupId: string): Promise<string[]> {
    const rows = await this.database.connection.rows<{ account_id: string }>(
      'SELECT account_id FROM group_members WHERE group_id = ? AND left_at IS NULL ORDER BY position',
      groupId,
    );
    return rows.map(row => row.account_id);
  }

  async groupIdsOf(accountId: string): Promise<string[]> {
    const rows = await this.database.connection.rows<{ groupId: string }>(
      'SELECT group_id AS "groupId" FROM group_members WHERE account_id = ? AND left_at IS NULL',
      accountId,
    );
    return rows.map(row => row.groupId);
  }

  async roleOf(groupId: string, accountId: string): Promise<'owner' | 'member' | null> {
    const row = await this.database.connection.row<{ role: 'owner' | 'member' }>(
      `SELECT CASE WHEN m.account_id = g.owner_id THEN 'owner' ELSE 'member' END AS role
         FROM group_members m JOIN tally_groups g ON g.id = m.group_id
        WHERE m.group_id = ? AND m.account_id = ? AND m.left_at IS NULL`,
      groupId,
      accountId,
    );
    return row?.role ?? null;
  }

  async balancesPassed(groupId: string): Promise<{ fromId: string; toId: string; amount: number }[]> {
    return this.database.connection.rows<{ fromId: string; toId: string; amount: number }>(
      'SELECT from_id AS "fromId", to_id AS "toId", amount FROM group_balances_passed WHERE group_id = ? ORDER BY position',
      groupId,
    );
  }

  async groupsShared(
    first: string,
    second: string,
  ): Promise<{ groupId: string; currency: string; archived: boolean }[]> {
    return this.database.connection.rows(SHARED_GROUPS_SQL, first, second);
  }

  async isArchived(groupId: string): Promise<boolean> {
    const row = await this.database.connection.row('SELECT 1 AS found FROM group_archives WHERE group_id = ?', groupId);
    return row !== undefined;
  }

  async isSuspended(accountId: string): Promise<boolean> {
    const row = await this.database.connection.row(
      'SELECT 1 AS found FROM accounts WHERE id = ? AND suspended_at IS NOT NULL',
      accountId,
    );
    return row !== undefined;
  }

  async isDeleted(accountId: string): Promise<boolean> {
    const row = await this.database.connection.row(
      'SELECT 1 AS found FROM accounts WHERE id = ? AND deleted_at IS NOT NULL',
      accountId,
    );
    return row !== undefined;
  }

  async hasBeenMember(groupId: string, accountId: string): Promise<boolean> {
    const row = await this.database.connection.row(
      'SELECT 1 AS found FROM group_members WHERE group_id = ? AND account_id = ?',
      groupId,
      accountId,
    );
    return row !== undefined;
  }
}
