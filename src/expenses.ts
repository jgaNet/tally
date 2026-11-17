import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { inTransaction } from './database';
import { findGroupOf } from './groups';
import { isMember } from './members';
import { Refusal } from './refusal';
import { requireCaller } from './sessions';

const DESCRIPTION_MAX = 100;
const AMOUNT_MAX = 100_000_000;
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

export interface Share {
  memberId: string;
  amount: number;
}

export interface Expense {
  id: string;
  groupId: string;
  description: string;
  amount: number;
  date: string;
  paidBy: string;
  shares: Share[];
}

/** What a member records: the amount is in hundredths of the group's currency, like every amount. */
export interface NewExpense {
  description: string;
  amount: number;
  date: string;
  splitBetween: string[];
}

interface ExpenseRow {
  id: string;
  group_id: string;
  description: string;
  amount: number;
  date: string;
  paid_by: string;
}

interface ShareRow {
  account_id: string;
  amount: number;
}

/**
 * The shares of an equal split, in the order the split was given. Each share is the amount divided by
 * the number of members, rounded down; the remainder, less than that number, goes to the payer's share.
 */
export function equalShares(amount: number, splitBetween: readonly string[], payerId: string): Share[] {
  const each = Math.floor(amount / splitBetween.length);
  const remainder = amount - each * splitBetween.length;
  return splitBetween.map(memberId => ({ memberId, amount: memberId === payerId ? each + remainder : each }));
}

function refuse(type: string, message: string): never {
  throw new Refusal(422, type, message);
}

/** The description, trimmed: 1 to 100 characters, counted as characters and not as code units. */
function checkDescription(description: string): string {
  const trimmed = description.trim();
  const length = Array.from(trimmed).length;
  if (length < 1 || length > DESCRIPTION_MAX) {
    refuse('InvalidDescription', `The description needs 1 to ${DESCRIPTION_MAX} characters, not only spaces.`);
  }
  return trimmed;
}

function checkAmount(amount: number): void {
  if (amount < 1 || amount > AMOUNT_MAX) {
    refuse('InvalidAmount', `The amount must be from 1 to ${AMOUNT_MAX}, in hundredths of the currency.`);
  }
}

/** Whether `date` names a day of the calendar, as `YYYY-MM-DD`. */
function isRealDay(date: string): boolean {
  if (!DATE_SHAPE.test(date)) return false;
  const [year, month, day] = date.split('-').map(Number);
  const instant = new Date(0);
  instant.setUTCFullYear(year, month - 1, day);
  return instant.getUTCFullYear() === year && instant.getUTCMonth() === month - 1 && instant.getUTCDate() === day;
}

/** Today's day in UTC, as `YYYY-MM-DD`. */
export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function checkDate(date: string): void {
  if (!isRealDay(date)) refuse('InvalidDate', 'The date must be a day of the calendar, as YYYY-MM-DD.');
  // `YYYY-MM-DD` days order the same way as text, so the comparison is on the strings.
  if (date > todayUtc()) refuse('FutureDate', 'The expense cannot be dated after today, in UTC.');
}

/**
 * The split holds each member once, names the payer among them, and names only members of the group.
 * It is checked where it is written, inside the write transaction that records the expense.
 */
function checkSplit(db: DatabaseSync, groupId: string, payerId: string, splitBetween: readonly string[]): void {
  if (new Set(splitBetween).size !== splitBetween.length) {
    refuse('InvalidSplit', 'Each member can be in the split only once.');
  }
  if (!splitBetween.includes(payerId)) {
    refuse('InvalidSplit', 'The payer must be one of the members the expense is split between.');
  }
  if (!splitBetween.every(memberId => isMember(db, groupId, memberId))) {
    refuse('InvalidSplit', 'Every member in the split must be a member of the group.');
  }
}

/**
 * Records an expense of the group, paid by the account, split equally between the members it names, and
 * returns its id. The account must be a member of the group; for anyone else the group does not exist.
 */
export function createExpense(db: DatabaseSync, accountId: string, groupId: string, input: NewExpense): string {
  if (!findGroupOf(db, accountId, groupId)) throw new Refusal(404, 'NotFound', 'There is no such group.');
  const description = checkDescription(input.description);
  checkAmount(input.amount);
  checkDate(input.date);
  const id = randomUUID();
  // The split is checked and the expense and its shares are written together, or not at all.
  inTransaction(db, () => {
    checkSplit(db, groupId, accountId, input.splitBetween);
    db.prepare(
      'INSERT INTO expenses (id, group_id, description, amount, date, paid_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, groupId, description, input.amount, input.date, accountId, new Date().toISOString());
    const insertShare = db.prepare(
      'INSERT INTO expense_shares (expense_id, position, account_id, amount) VALUES (?, ?, ?, ?)',
    );
    equalShares(input.amount, input.splitBetween, accountId).forEach((share, position) => {
      insertShare.run(id, position, share.memberId, share.amount);
    });
  });
  return id;
}

/** The expense, when the account is a member of its group. For anyone else it does not exist. */
export function findExpenseOf(db: DatabaseSync, accountId: string, expenseId: string): Expense | undefined {
  const row = db
    .prepare(
      `SELECT e.id, e.group_id, e.description, e.amount, e.date, e.paid_by
       FROM expenses e JOIN group_members m ON m.group_id = e.group_id
       WHERE e.id = ? AND m.account_id = ?`,
    )
    .get(expenseId, accountId) as ExpenseRow | undefined;
  if (!row) return undefined;
  const shares = db
    .prepare('SELECT account_id, amount FROM expense_shares WHERE expense_id = ? ORDER BY position')
    .all(expenseId) as unknown as ShareRow[];
  return {
    id: row.id,
    groupId: row.group_id,
    description: row.description,
    amount: row.amount,
    date: row.date,
    paidBy: row.paid_by,
    shares: shares.map(share => ({ memberId: share.account_id, amount: share.amount })),
  };
}

const idSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string' } },
};

const expenseSchema = {
  type: 'object',
  required: ['id', 'groupId', 'description', 'amount', 'date', 'paidBy', 'shares'],
  properties: {
    id: { type: 'string' },
    groupId: { type: 'string' },
    description: { type: 'string' },
    amount: { type: 'integer' },
    date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    paidBy: { type: 'string' },
    shares: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['memberId', 'amount'],
        properties: { memberId: { type: 'string' }, amount: { type: 'integer' } },
      },
    },
  },
};

export function registerExpenseRoutes(app: FastifyInstance, db: DatabaseSync): void {
  app.post<{ Params: { id: string }; Body: NewExpense }>(
    '/groups/:id/expenses',
    {
      schema: {
        body: {
          type: 'object',
          required: ['description', 'amount', 'date', 'splitBetween'],
          properties: {
            description: { type: 'string' },
            amount: { type: 'integer' },
            date: { type: 'string' },
            splitBetween: { type: 'array', items: { type: 'string' } },
          },
        },
        response: { 201: idSchema },
      },
    },
    (request, reply) => {
      const accountId = requireCaller(db, request);
      return reply.code(201).send({ id: createExpense(db, accountId, request.params.id, request.body) });
    },
  );

  app.get<{ Params: { id: string } }>('/expenses/:id', { schema: { response: { 200: expenseSchema } } }, request => {
    const accountId = requireCaller(db, request);
    const expense = findExpenseOf(db, accountId, request.params.id);
    if (!expense) throw new Refusal(404, 'NotFound', 'There is no such expense.');
    return expense;
  });
}
