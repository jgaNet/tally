import { IResult, Result } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { Group } from '@Contexts/Groups/Domain/Group/Group';
import { IGroupRepository } from '@Contexts/Groups/Domain/Group/Ports/IGroupRepository';
import { createGroupsTables } from '@Contexts/Groups/Infrastructure/GroupsTables';

/**
 * The groups the creation stores, in the application's file. It runs inside the command's transaction, which holds the
 * file, so it takes no lock of its own: a group and its members are written together or not at all.
 */
export class SqliteGroupRepository implements IGroupRepository {
  constructor(private database: SqliteDatabase) {
    createGroupsTables(database);
  }

  async save(group: Group): Promise<IResult> {
    const { id, name, currency, ownerId, memberIds, createdAt } = group.toSnapshot();
    this.database.run(
      'INSERT INTO groups (id, name, currency, owner_id, created_at) VALUES (?, ?, ?, ?, ?)',
      id,
      name,
      currency,
      ownerId,
      createdAt,
    );
    memberIds.forEach((accountId, position) =>
      this.database.run(
        'INSERT INTO group_members (group_id, account_id, position) VALUES (?, ?, ?)',
        id,
        accountId,
        position,
      ),
    );
    return Result.ok();
  }
}
