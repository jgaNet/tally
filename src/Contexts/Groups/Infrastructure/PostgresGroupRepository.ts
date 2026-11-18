import { ConcurrencyConflictException, IResult, Result } from '@Architecture/Domain';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { IGroupRepository } from '@Contexts/Groups/Domain/Group/Ports/IGroupRepository';
import { Group } from '@Contexts/Groups/Domain/Group/Group';
import { CurrencyCode } from '@Contexts/Groups/Domain/Group/Currency';
import { MemberSnapshot } from '@Contexts/Groups/Domain/Group/DTOs';

/**
 * The groups' tables. A group's memberships are rows of their own, keyed by the group and the account. A membership is
 * never deleted: a member who leaves keeps its row with `left_at`, so that who has ever been a member is known (docs/adr/0009).
 * `position` is the order the memberships were made, a member who joins again taking the last place. `seq` is the order
 * the rows were made in (the SQLite file's rowid): the list of groups and the audit of the balances read by it.
 */
export const GROUPS_SCHEMA = [
  'CREATE TABLE IF NOT EXISTS groups (seq BIGSERIAL NOT NULL UNIQUE, id TEXT PRIMARY KEY, name TEXT NOT NULL, currency TEXT NOT NULL, owner_id TEXT NOT NULL, created_at TEXT NOT NULL, archived_at TEXT, version INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS group_members (group_id TEXT NOT NULL REFERENCES groups (id) DEFERRABLE INITIALLY DEFERRED, account_id TEXT NOT NULL, role TEXT NOT NULL, position INTEGER NOT NULL, joined_at TEXT NOT NULL, left_at TEXT, passed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (group_id, account_id))',
  'CREATE INDEX IF NOT EXISTS group_members_by_account ON group_members (account_id)',
  // The balances that passed to the owner when a member left, one row each, never changed: the group's audit (request 28, docs/adr/0027).
  'CREATE TABLE IF NOT EXISTS passed_balances (seq BIGSERIAL NOT NULL UNIQUE, id TEXT PRIMARY KEY, group_id TEXT NOT NULL, member_id TEXT NOT NULL, amount INTEGER NOT NULL, at TEXT NOT NULL)',
].join(';\n');

/** The groups' schema steps, run once when the database is prepared (docs/adr/0029). Every statement creates only. */
export async function prepareGroupsSchema(database: PostgresDatabase): Promise<void> {
  await database.exec(GROUPS_SCHEMA);
}

type GroupRow = {
  id: string;
  name: string;
  currency: string;
  owner_id: string;
  created_at: string;
  archived_at: string | null;
  version: number;
};
type MemberRow = { account_id: string; role: string; joined_at: string; left_at: string | null; passed: number };

/** The groups' store over PostgreSQL (docs/adr/0001). Its methods run inside a transaction: the use case's. */
export class PostgresGroupRepository implements IGroupRepository {
  constructor(private readonly database: PostgresDatabase) {
    database.prepare(prepareGroupsSchema);
  }

  async findById(id: string): Promise<Group | undefined> {
    const row = await this.database.get<GroupRow>(
      'SELECT id, name, currency, owner_id, created_at, archived_at, version FROM groups WHERE id = ?',
      [id],
    );
    if (!row) return undefined;
    const members = await this.database.all<MemberRow>(
      'SELECT account_id, role, joined_at, left_at, passed FROM group_members WHERE group_id = ? ORDER BY position',
      [id],
    );
    return Group.fromSnapshot({
      id: String(row.id),
      name: String(row.name),
      currency: String(row.currency) as CurrencyCode,
      ownerId: String(row.owner_id),
      createdAt: String(row.created_at),
      ...(row.archived_at === null ? {} : { archivedAt: String(row.archived_at) }),
      members: members.map((member): MemberSnapshot => ({
        accountId: String(member.account_id),
        role: member.role === 'owner' ? 'owner' : 'member',
        joinedAt: String(member.joined_at),
        ...(member.left_at === null ? {} : { leftAt: String(member.left_at) }),
        ...(Number(member.passed) === 0 ? {} : { passed: Number(member.passed) }),
      })),
      version: Number(row.version),
    });
  }

  async save(group: Group): Promise<IResult<undefined>> {
    this.database.assertInTransaction();
    const snapshot = group.toSnapshot();
    if (snapshot.version === 0) {
      await this.database.run(
        'INSERT INTO groups (id, name, currency, owner_id, created_at, version) VALUES (?, ?, ?, ?, ?, ?)',
        [snapshot.id, snapshot.name, snapshot.currency, snapshot.ownerId, snapshot.createdAt, snapshot.version + 1],
      );
    } else {
      const { changes } = await this.database.run(
        'UPDATE groups SET name = ?, currency = ?, owner_id = ?, archived_at = ?, version = ? WHERE id = ? AND version = ?',
        [
          snapshot.name,
          snapshot.currency,
          snapshot.ownerId,
          snapshot.archivedAt ?? null,
          snapshot.version + 1,
          snapshot.id,
          snapshot.version,
        ],
      );
      if (changes === 0) {
        return Result.fail(new ConcurrencyConflictException('Groups', 'The group changed since it was read'));
      }
    }
    // Every membership is written, in the order the snapshot keeps them: a new one is inserted, a former one that joined
    // again or left is updated in place (docs/adr/0009).
    for (const [position, member] of snapshot.members.entries()) {
      await this.database.run(
        'INSERT INTO group_members (group_id, account_id, role, position, joined_at, left_at, passed) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (group_id, account_id) DO UPDATE SET role = excluded.role, position = excluded.position, joined_at = excluded.joined_at, left_at = excluded.left_at, passed = excluded.passed',
        [
          snapshot.id,
          member.accountId,
          member.role,
          position,
          member.joinedAt,
          member.leftAt ?? null,
          member.passed ?? 0,
        ],
      );
    }
    // A balance that passed is an entry of the group's audit, written with the departure in this transaction (request 28).
    for (const leave of group.passedLeaves) {
      await this.database.run(
        'INSERT INTO passed_balances (id, group_id, member_id, amount, at) VALUES (?, ?, ?, ?, ?)',
        [leave.id, snapshot.id, leave.memberId, leave.amount, leave.at],
      );
    }
    return Result.ok(undefined);
  }

  async remove(group: Group): Promise<IResult<undefined>> {
    this.database.assertInTransaction();
    const snapshot = group.toSnapshot();
    // The memberships go first: they reference the group. A conflict rolls the whole transaction back.
    await this.database.run('DELETE FROM group_members WHERE group_id = ?', [snapshot.id]);
    const { changes } = await this.database.run('DELETE FROM groups WHERE id = ? AND version = ?', [
      snapshot.id,
      snapshot.version,
    ]);
    if (changes === 0) {
      return Result.fail(new ConcurrencyConflictException('Groups', 'The group changed since it was read'));
    }
    return Result.ok(undefined);
  }

  async movePassedBalances(fromGroupId: string, intoGroupId: string): Promise<void> {
    this.database.assertInTransaction();
    await this.database.run('UPDATE passed_balances SET group_id = ? WHERE group_id = ?', [intoGroupId, fromGroupId]);
  }
}
