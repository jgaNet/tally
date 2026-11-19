import { randomUUID } from 'node:crypto';
import { type Database, inTransaction } from '../database';
import type { Category } from '../budgets/categories';
import { insertExpense, memberIdsOf } from '../expenses/expenses';
import {
  type SplitInput,
  type ValidExpense,
  memberIdsInSplit,
  todayInUtc,
  validateExpense,
} from '../expenses/validation';
import { isSuspended, requireNotSuspended } from '../admin/suspensions';
import { isArchived, requireMembership, requireNotArchived } from '../groups/groups';
import { Refusal } from '../refusal';

/** How many days before or after today `startsOn` may be. */
const START_WINDOW_DAYS = 365;

export interface Recurring {
  id: string;
  groupId: string;
  paidBy: string;
  description: string;
  amount: number;
  startsOn: string;
  /** The day of the next expense it will record. */
  next: string;
  /** The split as it was given: exactly one of the three. */
  split: SplitInput;
  /** The category of each expense it records. */
  category: Category;
}

export interface RecurringInput {
  description: string;
  amount: number;
  startsOn: string;
  split: SplitInput;
  /** As given: one of the categories, or none, which makes its expenses `other`. */
  category?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether `text` is a real day of the calendar, written `YYYY-MM-DD`, whose day of the month is 1 to 28. */
function isStartDay(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match === null) {
    return false;
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day && day <= 28;
}

/** The same day of the month after `day`. Every start day is from 1 to 28, so the next month has it. */
export function monthAfter(day: string): string {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const [nextYear, nextMonth] = month === 12 ? [year + 1, 1] : [year, month + 1];
  return `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}-${day.slice(8)}`;
}

function checkStartsOn(startsOn: string): void {
  const refusal = new Refusal(
    422,
    'InvalidStartsOn',
    'startsOn must be a day of the calendar, written YYYY-MM-DD, from 1 to 28 of its month, within 365 days of today.',
  );
  if (!isStartDay(startsOn)) {
    throw refusal;
  }
  const today = Date.parse(todayInUtc());
  if (Math.abs(Date.parse(startsOn) - today) > START_WINDOW_DAYS * DAY_MS) {
    throw refusal;
  }
}

interface RecurringRow {
  id: string;
  group_id: string;
  paid_by: string;
  description: string;
  amount: number;
  split: string;
  starts_on: string;
  next_on: string;
  category: Category;
}

const COLUMNS = 'id, group_id, paid_by, description, amount, split, starts_on, next_on, category';

function toRecurring(row: RecurringRow): Recurring {
  return {
    id: row.id,
    groupId: row.group_id,
    paidBy: row.paid_by,
    description: row.description,
    amount: row.amount,
    startsOn: row.starts_on,
    next: row.next_on,
    split: JSON.parse(row.split) as SplitInput,
    category: row.category,
  };
}

/** Sets up a recurring expense of `groupId`, `payerId` its payer, who must be a member. Returns its id. */
export function createRecurring(
  db: Database,
  groupId: string,
  payerId: string,
  input: RecurringInput,
): Promise<string> {
  return inTransaction(db, async () => {
    const group = await requireMembership(db, groupId, payerId);
    await requireNotSuspended(db, payerId);
    await requireNotArchived(db, groupId);
    // The same rules as an expense's description, amount and split; the day is checked as startsOn below.
    const checked = validateExpense(
      {
        description: input.description,
        money: { kind: 'group', amount: input.amount },
        date: todayInUtc(),
        split: input.split,
        category: input.category,
      },
      await memberIdsOf(db, groupId),
      payerId,
      group.currency,
    );
    checkStartsOn(input.startsOn);
    const id = randomUUID();
    await db.execute(
      `INSERT INTO recurring (id, group_id, paid_by, description, amount, split, starts_on, next_on, category, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        groupId,
        payerId,
        checked.description,
        checked.amount,
        JSON.stringify(checked.split),
        input.startsOn,
        input.startsOn,
        checked.category,
        new Date().toISOString(),
      ],
    );
    return id;
  });
}

/** The recurring expense, for a member of its group; anyone else is refused as if it did not exist. */
export async function requireRecurring(db: Database, id: string, accountId: string): Promise<Recurring> {
  const row = await db.row<RecurringRow>(
    `SELECT ${COLUMNS.split(', ')
      .map(column => `recurring.${column}`)
      .join(', ')}
       FROM recurring JOIN memberships ON memberships.group_id = recurring.group_id
      WHERE recurring.id = ? AND memberships.account_id = ?`,
    [id, accountId],
  );
  if (row === undefined) {
    throw new Refusal(404, 'NotFound', 'There is no such recurring expense.');
  }
  return toRecurring(row);
}

/** The group's recurring expenses, the earliest set up first. */
export async function recurringOfGroup(db: Database, groupId: string): Promise<Recurring[]> {
  const rows = await db.rows<RecurringRow>(
    `SELECT ${COLUMNS} FROM recurring WHERE group_id = ? ORDER BY created_at, seq`,
    [groupId],
  );
  return rows.map(toRecurring);
}

/** Stops the recurring expense, by its payer or the owner of its group. The expenses it recorded stay. */
export function stopRecurring(db: Database, id: string, accountId: string): Promise<void> {
  return inTransaction(db, async () => {
    const recurring = await requireRecurring(db, id, accountId);
    await requireNotArchived(db, recurring.groupId);
    if (
      recurring.paidBy !== accountId &&
      (await requireMembership(db, recurring.groupId, accountId)).ownerId !== accountId
    ) {
      throw new Refusal(
        403,
        'NotPermitted',
        'Only the member who set up this recurring expense, or the owner, may stop it.',
      );
    }
    await db.execute('DELETE FROM recurring WHERE id = ?', [id]);
  });
}

/**
 * One run of the job as of `at`: records every expense whose day has come, for every recurring expense, the
 * earlier days first. Each recurring expense is handled in its own transaction that records an expense and
 * moves `next` a month on together, so a day is recorded once, however many servers run and wherever one is
 * stopped. When its payer or a member of its split is no longer a member, the day is not recorded and the
 * recurring expense is deleted. While its payer is suspended, no day is recorded and none moves: they wait.
 */
export async function recordRecurring(db: Database, at: Date): Promise<void> {
  const today = at.toISOString().slice(0, 10);
  const due = await db.rows<{ id: string }>(
    `SELECT recurring.id FROM recurring JOIN groups ON groups.id = recurring.group_id
      WHERE recurring.next_on <= ? AND groups.archived_at IS NULL
      ORDER BY recurring.created_at, recurring.seq`,
    [today],
  );
  for (const { id } of due) {
    for (let more = true; more;) {
      more = await inTransaction(db, () => recordNextDay(db, id, today, at));
    }
  }
}

/** Records the day `next` of one recurring expense when it is due; says whether another day may be due. */
async function recordNextDay(db: Database, id: string, today: string, at: Date): Promise<boolean> {
  const row = await db.row<RecurringRow>(`SELECT ${COLUMNS} FROM recurring WHERE id = ?`, [id]);
  if (row === undefined || row.next_on > today) {
    return false;
  }
  // The group may have been archived since the run began: an archived group records nothing.
  if (await isArchived(db, row.group_id)) {
    return false;
  }
  // The payer may have been suspended since the run began: the day waits, and is recorded at the first run after the
  // payer is reinstated, `next` not moved.
  if (await isSuspended(db, row.paid_by)) {
    return false;
  }
  const recurring = toRecurring(row);
  const members = await memberIdsOf(db, recurring.groupId);
  const named = [recurring.paidBy, ...memberIdsInSplit(recurring.split)];
  if (!named.every(accountId => members.has(accountId))) {
    await db.execute('DELETE FROM recurring WHERE id = ?', [id]);
    return false;
  }
  const expense: ValidExpense = {
    description: recurring.description,
    amount: recurring.amount,
    date: recurring.next,
    split: recurring.split,
    category: recurring.category,
  };
  await insertExpense(db, recurring.groupId, recurring.paidBy, expense, at.toISOString());
  await db.execute('UPDATE recurring SET next_on = ? WHERE id = ? AND next_on = ?', [
    monthAfter(recurring.next),
    id,
    recurring.next,
  ]);
  return true;
}
