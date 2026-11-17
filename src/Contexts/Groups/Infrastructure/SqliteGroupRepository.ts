import { ConcurrencyConflictException, IResult, Result } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { IGroupRepository } from '@Contexts/Groups/Domain/Group/Ports/IGroupRepository';
import { Group } from '@Contexts/Groups/Domain/Group/Group';

/**
 * The groups' tables. A group's members are rows of their own, keyed by the group and the account: a member is
 * added, never removed, so a save only inserts the members it does not have yet.
 */
export const GROUPS_SCHEMA = [
  'CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, currency TEXT NOT NULL, owner_id TEXT NOT NULL, created_at TEXT NOT NULL, version INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS group_members (group_id TEXT NOT NULL REFERENCES groups (id), account_id TEXT NOT NULL, role TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY (group_id, account_id))',
  'CREATE INDEX IF NOT EXISTS group_members_by_account ON group_members (account_id)',
].join(';\n');

/** The groups' store over SQLite (docs/adr/0001). Its methods run inside a transaction: the use case's. */
export class SqliteGroupRepository implements IGroupRepository {
  constructor(private readonly database: SqliteDatabase) {
    database.prepare(connection => connection.exec(GROUPS_SCHEMA));
  }

  async save(group: Group): Promise<IResult<undefined>> {
    this.database.assertInTransaction();
    const snapshot = group.toSnapshot();
    const connection = this.database.connection;
    if (snapshot.version === 0) {
      connection
        .prepare('INSERT INTO groups (id, name, currency, owner_id, created_at, version) VALUES (?, ?, ?, ?, ?, ?)')
        .run(snapshot.id, snapshot.name, snapshot.currency, snapshot.ownerId, snapshot.createdAt, snapshot.version + 1);
    } else {
      const { changes } = connection
        .prepare('UPDATE groups SET name = ?, currency = ?, owner_id = ?, version = ? WHERE id = ? AND version = ?')
        .run(snapshot.name, snapshot.currency, snapshot.ownerId, snapshot.version + 1, snapshot.id, snapshot.version);
      if (changes === 0) {
        return Result.fail(new ConcurrencyConflictException('Groups', 'The group changed since it was read'));
      }
    }
    const insertMember = connection.prepare(
      'INSERT OR IGNORE INTO group_members (group_id, account_id, role, position) VALUES (?, ?, ?, ?)',
    );
    snapshot.members.forEach((member, position) => {
      insertMember.run(snapshot.id, member.accountId, member.role, position);
    });
    return Result.ok(undefined);
  }
}
