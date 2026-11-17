import { DatabaseSync } from 'node:sqlite';

import { ConcurrencyConflictException, IResult, Result } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { IGroupRepository } from '@Contexts/Groups/Domain/Group/Ports/IGroupRepository';
import { Group } from '@Contexts/Groups/Domain/Group/Group';
import { CurrencyCode } from '@Contexts/Groups/Domain/Group/Currency';
import { MemberSnapshot } from '@Contexts/Groups/Domain/Group/DTOs';

/**
 * The groups' tables. A group's members are rows of their own, keyed by the group and the account: a member is
 * added, never removed, so a save only inserts the members it does not have yet. `position` is the order they joined.
 */
export const GROUPS_SCHEMA = [
  'CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, currency TEXT NOT NULL, owner_id TEXT NOT NULL, created_at TEXT NOT NULL, version INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS group_members (group_id TEXT NOT NULL REFERENCES groups (id), account_id TEXT NOT NULL, role TEXT NOT NULL, position INTEGER NOT NULL, joined_at TEXT NOT NULL, PRIMARY KEY (group_id, account_id))',
  'CREATE INDEX IF NOT EXISTS group_members_by_account ON group_members (account_id)',
].join(';\n');

/**
 * Makes the groups' tables what the store reads, on a file that may have been made before the members had their join
 * dates (feature 2): there, every member is an owner, who joined when its group was created.
 */
export function prepareGroupsSchema(connection: DatabaseSync): void {
  connection.exec(GROUPS_SCHEMA);
  const columns = connection.prepare('PRAGMA table_info(group_members)').all() as Array<{ name: string }>;
  if (columns.some(column => column.name === 'joined_at')) return;
  connection.exec(
    "ALTER TABLE group_members ADD COLUMN joined_at TEXT NOT NULL DEFAULT ''; UPDATE group_members SET joined_at = (SELECT created_at FROM groups WHERE groups.id = group_members.group_id)",
  );
}

type GroupRow = { id: string; name: string; currency: string; owner_id: string; created_at: string; version: number };
type MemberRow = { account_id: string; role: string; joined_at: string };

/** The groups' store over SQLite (docs/adr/0001). Its methods run inside a transaction: the use case's. */
export class SqliteGroupRepository implements IGroupRepository {
  constructor(private readonly database: SqliteDatabase) {
    database.prepare(prepareGroupsSchema);
  }

  async findById(id: string): Promise<Group | undefined> {
    const connection = this.database.connection;
    const row = connection
      .prepare('SELECT id, name, currency, owner_id, created_at, version FROM groups WHERE id = ?')
      .get(id) as GroupRow | undefined;
    if (!row) return undefined;
    const members = connection
      .prepare('SELECT account_id, role, joined_at FROM group_members WHERE group_id = ? ORDER BY position')
      .all(id) as MemberRow[];
    return Group.fromSnapshot({
      id: String(row.id),
      name: String(row.name),
      currency: String(row.currency) as CurrencyCode,
      ownerId: String(row.owner_id),
      createdAt: String(row.created_at),
      members: members.map((member): MemberSnapshot => ({
        accountId: String(member.account_id),
        role: member.role === 'owner' ? 'owner' : 'member',
        joinedAt: String(member.joined_at),
      })),
      version: Number(row.version),
    });
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
      'INSERT OR IGNORE INTO group_members (group_id, account_id, role, position, joined_at) VALUES (?, ?, ?, ?, ?)',
    );
    snapshot.members.forEach((member, position) => {
      insertMember.run(snapshot.id, member.accountId, member.role, position, member.joinedAt);
    });
    return Result.ok(undefined);
  }
}
