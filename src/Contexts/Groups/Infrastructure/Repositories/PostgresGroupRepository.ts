import { ConcurrencyConflictException, IResult, Result } from '@Architecture/Domain';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { Group } from '@Contexts/Groups/Domain/Group/Group';
import { IBalancePassingSnapshot, IGroupMemberSnapshot, IGroupSnapshot } from '@Contexts/Groups/Domain/Group/DTOs';
import { IGroupRepository } from '@Contexts/Groups/Domain/Group/Ports/IGroupRepository';

/**
 * The tables of groups: one row per group, in the order they were made (`seq`, which the lists of groups order by); one
 * row per current member of it, in the order they joined, with when; one row per former member, the accounts that left
 * (request 9), in the order they left (`seq`), with when they last joined; and one row per balance passed on when a
 * member left, in the order they were passed (request 20).
 */
export function createGroupsTables(database: PostgresDatabase): void {
  database.define(`
    CREATE TABLE IF NOT EXISTS groups (
      seq BIGSERIAL NOT NULL,
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      currency TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      archived_at TEXT,
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
      seq BIGSERIAL NOT NULL,
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
  // The audit (request 28): one entry per balance passed on, written in the transaction of the leave and never changed.
  database.define(`
    CREATE TABLE IF NOT EXISTS group_audit (
      seq BIGSERIAL PRIMARY KEY,
      id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      at TEXT NOT NULL,
      by_account TEXT NOT NULL,
      action TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      amount INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS group_audit_by_group ON group_audit (group_id);
  `);
}

interface GroupRow {
  id: string;
  name: string;
  currency: string;
  owner_id: string;
  created_at: string;
  archived_at: string | null;
  version: number;
}

/**
 * The groups as aggregates, over the application's PostgreSQL database. Used inside the transaction of the command that
 * asks for it, whose scope carries its statements, so they are part of that transaction.
 */
export class PostgresGroupRepository implements IGroupRepository {
  constructor(private database: PostgresDatabase) {
    createGroupsTables(database);
  }

  async findById(id: string): Promise<Group | null> {
    const row = await this.database.get<GroupRow>('SELECT * FROM groups WHERE id = ?', [id]);
    if (!row) return null;

    const members = await this.database.all<{ account_id: string; joined_at: string }>(
      'SELECT account_id, joined_at FROM group_members WHERE group_id = ? ORDER BY position',
      [id],
    );
    const formerMembers = await this.database.all<{ account_id: string; joined_at: string }>(
      'SELECT account_id, joined_at FROM former_members WHERE group_id = ? ORDER BY seq',
      [id],
    );
    const passings = await this.database.all<{ from_account: string; to_account: string; amount: number }>(
      'SELECT from_account, to_account, amount FROM balance_passings WHERE group_id = ? ORDER BY seq',
      [id],
    );
    return Group.fromSnapshot(
      toSnapshot(
        row,
        members.map(member => ({ accountId: member.account_id, joinedAt: member.joined_at })),
        formerMembers.map(member => ({ accountId: member.account_id, joinedAt: member.joined_at })),
        passings.map(passing => ({ from: passing.from_account, to: passing.to_account, amount: passing.amount })),
        row.archived_at,
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
    const { _id: id, name, currency, ownerId, createdAt, archivedAt, version } = snapshot;

    const updated = await this.database.run(
      'UPDATE groups SET name = ?, archived_at = ?, version = ? WHERE id = ? AND version = ?',
      [name, archivedAt, version + 1, id, version],
    );

    if (updated.changes === 0) {
      const stored = await this.database.get('SELECT version FROM groups WHERE id = ?', [id]);
      if (stored) {
        return Result.fail(new ConcurrencyConflictException('Groups', 'The group changed since it was read', { id }));
      }
      await this.database.run(
        'INSERT INTO groups (id, name, currency, owner_id, created_at, archived_at, version) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id, name, currency, ownerId, createdAt, archivedAt, version + 1],
      );
    }

    await this.database.run('DELETE FROM group_members WHERE group_id = ?', [id]);
    await this.database.run('DELETE FROM former_members WHERE group_id = ?', [id]);
    for (const [position, member] of snapshot.members.entries()) {
      await this.database.run(
        'INSERT INTO group_members (group_id, account_id, position, joined_at) VALUES (?, ?, ?, ?)',
        [id, member.accountId, position, member.joinedAt],
      );
    }
    for (const member of snapshot.formerMembers) {
      await this.database.run('INSERT INTO former_members (group_id, account_id, joined_at) VALUES (?, ?, ?)', [
        id,
        member.accountId,
        member.joinedAt,
      ]);
    }
    await this.database.run('DELETE FROM balance_passings WHERE group_id = ?', [id]);
    for (const [seq, passing] of snapshot.passings.entries()) {
      await this.database.run(
        'INSERT INTO balance_passings (group_id, seq, from_account, to_account, amount) VALUES (?, ?, ?, ?, ?)',
        [id, seq, passing.from, passing.to, passing.amount],
      );
    }
    for (const entry of group.newAuditEntries) {
      await this.database.run(
        'INSERT INTO group_audit (id, group_id, at, by_account, action, subject_id, amount) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [entry.id, entry.groupId, entry.at, entry.by, entry.action, entry.subjectId, entry.amount],
      );
    }
    return Result.ok();
  }

  /**
   * The group kept is saved as `save()` saves it. The group merged is then removed at the version it was read at, with its
   * members, its former members and its passed balances, which the group kept now holds; its audit entries are moved to the group
   * kept, in their order (request 31). Both are in the transaction of the merge, so the group merged is gone at once.
   */
  async absorb(kept: Group, merged: Group): Promise<IResult> {
    const saved = await this.save(kept);
    if (saved.isFailure()) return saved;

    const { _id: mergedId, version } = merged.toSnapshot();
    const deleted = await this.database.run('DELETE FROM groups WHERE id = ? AND version = ?', [mergedId, version]);
    if (deleted.changes === 0) {
      return Result.fail(
        new ConcurrencyConflictException('Groups', 'The group changed since it was read', { id: mergedId }),
      );
    }
    await this.database.run('DELETE FROM group_members WHERE group_id = ?', [mergedId]);
    await this.database.run('DELETE FROM former_members WHERE group_id = ?', [mergedId]);
    await this.database.run('DELETE FROM balance_passings WHERE group_id = ?', [mergedId]);
    await this.database.run('UPDATE group_audit SET group_id = ? WHERE group_id = ?', [kept._id.value, mergedId]);
    return Result.ok();
  }
}

function toSnapshot(
  row: GroupRow,
  members: IGroupMemberSnapshot[],
  formerMembers: IGroupMemberSnapshot[],
  passings: IBalancePassingSnapshot[],
  archivedAt: string | null,
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
    archivedAt,
    version: row.version,
  };
}
