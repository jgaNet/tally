import { randomUUID } from 'node:crypto';
import { type Database, inTransaction } from '../database';
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
