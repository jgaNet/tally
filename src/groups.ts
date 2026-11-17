import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
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

/** The group with this id, when `accountId` is one of its members; `undefined` otherwise, as if it did not exist. */
export function findGroupOfMember(db: DatabaseSync, accountId: string, groupId: string): Group | undefined {
  const row = db
    .prepare(
      `SELECT ${GROUP_COLUMNS} FROM groups g
       JOIN group_members m ON m.group_id = g.id
       WHERE g.id = ? AND m.account_id = ?`,
    )
    .get(groupId, accountId) as GroupRow | undefined;
  return row && groupOf(row);
}

/** The groups `accountId` is a member of, the most recently created first. */
export function groupsOfMember(db: DatabaseSync, accountId: string): Group[] {
  const rows = db
    .prepare(
      `SELECT ${GROUP_COLUMNS} FROM groups g
       JOIN group_members m ON m.group_id = g.id
       WHERE m.account_id = ?
       ORDER BY g.created_at DESC, g.rowid DESC`,
    )
    .all(accountId) as unknown as GroupRow[];
  return rows.map(groupOf);
}
