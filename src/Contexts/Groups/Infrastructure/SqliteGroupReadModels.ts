import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { IGroupQueries } from '@Contexts/Groups/Application/Ports/IGroupQueries';
import { GroupReadModel } from '@Contexts/Groups/Application/ReadModel/GroupReadModel';
import { createGroupsTables } from '@Contexts/Groups/Infrastructure/GroupsTables';

interface Row {
  id: string;
  name: string;
  currency: string;
  owner_id: string;
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
}

const SELECT = 'SELECT g.id AS id, g.name AS name, g.currency AS currency, g.owner_id AS owner_id FROM groups g';

const toReadModel = (row: Row): GroupReadModel => ({
  id: row.id,
  name: row.name,
  currency: row.currency,
  ownerId: row.owner_id,
});
