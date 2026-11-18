import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Database, Queryable } from './database';
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
import { isDeleted } from './accounts';
import { Refusal } from './refusal';
import { requireCaller } from './sessions';
import { isSuspended, refuseIfSuspended } from './suspensions';

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

function sharesOfRecurring(db: Queryable, id: string): Promise<RecurringShareRow[]> {
  return db.all<RecurringShareRow>(
    'SELECT account_id, value FROM recurring_shares WHERE recurring_id = ? ORDER BY position',
    [id],
  );
}

async function recurringOf(db: Queryable, row: RecurringRow): Promise<Recurring> {
  const split = splitOfRows(row, await sharesOfRecurring(db, row.id));
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
export async function createRecurring(
  db: Database,
  accountId: string,
  groupId: string,
  input: NewRecurring,
): Promise<string> {
  if (!(await findGroupOf(db, accountId, groupId))) throw new Refusal(404, 'NotFound', 'There is no such group.');
  await refuseIfSuspended(db, accountId);
  await refuseIfArchived(db, groupId);
  const description = checkDescription(input.description);
  checkAmount(input.amount);
  checkStartsOn(input.startsOn);
  const id = randomUUID();
  await db.transaction(async tx => {
    await refuseIfSuspended(tx, accountId);
    await refuseIfArchived(tx, groupId);
    const split = splitGiven(input);
    await checkSplit(tx, groupId, accountId, membersOf(split));
    sharesOf(split, input.amount);
    await tx.run(
      `INSERT INTO recurring (id, group_id, paid_by, description, amount, starts_on, next_on, split_kind, category, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
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
      ],
    );
    const insert = (position: number, memberId: string, value: number | null) =>
      tx.run('INSERT INTO recurring_shares (recurring_id, position, account_id, value) VALUES (?, ?, ?, ?)', [
        id,
        position,
        memberId,
        value,
      ]);
    if (split.kind === 'equal') {
      for (const [position, member] of split.members.entries()) await insert(position, member, null);
    } else if (split.kind === 'exact') {
      for (const [position, share] of split.shares.entries()) await insert(position, share.memberId, share.amount);
    } else {
      for (const [position, share] of split.shares.entries()) await insert(position, share.memberId, share.shares);
    }
  });
  return id;
}

/** The recurring expense, when the account is a member of its group. For anyone else it does not exist. */
export async function findRecurringOf(db: Queryable, accountId: string, id: string): Promise<Recurring | undefined> {
  const row = await db.get<RecurringRow>(
    `SELECT ${COLUMNS} FROM recurring r JOIN group_members m ON m.group_id = r.group_id
     WHERE r.id = ? AND m.account_id = ? AND m.left_at IS NULL`,
    [id, accountId],
  );
  return row && recurringOf(db, row);
}

/** The group's recurring expenses, the earliest set up first. For an account that is not a member, the group does not exist. */
export async function listRecurringOf(db: Queryable, accountId: string, groupId: string): Promise<Recurring[]> {
  if (!(await findGroupOf(db, accountId, groupId))) throw new Refusal(404, 'NotFound', 'There is no such group.');
  const rows = await db.all<RecurringRow>(`SELECT ${COLUMNS} FROM recurring r WHERE r.group_id = ? ORDER BY r.seq`, [
    groupId,
  ]);
  const recurring: Recurring[] = [];
  for (const row of rows) recurring.push(await recurringOf(db, row));
  return recurring;
}

async function removeRecurring(db: Queryable, id: string): Promise<void> {
  await db.run('DELETE FROM recurring_shares WHERE recurring_id = ?', [id]);
  await db.run('DELETE FROM recurring WHERE id = ?', [id]);
}

/** Stops the recurring expense: only its payer and the owner of its group may. The expenses it recorded stay. */
export async function stopRecurring(db: Database, accountId: string, id: string): Promise<void> {
  await db.transaction(async tx => {
    const recurring = await findRecurringOf(tx, accountId, id);
    if (!recurring) throw new Refusal(404, 'NotFound', 'There is no such recurring expense.');
    await refuseIfArchived(tx, recurring.groupId);
    const isOwner = (await findGroupOf(tx, accountId, recurring.groupId))?.ownerId === accountId;
    if (accountId !== recurring.paidBy && !isOwner) {
      throw new Refusal(
        403,
        'NotAllowed',
        'Only the payer of the recurring expense or the owner of the group may stop it.',
      );
    }
    await removeRecurring(tx, id);
  });
}

/**
 * One run of the recurring expenses, as the background job makes it. For each, in one write transaction (so servers
 * sharing the database never record a day twice): every day from its next one to today that has come is recorded as an
 * expense dated that day, and the next day moves on. When its payer or a member of its split is no longer a member of
 * the group, or a deleted account, nothing more is recorded and the recurring expense is removed.
 */
export async function runRecurring(db: Database, now: Date = new Date()): Promise<void> {
  const today = now.toISOString().slice(0, 10);
  const at = now.toISOString();
  // An archived group records nothing: its recurring expenses are left as they are, and so is their next day.
  const due = await db.all<{ id: string }>(
    `SELECT r.id FROM recurring r JOIN groups g ON g.id = r.group_id
     WHERE r.next_on <= ? AND g.archived_at IS NULL ORDER BY r.seq`,
    [today],
  );
  for (const { id } of due) {
    await db.transaction(async tx => {
      const row = await tx.get<RecurringRow>(
        `SELECT ${COLUMNS} FROM recurring r JOIN groups g ON g.id = r.group_id
         WHERE r.id = ? AND r.next_on <= ? AND g.archived_at IS NULL`,
        [id, today],
      );
      if (!row) return;
      const split = splitOfRows(row, await sharesOfRecurring(tx, id));
      const members = [row.paid_by, ...membersOf(split)];
      // A deleted account, as a former member, ends the recurring expense on its day: it is not one that waits.
      for (const memberId of members) {
        if (await isDeleted(tx, memberId)) {
          await removeRecurring(tx, id);
          return;
        }
      }
      // A payer suspended records nothing: its days wait, unchanged, until it is reinstated.
      if (await isSuspended(tx, row.paid_by)) return;
      for (const memberId of members) {
        if (!(await isMember(tx, row.group_id, memberId))) {
          await removeRecurring(tx, id);
          return;
        }
      }
      let day = row.next_on;
      while (day <= today) {
        await recordExpense(tx, {
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
      await tx.run('UPDATE recurring SET next_on = ? WHERE id = ?', [day, id]);
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

export function registerRecurringRoutes(app: FastifyInstance, db: Database): void {
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
    async (request, reply) => {
      const accountId = await requireCaller(db, request);
      return reply.code(201).send({ id: await createRecurring(db, accountId, request.params.id, request.body) });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/recurring/:id',
    { schema: { response: { 200: recurringSchema } } },
    async request => {
      const accountId = await requireCaller(db, request);
      const recurring = await findRecurringOf(db, accountId, request.params.id);
      if (!recurring) throw new Refusal(404, 'NotFound', 'There is no such recurring expense.');
      return recurring;
    },
  );

  app.get<{ Params: { id: string } }>(
    '/groups/:id/recurring',
    { schema: { response: { 200: { type: 'array', items: recurringSchema } } } },
    async request => listRecurringOf(db, await requireCaller(db, request), request.params.id),
  );

  app.delete<{ Params: { id: string } }>('/recurring/:id', async (request, reply) => {
    await stopRecurring(db, await requireCaller(db, request), request.params.id);
    return reply.code(204).send();
  });
}
