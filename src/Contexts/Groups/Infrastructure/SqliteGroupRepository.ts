import { ConcurrencyConflictException, Id, IResult, Result } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { Group } from '@Contexts/Groups/Domain/Group/Group';
import { IGroupRepository } from '@Contexts/Groups/Domain/Group/Ports/IGroupRepository';
import { createGroupsTables } from '@Contexts/Groups/Infrastructure/GroupsTables';

interface GroupRow {
  id: string;
  name: string;
  currency: string;
  owner_id: string;
  created_at: string;
  version: number;
}

interface MemberRow {
  account_id: string;
  joined_at: string;
}

/**
 * The groups, in the application's file. It runs inside the command's transaction, which holds the file, so it takes
 * no lock of its own. A save that finds the group at another version than it was read at is a conflict, and the
 * command's transaction is rolled back with it: a group and its members are written together or not at all.
 */
export class SqliteGroupRepository implements IGroupRepository {
  constructor(private database: SqliteDatabase) {
    createGroupsTables(database);
  }

  async findById(id: Id): Promise<Group | null> {
    const row = this.database.get<GroupRow>(
      'SELECT id, name, currency, owner_id, created_at, version FROM groups WHERE id = ?',
      id.value,
    );
    if (!row) return null;
    const members = this.database.all<MemberRow>(
      'SELECT account_id, joined_at FROM group_members WHERE group_id = ? ORDER BY position',
      id.value,
    );
    return Group.fromSnapshot({
      id: row.id,
      name: row.name,
      currency: row.currency,
      ownerId: row.owner_id,
      members: members.map(member => ({ accountId: member.account_id, joinedAt: member.joined_at })),
      createdAt: row.created_at,
      version: row.version,
    });
  }

  async save(group: Group): Promise<IResult> {
    const { id, name, currency, ownerId, members, createdAt, version } = group.toSnapshot();
    if (version === 0) {
      this.database.run(
        'INSERT INTO groups (id, name, currency, owner_id, created_at, version) VALUES (?, ?, ?, ?, ?, ?)',
        id,
        name,
        currency,
        ownerId,
        createdAt,
        1,
      );
    } else {
      const changed = this.database.run(
        'UPDATE groups SET version = ? WHERE id = ? AND version = ?',
        version + 1,
        id,
        version,
      );
      if (!changed) return Result.fail(new ConcurrencyConflictException('Groups', 'The group has changed', { id }));
    }
    // A member already kept is left as it is: the rows are the members in the order they joined, written once each.
    members.forEach((member, position) =>
      this.database.run(
        'INSERT OR IGNORE INTO group_members (group_id, account_id, position, joined_at) VALUES (?, ?, ?, ?)',
        id,
        member.accountId,
        position,
        member.joinedAt,
      ),
    );
    return Result.ok();
  }
}
