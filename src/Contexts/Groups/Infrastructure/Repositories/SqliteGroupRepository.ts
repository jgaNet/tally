import { ConcurrencyConflictException, IResult, Result } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { Group } from '@Contexts/Groups/Domain/Group/Group';
import { IBalancePassingSnapshot, IGroupMemberSnapshot, IGroupSnapshot } from '@Contexts/Groups/Domain/Group/DTOs';
import { IGroupRepository } from '@Contexts/Groups/Domain/Group/Ports/IGroupRepository';

/**
 * The tables of groups: one row per group; one row per current member of it, in the order they joined, with when; one
 * row per former member, the accounts that left (request 9), with when they last joined; and one row per balance passed
 * on when a member left, in the order they were passed (request 20).
 */
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
      joined_at TEXT NOT NULL,
      PRIMARY KEY (group_id, account_id)
    );
    CREATE TABLE IF NOT EXISTS former_members (
      group_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      joined_at TEXT NOT NULL,
      PRIMARY KEY (group_id, account_id)
    );
    CREATE TABLE IF NOT EXISTS balance_passings (
      group_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      from_account TEXT NOT NULL,
      to_account TEXT NOT NULL,
      amount INTEGER NOT NULL,
      PRIMARY KEY (group_id, seq)
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
      .prepare('SELECT account_id, joined_at FROM group_members WHERE group_id = ? ORDER BY position')
      .all(id) as Array<{ account_id: string; joined_at: string }>;
    const formerMembers = this.database.connection
      .prepare('SELECT account_id, joined_at FROM former_members WHERE group_id = ? ORDER BY rowid')
      .all(id) as Array<{ account_id: string; joined_at: string }>;
    const passings = this.database.connection
      .prepare('SELECT from_account, to_account, amount FROM balance_passings WHERE group_id = ? ORDER BY seq')
      .all(id) as Array<{ from_account: string; to_account: string; amount: number }>;
    return Group.fromSnapshot(
      toSnapshot(
        row,
        members.map(member => ({ accountId: member.account_id, joinedAt: member.joined_at })),
        formerMembers.map(member => ({ accountId: member.account_id, joinedAt: member.joined_at })),
        passings.map(passing => ({ from: passing.from_account, to: passing.to_account, amount: passing.amount })),
      ),
    );
  }

  /**
   * The optimistic check as SQL makes it atomic: the update applies only to the row still at the version the group
   * was read at; no row changed means another writer got there first (ADR 8). A new group is inserted at version 1.
   * Its name is the only column an update writes: the currency and the owner are fixed at the creation, and no
   * behaviour changes them. The members are written as the aggregate holds them, in their order, and the former
   * members too: the rows of the group are replaced by its snapshot, in the same transaction as the version check.
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

    this.database.connection.prepare('DELETE FROM group_members WHERE group_id = ?').run(id);
    this.database.connection.prepare('DELETE FROM former_members WHERE group_id = ?').run(id);
    const addMember = this.database.connection.prepare(
      'INSERT INTO group_members (group_id, account_id, position, joined_at) VALUES (?, ?, ?, ?)',
    );
    snapshot.members.forEach((member: IGroupMemberSnapshot, position) =>
      addMember.run(id, member.accountId, position, member.joinedAt),
    );
    const addFormer = this.database.connection.prepare(
      'INSERT INTO former_members (group_id, account_id, joined_at) VALUES (?, ?, ?)',
    );
    snapshot.formerMembers.forEach((member: IGroupMemberSnapshot) =>
      addFormer.run(id, member.accountId, member.joinedAt),
    );
    this.database.connection.prepare('DELETE FROM balance_passings WHERE group_id = ?').run(id);
    const addPassing = this.database.connection.prepare(
      'INSERT INTO balance_passings (group_id, seq, from_account, to_account, amount) VALUES (?, ?, ?, ?, ?)',
    );
    snapshot.passings.forEach((passing, seq) => addPassing.run(id, seq, passing.from, passing.to, passing.amount));
    return Result.ok();
  }
}

function toSnapshot(
  row: GroupRow,
  members: IGroupMemberSnapshot[],
  formerMembers: IGroupMemberSnapshot[],
  passings: IBalancePassingSnapshot[],
): IGroupSnapshot {
  return {
    _id: row.id,
    name: row.name,
    currency: row.currency,
    ownerId: row.owner_id,
    members,
    formerMembers,
    passings,
    createdAt: row.created_at,
    version: row.version,
  };
}
