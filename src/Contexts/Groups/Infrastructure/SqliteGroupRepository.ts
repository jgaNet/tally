import { ConcurrencyConflictException, Id, IResult, Result } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { Group } from '@Contexts/Groups/Domain/Group/Group';
import { IGroupRepository } from '@Contexts/Groups/Domain/Group/Ports/IGroupRepository';
import { GROUP_STATEMENTS } from '@Contexts/Groups/Infrastructure/groups.schema';

interface GroupRow {
  id: string;
  name: string;
  currency: string;
  owner_id: string;
  created_at: string;
  version: number;
}

/** The groups' repository over the SQLite file; used inside the command's transaction, which holds the connection. */
export class SqliteGroupRepository implements IGroupRepository {
  constructor(private readonly database: SqliteDatabase) {
    database.migrate(GROUP_STATEMENTS);
  }

  async findById(id: Id): Promise<Group | null> {
    const { connection } = this.database;
    const row = connection.prepare('SELECT * FROM tally_groups WHERE id = ?').get(id.value) as GroupRow | undefined;
    if (!row) return null;
    const members = connection
      .prepare('SELECT account_id FROM group_members WHERE group_id = ? ORDER BY position')
      .all(id.value) as { account_id: string }[];
    return Group.fromSnapshot({
      id: row.id,
      name: row.name,
      currency: row.currency,
      ownerId: row.owner_id,
      memberIds: members.map(member => member.account_id),
      createdAt: row.created_at,
      version: row.version,
    });
  }

  async save(group: Group): Promise<IResult> {
    const { id, name, currency, ownerId, memberIds, createdAt, version } = group.toSnapshot();
    const { connection } = this.database;
    if (version === 0) {
      connection
        .prepare(
          'INSERT INTO tally_groups (id, name, currency, owner_id, created_at, version) VALUES (?, ?, ?, ?, ?, 1)',
        )
        .run(id, name, currency, ownerId, createdAt);
    } else {
      const { changes } = connection
        .prepare('UPDATE tally_groups SET version = version + 1 WHERE id = ? AND version = ?')
        .run(id, version);
      if (changes === 0) {
        return Result.fail(new ConcurrencyConflictException('Groups', 'The group changed since it was read', { id }));
      }
    }
    connection.prepare('DELETE FROM group_members WHERE group_id = ?').run(id);
    memberIds.forEach((accountId, position) =>
      connection
        .prepare('INSERT INTO group_members (group_id, account_id, position) VALUES (?, ?, ?)')
        .run(id, accountId, position),
    );
    return Result.ok();
  }
}
