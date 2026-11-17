import { randomUUID } from 'node:crypto';
import { type Database, inTransaction } from '../database';
import { Refusal } from '../refusal';
import { type Currency, type GroupInput, validateGroup } from './validation';

export interface Group {
  id: string;
  name: string;
  currency: Currency;
  ownerId: string;
}

interface GroupRow {
  id: string;
  name: string;
  currency: Currency;
  owner_id: string;
}

const toGroup = (row: GroupRow): Group => ({
  id: row.id,
  name: row.name,
  currency: row.currency,
  ownerId: row.owner_id,
});

/**
 * Creates a group owned by `ownerId`, whose first member its owner is. The group and that
 * membership are written together, or not at all.
 */
export function createGroup(db: Database, ownerId: string, input: GroupInput): string {
  const group = validateGroup(input);
  const id = randomUUID();
  const now = new Date().toISOString();
  inTransaction(db, () => {
    db.prepare('INSERT INTO groups (id, name, currency, owner_id, created_at) VALUES (?, ?, ?, ?, ?)').run(
      id,
      group.name,
      group.currency,
      ownerId,
      now,
    );
    db.prepare('INSERT INTO memberships (group_id, account_id, joined_at) VALUES (?, ?, ?)').run(id, ownerId, now);
  });
  return id;
}

/**
 * The group, when `accountId` is one of its members. For anyone else it is `undefined`, the same
 * as a group that does not exist.
 */
export function groupForMember(db: Database, groupId: string, accountId: string): Group | undefined {
  const row = db
    .prepare(
      `SELECT groups.id, groups.name, groups.currency, groups.owner_id
         FROM groups JOIN memberships ON memberships.group_id = groups.id
        WHERE groups.id = ? AND memberships.account_id = ?`,
    )
    .get(groupId, accountId) as GroupRow | undefined;
  return row === undefined ? undefined : toGroup(row);
}

/** The groups `accountId` is a member of, the most recently created first. */
export function groupsOfMember(db: Database, accountId: string): Group[] {
  const rows = db
    .prepare(
      `SELECT groups.id, groups.name, groups.currency, groups.owner_id
         FROM groups JOIN memberships ON memberships.group_id = groups.id
        WHERE memberships.account_id = ?
        ORDER BY groups.created_at DESC, groups.rowid DESC`,
    )
    .all(accountId) as unknown as GroupRow[];
  return rows.map(toGroup);
}

/**
 * The group, for a member of it. Anyone else is refused with `404`, the same as a group that does
 * not exist: the group is not there for them.
 */
export function requireMembership(db: Database, groupId: string, accountId: string): Group {
  const group = groupForMember(db, groupId, accountId);
  if (!group) {
    throw new Refusal(404, 'NotFound', 'There is no such group.');
  }
  return group;
}

/**
 * Makes `accountId` a member of `groupId`, as a member who joins by an invitation. Someone already
 * a member is refused with `409`. Runs inside `inTransaction`, so the check and the write cannot
 * be split by another join.
 */
export function joinGroup(db: Database, groupId: string, accountId: string): void {
  const existing = db
    .prepare('SELECT 1 FROM memberships WHERE group_id = ? AND account_id = ?')
    .get(groupId, accountId);
  if (existing) {
    throw new Refusal(409, 'AlreadyMember', 'You are already a member of this group.');
  }
  db.prepare('INSERT INTO memberships (group_id, account_id, joined_at) VALUES (?, ?, ?)').run(
    groupId,
    accountId,
    new Date().toISOString(),
  );
}

export interface Member {
  memberId: string;
  name: string;
  role: 'owner' | 'member';
  joinedAt: string;
}

interface MemberRow {
  member_id: string;
  name: string;
  owner_id: string;
  joined_at: string;
}

/**
 * The members of a group, the earliest to join first. The owner joined when the group was made,
 * so is first. Two joins at the same instant keep the order they were written in.
 */
export function membersOf(db: Database, groupId: string): Member[] {
  const rows = db
    .prepare(
      `SELECT accounts.id AS member_id, accounts.name, groups.owner_id, memberships.joined_at
         FROM memberships
         JOIN accounts ON accounts.id = memberships.account_id
         JOIN groups ON groups.id = memberships.group_id
        WHERE memberships.group_id = ?
        ORDER BY memberships.joined_at, memberships.rowid`,
    )
    .all(groupId) as unknown as MemberRow[];
  return rows.map(row => ({
    memberId: row.member_id,
    name: row.name,
    role: row.member_id === row.owner_id ? 'owner' : 'member',
    joinedAt: row.joined_at,
  }));
}
