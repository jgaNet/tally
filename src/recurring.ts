import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { checkExpenseFields, insertExpense, type SplitInput } from './expenses';
import { isCalendarDay } from './days';
import { findGroupOfMember, membersOfGroup } from './groups';
import { Refusal } from './refusal';
import { inReadSnapshot, inTransaction } from './transactions';

/** A recurring expense starts no more than this many days before or after today. */
const START_WINDOW_DAYS = 365;
const DAY_MS = 86_400_000;

/** A recurring expense, as a member of its group reads it: the split is the one it was given. */
export interface Recurring {
  readonly id: string;
  readonly groupId: string;
  readonly paidBy: string;
  readonly description: string;
  readonly amount: number;
  readonly startsOn: string;
  /** The day of the next expense it will record. */
  readonly next: string;
  readonly split: SplitInput;
}

interface RecurringRow {
  id: string;
  group_id: string;
  paid_by: string;
  description: string;
  amount: number;
  starts_on: string;
  next_on: string;
  split_kind: SplitInput['kind'];
}

interface PartRow {
  recurring_id: string;
  member_id: string;
  value: number | null;
}

const COLUMNS = 'id, group_id, paid_by, description, amount, starts_on, next_on, split_kind';

/** The day `YYYY-MM-DD` of the same day of the following month (the day is from 1 to 28). */
export function nextMonth(day: string): string {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const next = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
  return `${String(next.year).padStart(4, '0')}-${String(next.month).padStart(2, '0')}${day.slice(7)}`;
}

function splitOf(kind: SplitInput['kind'], parts: readonly PartRow[]): SplitInput {
  if (kind === 'equal') return { kind, memberIds: parts.map(part => part.member_id) };
  if (kind === 'exact') {
    return { kind, parts: parts.map(part => ({ memberId: part.member_id, amount: part.value as number })) };
  }
  return { kind, parts: parts.map(part => ({ memberId: part.member_id, shares: part.value as number })) };
}

function recurringOf(row: RecurringRow, parts: readonly PartRow[]): Recurring {
  return {
    id: row.id,
    groupId: row.group_id,
    paidBy: row.paid_by,
    description: row.description,
    amount: row.amount,
    startsOn: row.starts_on,
    next: row.next_on,
    split: splitOf(row.split_kind, parts),
  };
}

function partsOf(db: DatabaseSync, recurringId: string): PartRow[] {
  return db
    .prepare('SELECT recurring_id, member_id, value FROM recurring_parts WHERE recurring_id = ? ORDER BY position ASC')
    .all(recurringId) as unknown as PartRow[];
}

export interface SetUpRecurringInput {
  readonly groupId: string;
  /** The member who sets it up: its payer. */
  readonly payerId: string;
  readonly description: string;
  readonly amount: number;
  readonly startsOn: string;
  readonly split: SplitInput;
  /** Today (UTC) as the application's clock tells it, `YYYY-MM-DD`. */
  readonly today: string;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / DAY_MS);
}

/**
 * Sets up a recurring expense paid by the caller, and answers its id. Refused with `404` when the payer is not a
 * member of the group, otherwise with `422` when the description, amount or split breaks the rules of an expense,
 * or when `startsOn` is not a real day, is more than 365 days from today, or has a day of the month beyond 28.
 */
export function setUpRecurring(db: DatabaseSync, input: SetUpRecurringInput): string {
  const { groupId, payerId, startsOn, today } = input;
  const id = randomUUID();
  inTransaction(db, () => {
    const group = findGroupOfMember(db, payerId, groupId);
    if (!group) throw new Refusal(404, 'GroupNotFound', 'No group has this id.');
    const checked = checkExpenseFields(
      db,
      groupId,
      group.currency,
      payerId,
      {
        description: input.description,
        amount: { kind: 'group', amount: input.amount },
        date: today,
        split: input.split,
      },
      undefined,
      today,
    );
    if (!isCalendarDay(startsOn)) {
      throw new Refusal(422, 'StartsOnIsInvalid', 'startsOn must be a real day of the calendar, written YYYY-MM-DD.');
    }
    if (Math.abs(daysBetween(today, startsOn)) > START_WINDOW_DAYS) {
      throw new Refusal(422, 'StartsOnIsOutOfRange', 'startsOn must be within 365 days of today.');
    }
    const dayOfMonth = Number(startsOn.slice(8, 10));
    if (dayOfMonth < 1 || dayOfMonth > 28) {
      throw new Refusal(422, 'StartsOnIsNotEveryMonth', 'The day of the month of startsOn must be from 1 to 28.');
    }
    db.prepare(
      `INSERT INTO recurring (id, group_id, paid_by, description, amount, starts_on, next_on, split_kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      groupId,
      payerId,
      checked.description,
      input.amount,
      startsOn,
      startsOn,
      input.split.kind,
      new Date().toISOString(),
    );
    const insertPart = db.prepare(
      'INSERT INTO recurring_parts (recurring_id, position, member_id, value) VALUES (?, ?, ?, ?)',
    );
    const split = input.split;
    if (split.kind === 'equal') {
      split.memberIds.forEach((memberId, position) => insertPart.run(id, position, memberId, null));
    } else if (split.kind === 'exact') {
      split.parts.forEach((part, position) => insertPart.run(id, position, part.memberId, part.amount));
    } else {
      split.parts.forEach((part, position) => insertPart.run(id, position, part.memberId, part.shares));
    }
  });
  return id;
}

/** The recurring expense with this id, when `accountId` is a member of its group; `undefined` otherwise. */
export function findRecurringOfMember(db: DatabaseSync, accountId: string, recurringId: string): Recurring | undefined {
  return inReadSnapshot(db, () => {
    const row = db.prepare(`SELECT ${COLUMNS} FROM recurring WHERE id = ?`).get(recurringId) as
      RecurringRow | undefined;
    if (!row || !findGroupOfMember(db, accountId, row.group_id)) return undefined;
    return recurringOf(row, partsOf(db, row.id));
  });
}

/** The group's recurring expenses, the earliest set up first; `404` when `accountId` is not a member. */
export function recurringOfGroup(db: DatabaseSync, accountId: string, groupId: string): Recurring[] {
  return inReadSnapshot(db, () => {
    if (!findGroupOfMember(db, accountId, groupId)) throw new Refusal(404, 'GroupNotFound', 'No group has this id.');
    const rows = db
      .prepare(`SELECT ${COLUMNS} FROM recurring WHERE group_id = ? ORDER BY created_at ASC, rowid ASC`)
      .all(groupId) as unknown as RecurringRow[];
    return rows.map(row => recurringOf(row, partsOf(db, row.id)));
  });
}

function removeRecurring(db: DatabaseSync, recurringId: string): void {
  db.prepare('DELETE FROM recurring_parts WHERE recurring_id = ?').run(recurringId);
  db.prepare('DELETE FROM recurring WHERE id = ?').run(recurringId);
}

/** Stops a recurring expense: `404` for a non-member, `403` unless the caller is its payer or the group's owner. */
export function stopRecurring(db: DatabaseSync, input: { recurringId: string; accountId: string }): void {
  inTransaction(db, () => {
    const row = db.prepare(`SELECT ${COLUMNS} FROM recurring WHERE id = ?`).get(input.recurringId) as
      RecurringRow | undefined;
    const group = row && findGroupOfMember(db, input.accountId, row.group_id);
    if (!row || !group) throw new Refusal(404, 'RecurringNotFound', 'No recurring expense has this id.');
    if (input.accountId !== row.paid_by && input.accountId !== group.ownerId) {
      throw new Refusal(403, 'NotPayerOrOwner', 'Only the payer or the owner of the group may stop it.');
    }
    removeRecurring(db, row.id);
  });
}

/**
 * One run of the recurring expenses, at `now`: every day of a recurring expense that has come (its day is today or
 * passed) and has no expense yet has its expense recorded, in order, and the next day moves on, all in one write
 * transaction, so each day has one expense whatever servers share the file. On a day when its payer or a member of
 * its split is no longer a member of the group, nothing is recorded and the recurring expense ends. Answers how many
 * expenses it recorded.
 */
export function recordRecurring(db: DatabaseSync, now: Date): number {
  const at = now.toISOString();
  const today = at.slice(0, 10);
  return inTransaction(db, () => {
    let recorded = 0;
    const rows = db
      .prepare(`SELECT ${COLUMNS} FROM recurring WHERE next_on <= ? ORDER BY created_at ASC, rowid ASC`)
      .all(today) as unknown as RecurringRow[];
    for (const row of rows) {
      const split = splitOf(row.split_kind, partsOf(db, row.id));
      const members = new Set(membersOfGroup(db, row.group_id).map(member => member.memberId));
      const splitMembers = split.kind === 'equal' ? split.memberIds : split.parts.map(part => part.memberId);
      if (!members.has(row.paid_by) || splitMembers.some(memberId => !members.has(memberId))) {
        removeRecurring(db, row.id);
        continue;
      }
      const group = db.prepare('SELECT currency FROM groups WHERE id = ?').get(row.group_id) as {
        currency: Parameters<typeof checkExpenseFields>[2];
      };
      let day = row.next_on;
      while (day <= today) {
        const checked = checkExpenseFields(
          db,
          row.group_id,
          group.currency,
          row.paid_by,
          { description: row.description, amount: { kind: 'group', amount: row.amount }, date: day, split },
          undefined,
          today,
        );
        insertExpense(db, {
          id: randomUUID(),
          groupId: row.group_id,
          payerId: row.paid_by,
          date: day,
          split,
          checked,
          at,
          recurring: row.id,
        });
        recorded += 1;
        day = nextMonth(day);
      }
      db.prepare('UPDATE recurring SET next_on = ? WHERE id = ?').run(day, row.id);
    }
    return recorded;
  });
}
