import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { IGroupMembership } from '@Contexts/Groups/Domain/Group/Ports/IGroupMembership';
import { GROUP_STATEMENTS } from '@Contexts/Groups/Infrastructure/groups.schema';

/**
 * Groups' read side for another context's command (ADR 3). It runs inside that command's transaction, so it reads the
 * connection the transaction holds, as the repositories do (ADR 2). A query of another context reads through
 * `SqliteGroupQueries`, outside any transaction, through `exclusive()`.
 */
export class SqliteGroupMembership implements IGroupMembership {
  constructor(private readonly database: SqliteDatabase) {
    database.migrate(GROUP_STATEMENTS);
  }

  async listMemberIds(groupId: string): Promise<string[]> {
    const rows = this.database.connection
      .prepare('SELECT account_id FROM group_members WHERE group_id = ? AND left_at IS NULL ORDER BY position')
      .all(groupId) as { account_id: string }[];
    return rows.map(row => row.account_id);
  }

  async roleOf(groupId: string, accountId: string): Promise<'owner' | 'member' | null> {
    const row = this.database.connection
      .prepare(
        `SELECT CASE WHEN m.account_id = g.owner_id THEN 'owner' ELSE 'member' END AS role
           FROM group_members m JOIN tally_groups g ON g.id = m.group_id
          WHERE m.group_id = ? AND m.account_id = ? AND m.left_at IS NULL`,
      )
      .get(groupId, accountId) as { role: 'owner' | 'member' } | undefined;
    return row?.role ?? null;
  }

  async balancesPassed(groupId: string): Promise<{ fromId: string; toId: string; amount: number }[]> {
    const rows = this.database.connection
      .prepare(
        'SELECT from_id AS fromId, to_id AS toId, amount FROM group_balances_passed WHERE group_id = ? ORDER BY position',
      )
      .all(groupId) as { fromId: string; toId: string; amount: number }[];
    return rows.map(row => ({ ...row, amount: Number(row.amount) }));
  }

  async isArchived(groupId: string): Promise<boolean> {
    const row = this.database.connection
      .prepare('SELECT 1 AS found FROM group_archives WHERE group_id = ?')
      .get(groupId);
    return row !== undefined;
  }

  async hasBeenMember(groupId: string, accountId: string): Promise<boolean> {
    const row = this.database.connection
      .prepare('SELECT 1 AS found FROM group_members WHERE group_id = ? AND account_id = ?')
      .get(groupId, accountId);
    return row !== undefined;
  }
}
