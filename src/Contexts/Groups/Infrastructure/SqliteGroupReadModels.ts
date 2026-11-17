import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { IGroupQueries } from '@Contexts/Groups/Application/Ports/IGroupQueries';
import { GroupReadModel } from '@Contexts/Groups/Application/ReadModel/GroupReadModel';
import { MemberReadModel } from '@Contexts/Groups/Application/ReadModel/MemberReadModel';
import { createGroupsTables } from '@Contexts/Groups/Infrastructure/GroupsTables';

interface Row {
  id: string;
  name: string;
  currency: string;
  owner_id: string;
}

interface MemberRow {
  member_id: string;
  name: string;
  owner_id: string;
  joined_at: string;
}

/** The groups' read models: what is read outside any command's transaction, so it waits for the one in progress. */
export class SqliteGroupReadModels implements IGroupQueries {
  constructor(private database: SqliteDatabase) {
    createGroupsTables(database);
  }

  /** A group is read through its members only: the join is what hides it from anyone who is not one. */
  async findForMember(groupId: string, accountId: string): Promise<GroupReadModel | null> {
    const row = await this.database.exclusive(() =>
      this.database.get<Row>(
        `${SELECT} JOIN group_members m ON m.group_id = g.id WHERE g.id = ? AND m.account_id = ?`,
        groupId,
        accountId,
      ),
    );
    return row ? toReadModel(row) : null;
  }

  async listForMember(accountId: string): Promise<GroupReadModel[]> {
    const rows = await this.database.exclusive(() =>
      this.database.all<Row>(
        `${SELECT} JOIN group_members m ON m.group_id = g.id WHERE m.account_id = ? ORDER BY g.created_at DESC, g.rowid DESC`,
        accountId,
      ),
    );
    return rows.map(toReadModel);
  }

  /** The members are listed only to one of them: the same answer as a group that is not there, for anyone else. */
  async listMembers(groupId: string, accountId: string): Promise<MemberReadModel[] | null> {
    return this.database.exclusive(() => {
      const isMember = this.database.get<{ found: number }>(
        'SELECT 1 AS found FROM group_members WHERE group_id = ? AND account_id = ?',
        groupId,
        accountId,
      );
      if (!isMember) return null;
      const rows = this.database.all<MemberRow>(
        `SELECT m.account_id AS member_id, a.name AS name, g.owner_id AS owner_id, m.joined_at AS joined_at
         FROM group_members m
         JOIN accounts a ON a.id = m.account_id
         JOIN groups g ON g.id = m.group_id
         WHERE m.group_id = ? ORDER BY m.position`,
        groupId,
      );
      return rows.map((row): MemberReadModel => ({
        memberId: row.member_id,
        name: row.name,
        role: row.member_id === row.owner_id ? 'owner' : 'member',
        joinedAt: row.joined_at,
      }));
    });
  }
}

const SELECT = 'SELECT g.id AS id, g.name AS name, g.currency AS currency, g.owner_id AS owner_id FROM groups g';

const toReadModel = (row: Row): GroupReadModel => ({
  id: row.id,
  name: row.name,
  currency: row.currency,
  ownerId: row.owner_id,
});
