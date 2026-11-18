import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { inTransaction } from './database';
import { isRealDay, todayUtc } from './days';
import {
  checkAmount,
  checkDescription,
  checkSplit,
  membersOf,
  recordExpense,
  sharesOf,
  type ExactShare,
  type ShareCount,
  type Split,
} from './expenses';
import { CATEGORIES, DEFAULT_CATEGORY, type Category } from './categories';
import { findGroupOf, refuseIfArchived } from './groups';
import { isMember } from './members';
import { Refusal } from './refusal';
import { requireCaller } from './sessions';

const WINDOW_DAYS = 365;

/** A recurring expense as it is read: the split as it was given is one of the three `split` properties. */
export interface Recurring {
  id: string;
  groupId: string;
  paidBy: string;
  description: string;
  amount: number;
  startsOn: string;
  next: string;
  category: Category;
  splitBetween?: string[];
  splitExactly?: ExactShare[];
  splitByShares?: ShareCount[];
}

/** What a member sets up: the recurring expense's description, amount, first day, category and split. */
export interface NewRecurring {
  description: string;
  amount: number;
  startsOn: string;
  /** The category of its expenses; `other` when left out. */
  category?: Category;
  splitBetween?: string[];
  splitExactly?: ExactShare[];
  splitByShares?: ShareCount[];
}

interface RecurringRow {
  id: string;
  group_id: string;
  paid_by: string;
  description: string;
  amount: number;
  starts_on: string;
  next_on: string;
  split_kind: 'equal' | 'exact' | 'shares';
  category: string;
}

interface RecurringShareRow {
  account_id: string;
  value: number | null;
}

function dayNumber(day: string): number {
  const [year, month, date] = day.split('-').map(Number);
  return Math.round(Date.UTC(year, month - 1, date) / 86_400_000);
}

function checkStartsOn(startsOn: string): void {
  const invalid = (message: string) => new Refusal(422, 'InvalidStartsOn', message);
  if (!isRealDay(startsOn)) throw invalid('startsOn must be a day of the calendar, as YYYY-MM-DD.');
  const dayOfMonth = Number(startsOn.slice(8));
  if (dayOfMonth < 1 || dayOfMonth > 28) throw invalid('The day of the month of startsOn must be from 1 to 28.');
  if (Math.abs(dayNumber(startsOn) - dayNumber(todayUtc())) > WINDOW_DAYS) {
    throw invalid(`startsOn must be within ${WINDOW_DAYS} days of today.`);
  }
}

/** The day one month after `day`, whose day of the month is 1 to 28. */
function nextMonth(day: string): string {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const [y, m] = month === 12 ? [year + 1, 1] : [year, month + 1];
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${day.slice(8)}`;
}

function splitGiven(input: NewRecurring): Split {
  const given: Split[] = [];
  if (input.splitBetween !== undefined) given.push({ kind: 'equal', members: input.splitBetween });
  if (input.splitExactly !== undefined) given.push({ kind: 'exact', shares: input.splitExactly });
  if (input.splitByShares !== undefined) given.push({ kind: 'shares', shares: input.splitByShares });
  if (given.length !== 1) {
    throw new Refusal(
      400,
      'InvalidRequest',
      'The recurring expense needs exactly one split: splitBetween, splitExactly or splitByShares.',
    );
  }
  return given[0];
}

function splitOfRows(row: RecurringRow, shares: RecurringShareRow[]): Split {
  switch (row.split_kind) {
    case 'equal':
      return { kind: 'equal', members: shares.map(share => share.account_id) };
    case 'exact':
      return { kind: 'exact', shares: shares.map(share => ({ memberId: share.account_id, amount: share.value ?? 0 })) };
    case 'shares':
      return {
        kind: 'shares',
        shares: shares.map(share => ({ memberId: share.account_id, shares: share.value ?? 0 })),
      };
  }
}

function sharesOfRecurring(db: DatabaseSync, id: string): RecurringShareRow[] {
  return db
    .prepare('SELECT account_id, value FROM recurring_shares WHERE recurring_id = ? ORDER BY position')
    .all(id) as unknown as RecurringShareRow[];
}

function recurringOf(db: DatabaseSync, row: RecurringRow): Recurring {
  const split = splitOfRows(row, sharesOfRecurring(db, row.id));
  const recurring: Recurring = {
    id: row.id,
    groupId: row.group_id,
    paidBy: row.paid_by,
    description: row.description,
    amount: row.amount,
    startsOn: row.starts_on,
    next: row.next_on,
    category: row.category as Category,
  };
  if (split.kind === 'equal') recurring.splitBetween = split.members;
  else if (split.kind === 'exact') recurring.splitExactly = split.shares;
  else recurring.splitByShares = split.shares;
  return recurring;
}

const COLUMNS =
  'r.id, r.group_id, r.paid_by, r.description, r.amount, r.starts_on, r.next_on, r.split_kind, r.category';

/**
 * Sets up a recurring expense of the group, the account its payer, and returns its id. It is checked as an expense is:
 * its description, its amount, its split; and its first day. For an account that is not a member, the group does not exist.
 */
export function createRecurring(db: DatabaseSync, accountId: string, groupId: string, input: NewRecurring): string {
  if (!findGroupOf(db, accountId, groupId)) throw new Refusal(404, 'NotFound', 'There is no such group.');
  refuseIfArchived(db, groupId);
  const description = checkDescription(input.description);
  checkAmount(input.amount);
  checkStartsOn(input.startsOn);
  const id = randomUUID();
  inTransaction(db, () => {
    refuseIfArchived(db, groupId);
    const split = splitGiven(input);
    checkSplit(db, groupId, accountId, membersOf(split));
    sharesOf(split, input.amount);
    db.prepare(
      `INSERT INTO recurring (id, group_id, paid_by, description, amount, starts_on, next_on, split_kind, category, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      groupId,
      accountId,
      description,
      input.amount,
      input.startsOn,
      input.startsOn,
      split.kind,
      input.category ?? DEFAULT_CATEGORY,
      new Date().toISOString(),
    );
    const insert = db.prepare(
      'INSERT INTO recurring_shares (recurring_id, position, account_id, value) VALUES (?, ?, ?, ?)',
    );
    if (split.kind === 'equal') split.members.forEach((member, position) => insert.run(id, position, member, null));
    else if (split.kind === 'exact') {
      split.shares.forEach((share, position) => insert.run(id, position, share.memberId, share.amount));
    } else split.shares.forEach((share, position) => insert.run(id, position, share.memberId, share.shares));
  });
  return id;
}

/** The recurring expense, when the account is a member of its group. For anyone else it does not exist. */
export function findRecurringOf(db: DatabaseSync, accountId: string, id: string): Recurring | undefined {
  const row = db
    .prepare(
      `SELECT ${COLUMNS} FROM recurring r JOIN group_members m ON m.group_id = r.group_id
       WHERE r.id = ? AND m.account_id = ? AND m.left_at IS NULL`,
    )
    .get(id, accountId) as RecurringRow | undefined;
  return row && recurringOf(db, row);
}

/** The group's recurring expenses, the earliest set up first. For an account that is not a member, the group does not exist. */
export function listRecurringOf(db: DatabaseSync, accountId: string, groupId: string): Recurring[] {
  if (!findGroupOf(db, accountId, groupId)) throw new Refusal(404, 'NotFound', 'There is no such group.');
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM recurring r WHERE r.group_id = ? ORDER BY r.seq`)
    .all(groupId) as unknown as RecurringRow[];
  return rows.map(row => recurringOf(db, row));
}

function removeRecurring(db: DatabaseSync, id: string): void {
  db.prepare('DELETE FROM recurring_shares WHERE recurring_id = ?').run(id);
  db.prepare('DELETE FROM recurring WHERE id = ?').run(id);
}

/** Stops the recurring expense: only its payer and the owner of its group may. The expenses it recorded stay. */
export function stopRecurring(db: DatabaseSync, accountId: string, id: string): void {
  inTransaction(db, () => {
    const recurring = findRecurringOf(db, accountId, id);
    if (!recurring) throw new Refusal(404, 'NotFound', 'There is no such recurring expense.');
    refuseIfArchived(db, recurring.groupId);
    const isOwner = findGroupOf(db, accountId, recurring.groupId)?.ownerId === accountId;
    if (accountId !== recurring.paidBy && !isOwner) {
      throw new Refusal(
        403,
        'NotAllowed',
        'Only the payer of the recurring expense or the owner of the group may stop it.',
      );
    }
    removeRecurring(db, id);
  });
}

/**
 * One run of the recurring expenses, as the background job makes it. For each, in one write transaction (so servers
 * sharing the database never record a day twice): every day from its next one to today that has come is recorded as an
 * expense dated that day, and the next day moves on. When its payer or a member of its split is no longer a member of
 * the group, nothing more is recorded and the recurring expense is removed.
 */
export function runRecurring(db: DatabaseSync, now: Date = new Date()): void {
  const today = now.toISOString().slice(0, 10);
  const at = now.toISOString();
  // An archived group records nothing: its recurring expenses are left as they are, and so is their next day.
  const due = db
    .prepare(
      `SELECT r.id FROM recurring r JOIN groups g ON g.id = r.group_id
       WHERE r.next_on <= ? AND g.archived_at IS NULL ORDER BY r.seq`,
    )
    .all(today) as unknown as { id: string }[];
  for (const { id } of due) {
    inTransaction(db, () => {
      const row = db
        .prepare(
          `SELECT ${COLUMNS} FROM recurring r JOIN groups g ON g.id = r.group_id
           WHERE r.id = ? AND r.next_on <= ? AND g.archived_at IS NULL`,
        )
        .get(id, today) as RecurringRow | undefined;
      if (!row) return;
      const split = splitOfRows(row, sharesOfRecurring(db, id));
      const members = [row.paid_by, ...membersOf(split)];
      if (!members.every(memberId => isMember(db, row.group_id, memberId))) {
        removeRecurring(db, id);
        return;
      }
      let day = row.next_on;
      while (day <= today) {
        recordExpense(db, {
          id: randomUUID(),
          groupId: row.group_id,
          description: row.description,
          amount: row.amount,
          date: day,
          paidBy: row.paid_by,
          splitKind: split.kind,
          category: row.category as Category,
          shares: sharesOf(split, row.amount),
          at,
        });
        day = nextMonth(day);
      }
      db.prepare('UPDATE recurring SET next_on = ? WHERE id = ?').run(day, id);
    });
  }
}

const idSchema = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } };
const DAY_PATTERN = '^\\d{4}-\\d{2}-(0[1-9]|1\\d|2[0-8])$';

const recurringSchema = {
  type: 'object',
  required: ['id', 'groupId', 'paidBy', 'description', 'amount', 'startsOn', 'next', 'category'],
  properties: {
    id: { type: 'string' },
    groupId: { type: 'string' },
    paidBy: { type: 'string' },
    description: { type: 'string' },
    amount: { type: 'integer' },
    startsOn: { type: 'string', pattern: DAY_PATTERN },
    next: { type: 'string', pattern: DAY_PATTERN },
    category: { enum: [...CATEGORIES] },
    splitBetween: { type: 'array', items: { type: 'string' } },
    splitExactly: {
      type: 'array',
      items: {
        type: 'object',
        required: ['memberId', 'amount'],
        properties: { memberId: { type: 'string' }, amount: { type: 'integer' } },
      },
    },
    splitByShares: {
      type: 'array',
      items: {
        type: 'object',
        required: ['memberId', 'shares'],
        properties: { memberId: { type: 'string' }, shares: { type: 'integer' } },
      },
    },
  },
};

export function registerRecurringRoutes(app: FastifyInstance, db: DatabaseSync): void {
  app.post<{ Params: { id: string }; Body: NewRecurring }>(
    '/groups/:id/recurring',
    {
      schema: {
        body: {
          type: 'object',
          required: ['description', 'amount', 'startsOn'],
          properties: {
            description: { type: 'string' },
            amount: { type: 'integer' },
            startsOn: { type: 'string' },
            category: { type: 'string', enum: [...CATEGORIES] },
            splitBetween: recurringSchema.properties.splitBetween,
            splitExactly: recurringSchema.properties.splitExactly,
            splitByShares: recurringSchema.properties.splitByShares,
          },
          oneOf: [{ required: ['splitBetween'] }, { required: ['splitExactly'] }, { required: ['splitByShares'] }],
        },
        response: { 201: idSchema },
      },
    },
    (request, reply) => {
      const accountId = requireCaller(db, request);
      return reply.code(201).send({ id: createRecurring(db, accountId, request.params.id, request.body) });
    },
  );

  app.get<{ Params: { id: string } }>('/recurring/:id', { schema: { response: { 200: recurringSchema } } }, request => {
    const accountId = requireCaller(db, request);
    const recurring = findRecurringOf(db, accountId, request.params.id);
    if (!recurring) throw new Refusal(404, 'NotFound', 'There is no such recurring expense.');
    return recurring;
  });

  app.get<{ Params: { id: string } }>(
    '/groups/:id/recurring',
    { schema: { response: { 200: { type: 'array', items: recurringSchema } } } },
    request => listRecurringOf(db, requireCaller(db, request), request.params.id),
  );

  app.delete<{ Params: { id: string } }>('/recurring/:id', (request, reply) => {
    stopRecurring(db, requireCaller(db, request), request.params.id);
    return reply.code(204).send();
  });
}
