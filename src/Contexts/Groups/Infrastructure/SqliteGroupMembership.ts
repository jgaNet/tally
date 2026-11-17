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
      .prepare('SELECT account_id FROM group_members WHERE group_id = ? ORDER BY position')
      .all(groupId) as { account_id: string }[];
    return rows.map(row => row.account_id);
  }
}
