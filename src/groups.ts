import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { balancesOfGroup } from './balances';
import { inTransaction } from './transactions';
import { Refusal } from './refusal';
import { characters } from './text';

/**
 * The currencies a group may use. Each counts in hundredths (cents, pence): every amount of a group
 * is an integer number of hundredths of its currency. A group's currency never changes.
 */
export const CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD'] as const;
export type Currency = (typeof CURRENCIES)[number];

const MAX_NAME_LENGTH = 60;

/** What the application knows of a group, as its members see it. */
export interface Group {
  readonly id: string;
  readonly name: string;
  readonly currency: Currency;
  readonly ownerId: string;
}

interface GroupRow {
  id: string;
  name: string;
  currency: Currency;
  owner_id: string;
}

const GROUP_COLUMNS = 'g.id, g.name, g.currency, g.owner_id';

function groupOf(row: GroupRow): Group {
  return { id: row.id, name: row.name, currency: row.currency, ownerId: row.owner_id };
}

/**
 * Creates a group owned by `ownerId`, whose first member is its owner, and returns its id. The name
 * has 1 to 60 characters and is not only spaces (it is stored trimmed); the currency is one of
 * {@link CURRENCIES}.
 */
export function createGroup(db: DatabaseSync, input: { ownerId: string; name: string; currency: string }): string {
  const { ownerId, name, currency } = input;
  const trimmedName = name.trim();
  if (characters(name) > MAX_NAME_LENGTH || trimmedName.length === 0) {
    throw new Refusal(
      422,
      'NameIsInvalid',
      `The name must have 1 to ${MAX_NAME_LENGTH} characters and not be only spaces.`,
    );
  }
  if (!(CURRENCIES as readonly string[]).includes(currency)) {
    throw new Refusal(422, 'CurrencyIsUnsupported', `The currency must be one of ${CURRENCIES.join(', ')}.`);
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  inTransaction(db, () => {
    db.prepare('INSERT INTO groups (id, name, currency, owner_id, created_at) VALUES (?, ?, ?, ?, ?)').run(
      id,
      trimmedName,
      currency,
      ownerId,
      now,
    );
    db.prepare('INSERT INTO group_members (group_id, account_id, joined_at) VALUES (?, ?, ?)').run(id, ownerId, now);
  });
  return id;
}

/** The group with this id, when `accountId` is one of its current members; `undefined` otherwise, as if it did not exist. */
export function findGroupOfMember(db: DatabaseSync, accountId: string, groupId: string): Group | undefined {
  const row = db
    .prepare(
      `SELECT ${GROUP_COLUMNS} FROM groups g
       JOIN group_members m ON m.group_id = g.id
       WHERE g.id = ? AND m.account_id = ? AND m.left_at IS NULL`,
    )
    .get(groupId, accountId) as GroupRow | undefined;
  return row && groupOf(row);
}

/** A member of a group, as its members see it: the owner is `owner`, every other member `member`. */
export interface Member {
  readonly memberId: string;
  readonly name: string;
  readonly role: 'owner' | 'member';
  readonly joinedAt: string;
}

interface MemberRow {
  member_id: string;
  name: string;
  role: Member['role'];
  joined_at: string;
}

/**
 * The current members of a group, the earliest to join first; the owner, who created the group, is first.
 * A member who left is not among them.
 */
export function membersOfGroup(db: DatabaseSync, groupId: string): Member[] {
  const rows = db
    .prepare(
      `SELECT m.account_id AS member_id, a.name,
              CASE WHEN g.owner_id = m.account_id THEN 'owner' ELSE 'member' END AS role,
              m.joined_at
       FROM group_members m
       JOIN groups g ON g.id = m.group_id
       JOIN accounts a ON a.id = m.account_id
       WHERE m.group_id = ? AND m.left_at IS NULL
       ORDER BY m.joined_at ASC, m.rowid ASC`,
    )
    .all(groupId) as unknown as MemberRow[];
  return rows.map(row => ({ memberId: row.member_id, name: row.name, role: row.role, joinedAt: row.joined_at }));
}

/** The groups `accountId` is a current member of, the most recently created first. */
export function groupsOfMember(db: DatabaseSync, accountId: string): Group[] {
  const rows = db
    .prepare(
      `SELECT ${GROUP_COLUMNS} FROM groups g
       JOIN group_members m ON m.group_id = g.id
       WHERE m.account_id = ? AND m.left_at IS NULL
       ORDER BY g.created_at DESC, g.rowid DESC`,
    )
    .all(accountId) as unknown as GroupRow[];
  return rows.map(groupOf);
}

/**
 * True when `accountId` is a member of the group now or has been one: a member who left keeps the record
 * of having been one, so that the group's members can still read their statement. Reading changes nothing.
 */
export function isOrWasMember(db: DatabaseSync, accountId: string, groupId: string): boolean {
  return (
    db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND account_id = ?').get(groupId, accountId) !==
    undefined
  );
}

/**
 * Makes `accountId` leave the group, which they must be a current member of (else `404`, as if the group
 * did not exist). The owner, who created the group, cannot leave it (`403`). The member's balance in the
 * group must be 0 (else `409`): what they owe or are owed is settled. A member who left is no longer among
 * the group's members or balances, and the group is not among their groups; their expenses stay as they were.
 */
export function leaveGroup(db: DatabaseSync, input: { groupId: string; accountId: string }): void {
  const { groupId, accountId } = input;
  inTransaction(db, () => {
    const group = findGroupOfMember(db, accountId, groupId);
    if (!group) throw new Refusal(404, 'GroupNotFound', 'No group has this id.');
    if (group.ownerId === accountId) {
      throw new Refusal(403, 'OwnerCannotLeave', 'The owner created the group and cannot leave it.');
    }
    const balance = balancesOfGroup(db, groupId).find(member => member.memberId === accountId)?.balance ?? 0;
    if (balance !== 0) {
      throw new Refusal(409, 'BalanceIsNotZero', 'The balance must be 0 to leave the group.');
    }
    db.prepare('UPDATE group_members SET left_at = ? WHERE group_id = ? AND account_id = ?').run(
      new Date().toISOString(),
      groupId,
      accountId,
    );
  });
}
