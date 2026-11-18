import { randomUUID } from 'node:crypto';
import { checkExpenseFields, insertExpense, type SplitInput } from './expenses';
import { isCalendarDay } from './days';
import type { Database, Querier } from './database';
import { assertNotArchived, findGroupOfMember, membersOfGroup } from './groups';
import { assertNotSuspended, isSuspended } from './suspensions';
import type { Category } from './categories';
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
  /** The category of the expenses it records: `other` when it was given none. */
  readonly category: Category;
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
  category: Category;
}

interface PartRow {
  recurring_id: string;
  member_id: string;
  value: number | null;
}

const COLUMNS = 'id, group_id, paid_by, description, amount, starts_on, next_on, split_kind, category';

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
    category: row.category,
  };
}

async function partsOf(db: Querier, recurringId: string): Promise<PartRow[]> {
  return db
    .prepare('SELECT recurring_id, member_id, value FROM recurring_parts WHERE recurring_id = ? ORDER BY position ASC')
    .all<PartRow>(recurringId);
}

export interface SetUpRecurringInput {
  readonly groupId: string;
  /** The member who sets it up: its payer. */
  readonly payerId: string;
  readonly description: string;
  readonly amount: number;
  readonly startsOn: string;
  readonly split: SplitInput;
  /** The category of the expenses it records, when given; `other` when left out. */
  readonly category?: string;
  /** Today (UTC) as the application's clock tells it, `YYYY-MM-DD`. */
  readonly today: string;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / DAY_MS);
}

/**
 * Sets up a recurring expense paid by the caller, and answers its id. Refused with `404` when the payer is not a
 * member of the group, otherwise with `422` when the description, amount or split breaks the rules of an expense,
 * or when `startsOn` is not a real day, is more than 365 days from today, or has a day of the month beyond 28. Refused
 * with `403` as `AccountIsSuspended` when the payer is suspended.
 */
export async function setUpRecurring(db: Database, input: SetUpRecurringInput): Promise<string> {
  const { groupId, payerId, startsOn, today } = input;
  const id = randomUUID();
  await inTransaction(db, async tx => {
    const group = await findGroupOfMember(tx, payerId, groupId);
    if (!group) throw new Refusal(404, 'GroupNotFound', 'No group has this id.');
    assertNotArchived(group);
    await assertNotSuspended(tx, payerId);
    const checked = await checkExpenseFields(
      tx,
      groupId,
      group.currency,
      payerId,
      {
        description: input.description,
        amount: { kind: 'group', amount: input.amount },
        date: today,
        split: input.split,
        category: input.category,
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
    await tx
      .prepare(
        `INSERT INTO recurring (id, group_id, paid_by, description, amount, starts_on, next_on, split_kind, category, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        groupId,
        payerId,
        checked.description,
        input.amount,
        startsOn,
        startsOn,
        input.split.kind,
        checked.category,
        new Date().toISOString(),
      );
    const insertPart = tx.prepare(
      'INSERT INTO recurring_parts (recurring_id, position, member_id, value) VALUES (?, ?, ?, ?)',
    );
    const split = input.split;
    if (split.kind === 'equal') {
      for (const [position, memberId] of split.memberIds.entries()) await insertPart.run(id, position, memberId, null);
    } else if (split.kind === 'exact') {
      for (const [position, part] of split.parts.entries())
        await insertPart.run(id, position, part.memberId, part.amount);
    } else {
      for (const [position, part] of split.parts.entries())
        await insertPart.run(id, position, part.memberId, part.shares);
    }
  });
  return id;
}

/** The recurring expense with this id, when `accountId` is a member of its group; `undefined` otherwise. */
export async function findRecurringOfMember(
  db: Database,
  accountId: string,
  recurringId: string,
): Promise<Recurring | undefined> {
  return inReadSnapshot(db, async snapshot => {
    const row = await snapshot.prepare(`SELECT ${COLUMNS} FROM recurring WHERE id = ?`).get<RecurringRow>(recurringId);
    if (!row || !(await findGroupOfMember(snapshot, accountId, row.group_id))) return undefined;
    return recurringOf(row, await partsOf(snapshot, row.id));
  });
}

/** The group's recurring expenses, the earliest set up first; `404` when `accountId` is not a member. */
export async function recurringOfGroup(db: Database, accountId: string, groupId: string): Promise<Recurring[]> {
  return inReadSnapshot(db, async snapshot => {
    if (!(await findGroupOfMember(snapshot, accountId, groupId))) {
      throw new Refusal(404, 'GroupNotFound', 'No group has this id.');
    }
    const rows = await snapshot
      .prepare(`SELECT ${COLUMNS} FROM recurring WHERE group_id = ? ORDER BY created_at ASC, seq ASC`)
      .all<RecurringRow>(groupId);
    const recurring: Recurring[] = [];
    for (const row of rows) recurring.push(recurringOf(row, await partsOf(snapshot, row.id)));
    return recurring;
  });
}

async function removeRecurring(db: Querier, recurringId: string): Promise<void> {
  await db.prepare('DELETE FROM recurring_parts WHERE recurring_id = ?').run(recurringId);
  await db.prepare('DELETE FROM recurring WHERE id = ?').run(recurringId);
}

/**
 * Stops a recurring expense: `404` for a non-member, `409` as `GroupIsArchived` for an archived group, `403` unless the
 * caller is its payer or the group's owner.
 */
export async function stopRecurring(db: Database, input: { recurringId: string; accountId: string }): Promise<void> {
  await inTransaction(db, async tx => {
    const row = await tx.prepare(`SELECT ${COLUMNS} FROM recurring WHERE id = ?`).get<RecurringRow>(input.recurringId);
    const group = row && (await findGroupOfMember(tx, input.accountId, row.group_id));
    if (!row || !group) throw new Refusal(404, 'RecurringNotFound', 'No recurring expense has this id.');
    assertNotArchived(group);
    if (input.accountId !== row.paid_by && input.accountId !== group.ownerId) {
      throw new Refusal(403, 'NotPayerOrOwner', 'Only the payer or the owner of the group may stop it.');
    }
    await removeRecurring(tx, row.id);
  });
}

/**
 * One run of the recurring expenses, at `now`: every day of a recurring expense that has come (its day is today or
 * passed) and has no expense yet has its expense recorded, in order, and the next day moves on, all in one write
 * transaction, so each day has one expense whatever servers share the database. On a day when its payer or a member of
 * its split is no longer a member of the group, nothing is recorded and the recurring expense ends. A recurring expense
 * of an archived group records nothing, and is left as it is. A recurring expense whose payer is suspended records nothing
 * and is left as it is, its days waiting until the payer is reinstated: the run after that records every day that has come.
 * Answers how many expenses it recorded.
 */
export async function recordRecurring(db: Database, now: Date): Promise<number> {
  const at = now.toISOString();
  const today = at.slice(0, 10);
  return inTransaction(db, async tx => {
    let recorded = 0;
    const rows = await tx
      .prepare(
        `SELECT ${COLUMNS} FROM recurring
         WHERE next_on <= ? AND group_id NOT IN (SELECT id FROM groups WHERE archived_at IS NOT NULL)
         ORDER BY created_at ASC, seq ASC`,
      )
      .all<RecurringRow>(today);
    for (const row of rows) {
      if (await isSuspended(tx, row.paid_by)) continue;
      const split = splitOf(row.split_kind, await partsOf(tx, row.id));
      const members = new Set((await membersOfGroup(tx, row.group_id)).map(member => member.memberId));
      const splitMembers = split.kind === 'equal' ? split.memberIds : split.parts.map(part => part.memberId);
      if (!members.has(row.paid_by) || splitMembers.some(memberId => !members.has(memberId))) {
        await removeRecurring(tx, row.id);
        continue;
      }
      const group = await tx.prepare('SELECT currency FROM groups WHERE id = ?').get<{
        currency: Parameters<typeof checkExpenseFields>[2];
      }>(row.group_id);
      if (group === undefined) continue;
      let day = row.next_on;
      while (day <= today) {
        const checked = await checkExpenseFields(
          tx,
          row.group_id,
          group.currency,
          row.paid_by,
          {
            description: row.description,
            amount: { kind: 'group', amount: row.amount },
            date: day,
            split,
            category: row.category,
          },
          undefined,
          today,
        );
        await insertExpense(tx, {
          id: randomUUID(),
          groupId: row.group_id,
          payerId: row.paid_by,
          date: day,
          checked,
          at,
          recurring: row.id,
        });
        recorded += 1;
        day = nextMonth(day);
      }
      await tx.prepare('UPDATE recurring SET next_on = ? WHERE id = ?').run(day, row.id);
    }
    return recorded;
  });
}
