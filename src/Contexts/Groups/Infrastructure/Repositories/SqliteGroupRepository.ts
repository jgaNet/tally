import { ConcurrencyConflictException, IResult, Result } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { Group } from '@Contexts/Groups/Domain/Group/Group';
import { IGroupSnapshot } from '@Contexts/Groups/Domain/Group/DTOs';
import { IGroupRepository } from '@Contexts/Groups/Domain/Group/Ports/IGroupRepository';

/** The tables of groups: one row per group, and one row per member of it, in the order they joined. */
export function createGroupsTables(database: SqliteDatabase): void {
  database.connection.exec(`
    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      currency TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      version INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS group_members (
      group_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      PRIMARY KEY (group_id, account_id)
    );
  `);
}

interface GroupRow {
  id: string;
  name: string;
  currency: string;
  owner_id: string;
  created_at: string;
  version: number;
}

/**
 * The groups as aggregates, over the application's SQLite file. Used inside the transaction of the command that
 * asks for it, which holds the file, so its statements are part of that transaction.
 */
export class SqliteGroupRepository implements IGroupRepository {
  constructor(private database: SqliteDatabase) {
    createGroupsTables(database);
  }

  async findById(id: string): Promise<Group | null> {
    const row = this.database.connection.prepare('SELECT * FROM groups WHERE id = ?').get(id) as GroupRow | undefined;
    if (!row) return null;

    const members = this.database.connection
      .prepare('SELECT account_id FROM group_members WHERE group_id = ? ORDER BY position')
      .all(id) as Array<{ account_id: string }>;
    return Group.fromSnapshot(
      toSnapshot(
        row,
        members.map(member => member.account_id),
      ),
    );
  }

  /**
   * The optimistic check as SQL makes it atomic: the update applies only to the row still at the version the group
   * was read at; no row changed means another writer got there first (ADR 8). A new group is inserted at version 1.
   * Its name is the only column an update writes: the currency and the owner are fixed at the creation, and no
   * behaviour changes them. Members are added in their order; a member already kept is left as it is.
   */
  async save(group: Group): Promise<IResult> {
    const snapshot = group.toSnapshot();
    const { _id: id, name, currency, ownerId, createdAt, version } = snapshot;

    const updated = this.database.connection
      .prepare('UPDATE groups SET name = :name, version = :next WHERE id = :id AND version = :version')
      .run({ id, name, version, next: version + 1 });

    if (updated.changes === 0) {
      const stored = this.database.connection.prepare('SELECT version FROM groups WHERE id = ?').get(id);
      if (stored) {
        return Result.fail(new ConcurrencyConflictException('Groups', 'The group changed since it was read', { id }));
      }
      this.database.connection
        .prepare('INSERT INTO groups (id, name, currency, owner_id, created_at, version) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, name, currency, ownerId, createdAt, version + 1);
    }

    const addMember = this.database.connection.prepare(
      'INSERT OR IGNORE INTO group_members (group_id, account_id, position) VALUES (?, ?, ?)',
    );
    snapshot.members.forEach((accountId, position) => addMember.run(id, accountId, position));
    return Result.ok();
  }
}

function toSnapshot(row: GroupRow, members: string[]): IGroupSnapshot {
  return {
    _id: row.id,
    name: row.name,
    currency: row.currency,
    ownerId: row.owner_id,
    members,
    createdAt: row.created_at,
    version: row.version,
  };
}
