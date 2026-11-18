import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { IGroupMembership } from '@Contexts/Groups/Domain/Group/Ports/IGroupMembership';
import { GROUP_STATEMENTS } from '@Contexts/Groups/Infrastructure/groups.schema';

/**
 * Groups' read side for another context's command (ADR 3). It runs inside that command's transaction, so it reads the
 * connection the transaction holds, as the repositories do (ADR 2, ADR 22). A query of another context reads through
 * `PostgresGroupQueries`, outside any transaction, through `exclusive()`.
 */
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

  async isArchived(groupId: string): Promise<boolean> {
    const row = await this.database.connection.row('SELECT 1 AS found FROM group_archives WHERE group_id = ?', groupId);
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
