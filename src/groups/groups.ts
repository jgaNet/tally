import { randomUUID } from 'node:crypto';
import { balancesOf } from '../balances/balances';
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
 * Whether `accountId` has ever been a member of `groupId`, whether or not it still is. Reading it
 * changes nothing.
 */
export function hasBeenMember(db: Database, groupId: string, accountId: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM memberships WHERE group_id = ? AND account_id = ?
       UNION ALL
       SELECT 1 FROM former_members WHERE group_id = ? AND account_id = ?`,
    )
    .get(groupId, accountId, groupId, accountId);
  return row !== undefined;
}

/**
 * The accounts among `accountIds` that are no longer members of `groupId`, each once. Those who have
 * left cannot be in a new expense, nor pay one, and an expense that names them cannot be changed.
 */
export function leftMembersAmong(db: Database, groupId: string, accountIds: readonly string[]): string[] {
  const current = new Set(
    (
      db.prepare('SELECT account_id FROM memberships WHERE group_id = ?').all(groupId) as unknown as {
        account_id: string;
      }[]
    ).map(row => row.account_id),
  );
  return [...new Set(accountIds)].filter(accountId => !current.has(accountId));
}

/**
 * Makes `accountId` a member of `groupId`, as a member who joins by an invitation. Someone already
 * a member is refused with `409`. Someone who left joins again as a new member, last in the order.
 * Runs inside `inTransaction`, so the check and the write cannot be split by another join.
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

/**
 * Makes `accountId` leave `groupId`, once its balance is 0 and no payment through the provider involving
 * it is waiting. The owner cannot leave the group they
 * created; anyone outside the group is refused with `404`, as for a group that does not exist. The
 * balance is read and the membership removed in one transaction, so no expense lands between them.
 */
export function leaveGroup(db: Database, groupId: string, accountId: string): void {
  inTransaction(db, () => {
    const group = requireMembership(db, groupId, accountId);
    if (group.ownerId === accountId) {
      throw new Refusal(403, 'OwnerCannotLeave', 'The owner cannot leave the group they created.');
    }
    const balance = balancesOf(db, groupId).find(entry => entry.memberId === accountId)?.balance ?? 0;
    if (balance !== 0) {
      throw new Refusal(409, 'BalanceNotZero', 'Your balance in this group must be 0 before you leave it.');
    }
    // A payment waiting at the provider would still move a balance once it succeeds: it must end first.
    const waiting = db
      .prepare(
        `SELECT 1 FROM settlements
          WHERE group_id = ? AND status = 'pending' AND (payer_id = ? OR payee_id = ?)`,
      )
      .get(groupId, accountId, accountId);
    if (waiting) {
      throw new Refusal(409, 'PaymentPending', 'A payment through the provider is waiting for you: it must end first.');
    }
    db.prepare('DELETE FROM memberships WHERE group_id = ? AND account_id = ?').run(groupId, accountId);
    db.prepare(
      `INSERT INTO former_members (group_id, account_id, left_at) VALUES (?, ?, ?)
       ON CONFLICT (group_id, account_id) DO UPDATE SET left_at = excluded.left_at`,
    ).run(groupId, accountId, new Date().toISOString());
  });
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
