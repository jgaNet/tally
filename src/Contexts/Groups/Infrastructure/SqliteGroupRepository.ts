import { DatabaseSync } from 'node:sqlite';

import { ConcurrencyConflictException, IResult, Result } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { IGroupRepository } from '@Contexts/Groups/Domain/Group/Ports/IGroupRepository';
import { Group } from '@Contexts/Groups/Domain/Group/Group';
import { CurrencyCode } from '@Contexts/Groups/Domain/Group/Currency';
import { MemberSnapshot } from '@Contexts/Groups/Domain/Group/DTOs';

/**
 * The groups' tables. A group's memberships are rows of their own, keyed by the group and the account. A membership is
 * never deleted: a member who leaves keeps its row with `left_at`, so that who has ever been a member is known (docs/adr/0009).
 * `position` is the order the memberships were made, a member who joins again taking the last place.
 */
export const GROUPS_SCHEMA = [
  'CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, currency TEXT NOT NULL, owner_id TEXT NOT NULL, created_at TEXT NOT NULL, version INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS group_members (group_id TEXT NOT NULL REFERENCES groups (id), account_id TEXT NOT NULL, role TEXT NOT NULL, position INTEGER NOT NULL, joined_at TEXT NOT NULL, left_at TEXT, PRIMARY KEY (group_id, account_id))',
  'CREATE INDEX IF NOT EXISTS group_members_by_account ON group_members (account_id)',
].join(';\n');

/**
 * Makes the groups' tables what the store reads, on a file that may have been made before the members had their join
 * dates (feature 2): there, every member is an owner, who joined when its group was created. And before members could
 * leave (request 9): there, no membership has left.
 */
export function prepareGroupsSchema(connection: DatabaseSync): void {
  connection.exec(GROUPS_SCHEMA);
  const columns = (connection.prepare('PRAGMA table_info(group_members)').all() as Array<{ name: string }>).map(
    column => column.name,
  );
  if (!columns.includes('joined_at')) {
    connection.exec(
      "ALTER TABLE group_members ADD COLUMN joined_at TEXT NOT NULL DEFAULT ''; UPDATE group_members SET joined_at = (SELECT created_at FROM groups WHERE groups.id = group_members.group_id)",
    );
  }
  if (!columns.includes('left_at')) connection.exec('ALTER TABLE group_members ADD COLUMN left_at TEXT');
}

type GroupRow = { id: string; name: string; currency: string; owner_id: string; created_at: string; version: number };
type MemberRow = { account_id: string; role: string; joined_at: string; left_at: string | null };

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
      .prepare('SELECT account_id, role, joined_at, left_at FROM group_members WHERE group_id = ? ORDER BY position')
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
        ...(member.left_at === null ? {} : { leftAt: String(member.left_at) }),
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
    // Every membership is written, in the order the snapshot keeps them: a new one is inserted, a former one that joined
    // again or left is updated in place (docs/adr/0009).
    const upsertMember = connection.prepare(
      'INSERT INTO group_members (group_id, account_id, role, position, joined_at, left_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (group_id, account_id) DO UPDATE SET role = excluded.role, position = excluded.position, joined_at = excluded.joined_at, left_at = excluded.left_at',
    );
    snapshot.members.forEach((member, position) => {
      upsertMember.run(snapshot.id, member.accountId, member.role, position, member.joinedAt, member.leftAt ?? null);
    });
    return Result.ok(undefined);
  }
}
