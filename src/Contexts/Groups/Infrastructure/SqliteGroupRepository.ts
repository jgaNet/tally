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
  archived_at: string | null;
  version: number;
}

interface MemberRow {
  account_id: string;
  joined_at: string;
}

interface DepartedRow extends MemberRow {
  left_at: string;
}

interface PassageRow {
  from_account_id: string;
  to_account_id: string;
  amount: number;
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
      'SELECT id, name, currency, owner_id, created_at, archived_at, version FROM groups WHERE id = ?',
      id.value,
    );
    if (!row) return null;
    const members = this.database.all<MemberRow>(
      'SELECT account_id, joined_at FROM group_members WHERE group_id = ? AND left_at IS NULL ORDER BY position',
      id.value,
    );
    const departed = this.database.all<DepartedRow>(
      'SELECT account_id, joined_at, left_at FROM group_members WHERE group_id = ? AND left_at IS NOT NULL ORDER BY left_at',
      id.value,
    );
    const passages = this.database.all<PassageRow>(
      'SELECT from_account_id, to_account_id, amount FROM balance_passages WHERE group_id = ? ORDER BY position',
      id.value,
    );
    return Group.fromSnapshot({
      id: row.id,
      name: row.name,
      currency: row.currency,
      ownerId: row.owner_id,
      members: members.map(member => ({ accountId: member.account_id, joinedAt: member.joined_at })),
      departed: departed.map(member => ({
        accountId: member.account_id,
        joinedAt: member.joined_at,
        leftAt: member.left_at,
      })),
      passages: passages.map(passage => ({
        from: passage.from_account_id,
        to: passage.to_account_id,
        amount: passage.amount,
      })),
      createdAt: row.created_at,
      archivedAt: row.archived_at,
      version: row.version,
    });
  }

  async save(group: Group): Promise<IResult> {
    const { id, name, currency, ownerId, members, departed, passages, createdAt, archivedAt, version } =
      group.toSnapshot();
    if (version === 0) {
      this.database.run(
        'INSERT INTO groups (id, name, currency, owner_id, created_at, archived_at, version) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id,
        name,
        currency,
        ownerId,
        createdAt,
        archivedAt ?? null,
        1,
      );
    } else {
      const changed = this.database.run(
        'UPDATE groups SET version = ?, archived_at = ? WHERE id = ? AND version = ?',
        version + 1,
        archivedAt ?? null,
        id,
        version,
      );
      if (!changed) return Result.fail(new ConcurrencyConflictException('Groups', 'The group has changed', { id }));
    }
    // The current members are written in the order they joined, so that their positions are the order they have now. A
    // member who joins again has its row taken up (it was kept when it left), at the time it joined again.
    members.forEach((member, position) =>
      this.database.run(
        `INSERT INTO group_members (group_id, account_id, position, joined_at, left_at) VALUES (?, ?, ?, ?, NULL)
         ON CONFLICT (group_id, account_id) DO UPDATE SET
           position = excluded.position, joined_at = excluded.joined_at, left_at = NULL`,
        id,
        member.accountId,
        position,
        member.joinedAt,
      ),
    );
    // A member who left keeps its row, with the time it left.
    departed.forEach(member =>
      this.database.run(
        'UPDATE group_members SET left_at = ? WHERE group_id = ? AND account_id = ?',
        member.leftAt,
        id,
        member.accountId,
      ),
    );
    // A passage is kept as it was made, at its place in the order they passed: one written once is never written again.
    passages.forEach((passage, position) =>
      this.database.run(
        `INSERT OR IGNORE INTO balance_passages (group_id, position, from_account_id, to_account_id, amount)
         VALUES (?, ?, ?, ?, ?)`,
        id,
        position,
        passage.from,
        passage.to,
        passage.amount,
      ),
    );
    return Result.ok();
  }
}
