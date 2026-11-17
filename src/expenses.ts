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

/** How an expense is split: equally between its members, by exact amounts, or by a number of shares each. */
export type SplitKind = 'equal' | 'exact' | 'shares';

export interface Share {
  memberId: string;
  amount: number;
}

/** A member of a split by exact amounts, with the amount of their share. */
export interface ExactShare {
  memberId: string;
  amount: number;
}

/** A member of a split by shares, with their whole number of shares. */
export interface ShareCount {
  memberId: string;
  shares: number;
}

export interface Expense {
  id: string;
  groupId: string;
  description: string;
  amount: number;
  date: string;
  paidBy: string;
  shares: Share[];
  splitKind: SplitKind;
  /** 1 when the expense is recorded, one more at each edit. */
  version: number;
}

/**
 * What a member records: the amount is in hundredths of the group's currency, like every amount. The split
 * is given exactly one way: `splitBetween` for an equal split, `splitExactly` for amounts, `splitByShares`
 * for shares.
 */
export interface NewExpense {
  description: string;
  amount: number;
  date: string;
  splitBetween?: string[];
  splitExactly?: ExactShare[];
  splitByShares?: ShareCount[];
}

/** An edit gives the expense again, whole, from the version its author read. */
export interface ExpenseEdit extends NewExpense {
  version: number;
}

interface ExpenseRow {
  id: string;
  group_id: string;
  description: string;
  amount: number;
  date: string;
  paid_by: string;
  split_kind: SplitKind;
  version: number;
}

interface ShareRow {
  account_id: string;
  amount: number;
}

/** A split as it was given: its kind, and its members in the order given, with what each one weighs. */
type Split =
  | { kind: 'equal'; members: string[] }
  | { kind: 'exact'; shares: ExactShare[] }
  | { kind: 'shares'; shares: ShareCount[] };

/**
 * The shares of an equal split, in the order the split was given. Each share is the amount divided by
 * the number of members, rounded down; the remainder, less than that number, goes to the payer's share.
 */
export function equalShares(amount: number, splitBetween: readonly string[], payerId: string): Share[] {
  const each = Math.floor(amount / splitBetween.length);
  const remainder = amount - each * splitBetween.length;
  return splitBetween.map(memberId => ({ memberId, amount: memberId === payerId ? each + remainder : each }));
}

/**
 * The shares of a split by shares, in the order the split was given. Each member's share is the amount
 * times their shares, divided by the total of the shares, rounded down. The remainder, less than the
 * number of members, goes whole to the payer's share, so the shares add up to the amount exactly. The
 * arithmetic is on arbitrary-size integers, so no number of shares can overflow it.
 */
export function sharesByWeight(amount: number, weights: readonly ShareCount[], payerId: string): Share[] {
  const total = weights.reduce((sum, weight) => sum + BigInt(weight.shares), 0n);
  const shares = weights.map(weight => ({
    memberId: weight.memberId,
    amount: Number((BigInt(amount) * BigInt(weight.shares)) / total),
  }));
  const remainder = amount - shares.reduce((sum, share) => sum + share.amount, 0);
  return shares.map(share => (share.memberId === payerId ? { ...share, amount: share.amount + remainder } : share));
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
 * The split the input gives. Exactly one of its three ways must be given; the request's schema refuses
 * the others as the wrong shape, and this holds the same rule for whatever else reaches it.
 */
function splitOf(input: NewExpense): Split {
  const given: Split[] = [];
  if (input.splitBetween !== undefined) given.push({ kind: 'equal', members: input.splitBetween });
  if (input.splitExactly !== undefined) given.push({ kind: 'exact', shares: input.splitExactly });
  if (input.splitByShares !== undefined) given.push({ kind: 'shares', shares: input.splitByShares });
  if (given.length !== 1) {
    throw new Refusal(
      400,
      'InvalidRequest',
      'The expense needs exactly one split: splitBetween, splitExactly or splitByShares.',
    );
  }
  return given[0];
}

/** The members of a split, in the order it was given. */
function membersOf(split: Split): string[] {
  return split.kind === 'equal' ? split.members : split.shares.map(share => share.memberId);
}

/**
 * The shares of the split of an amount. An exact split's amounts are 0 or more and add up to the amount,
 * exactly; a split by shares gives each member at least one share. Otherwise the split is refused.
 */
function sharesOf(split: Split, amount: number, payerId: string): Share[] {
  switch (split.kind) {
    case 'equal':
      return equalShares(amount, split.members, payerId);
    case 'exact': {
      if (split.shares.some(share => share.amount < 0)) {
        refuse('InvalidSplit', 'Each amount of the split is 0 or more.');
      }
      if (split.shares.reduce((sum, share) => sum + share.amount, 0) !== amount) {
        refuse('InvalidSplit', 'The amounts of the split must add up to the amount of the expense, exactly.');
      }
      return split.shares.map(share => ({ memberId: share.memberId, amount: share.amount }));
    }
    case 'shares':
      if (split.shares.some(share => share.shares < 1)) {
        refuse('InvalidSplit', 'Each member of the split has at least 1 share.');
      }
      return sharesByWeight(amount, split.shares, payerId);
  }
}

/**
 * The split holds each member once, names the payer among them, and names only members of the group.
 * It is checked where it is written, inside the write transaction that records or edits the expense.
 */
function checkSplit(db: DatabaseSync, groupId: string, payerId: string, members: readonly string[]): void {
  if (new Set(members).size !== members.length) {
    refuse('InvalidSplit', 'Each member can be in the split only once.');
  }
  if (!members.includes(payerId)) {
    refuse('InvalidSplit', 'The payer must be one of the members the expense is split between.');
  }
  if (!members.every(memberId => isMember(db, groupId, memberId))) {
    refuse('InvalidSplit', 'Every member in the split must be a member of the group.');
  }
}

/** Writes the shares of the split, in the order the split was given. */
function writeShares(db: DatabaseSync, expenseId: string, shares: readonly Share[]): void {
  const insertShare = db.prepare(
    'INSERT INTO expense_shares (expense_id, position, account_id, amount) VALUES (?, ?, ?, ?)',
  );
  shares.forEach((share, position) => {
    insertShare.run(expenseId, position, share.memberId, share.amount);
  });
}

/**
 * Records an expense of the group, paid by the account, split as the input gives it, and returns its id.
 * The account must be a member of the group; for anyone else the group does not exist.
 */
export function createExpense(db: DatabaseSync, accountId: string, groupId: string, input: NewExpense): string {
  if (!findGroupOf(db, accountId, groupId)) throw new Refusal(404, 'NotFound', 'There is no such group.');
  const description = checkDescription(input.description);
  checkAmount(input.amount);
  checkDate(input.date);
  const id = randomUUID();
  // The split is checked and the expense and its shares are written together, or not at all.
  inTransaction(db, () => {
    const split = splitOf(input);
    checkSplit(db, groupId, accountId, membersOf(split));
    const shares = sharesOf(split, input.amount, accountId);
    db.prepare(
      'INSERT INTO expenses (id, group_id, description, amount, date, paid_by, split_kind, version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)',
    ).run(id, groupId, description, input.amount, input.date, accountId, split.kind, new Date().toISOString());
    writeShares(db, id, shares);
  });
  return id;
}

/** The expense, when the account is a member of its group. For anyone else it does not exist. */
export function findExpenseOf(db: DatabaseSync, accountId: string, expenseId: string): Expense | undefined {
  const row = db
    .prepare(
      `SELECT e.id, e.group_id, e.description, e.amount, e.date, e.paid_by, e.split_kind, e.version
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
    splitKind: row.split_kind,
    version: row.version,
  };
}

/**
 * Only the payer of an expense and the owner of its group may change it. For any other member of the
 * group the change is refused; the caller is known to be a member, as the expense was found for them.
 */
function checkMayChange(db: DatabaseSync, accountId: string, expense: Expense): void {
  if (accountId === expense.paidBy) return;
  if (accountId === findGroupOf(db, accountId, expense.groupId)?.ownerId) return;
  throw new Refusal(403, 'NotAllowed', 'Only the payer of the expense or the owner of the group may change it.');
}

/**
 * Replaces the expense whole with the one given, from the version its author read, and gives it one more
 * version. The payer stays the one who paid, and must stay in the split. The shares are computed again.
 * An expense changed since that version is refused with `ExpenseChanged`, and nothing of the edit is kept.
 * Check, version and write are one write transaction, so two edits from the same version cannot both land.
 */
export function editExpense(db: DatabaseSync, accountId: string, expenseId: string, edit: ExpenseEdit): void {
  inTransaction(db, () => {
    const expense = findExpenseOf(db, accountId, expenseId);
    if (!expense) throw new Refusal(404, 'NotFound', 'There is no such expense.');
    checkMayChange(db, accountId, expense);
    if (edit.version !== expense.version) {
      throw new Refusal(409, 'ExpenseChanged', 'The expense changed since this version was read: read it again.');
    }
    const description = checkDescription(edit.description);
    checkAmount(edit.amount);
    checkDate(edit.date);
    const split = splitOf(edit);
    checkSplit(db, expense.groupId, expense.paidBy, membersOf(split));
    const shares = sharesOf(split, edit.amount, expense.paidBy);
    db.prepare(
      'UPDATE expenses SET description = ?, amount = ?, date = ?, split_kind = ?, version = version + 1 WHERE id = ? AND version = ?',
    ).run(description, edit.amount, edit.date, split.kind, expenseId, edit.version);
    db.prepare('DELETE FROM expense_shares WHERE expense_id = ?').run(expenseId);
    writeShares(db, expenseId, shares);
  });
}

/**
 * Deletes the expense with its shares: it is no longer read, and counts in no balance. Only its payer and
 * the owner of its group may delete it, as for an edit.
 */
export function deleteExpense(db: DatabaseSync, accountId: string, expenseId: string): void {
  inTransaction(db, () => {
    const expense = findExpenseOf(db, accountId, expenseId);
    if (!expense) throw new Refusal(404, 'NotFound', 'There is no such expense.');
    checkMayChange(db, accountId, expense);
    db.prepare('DELETE FROM expense_shares WHERE expense_id = ?').run(expenseId);
    db.prepare('DELETE FROM expenses WHERE id = ?').run(expenseId);
  });
}

const idSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string' } },
};

/** An expense as it is read, by its id or in a group's list. */
export const expenseSchema = {
  type: 'object',
  required: ['id', 'groupId', 'description', 'amount', 'date', 'paidBy', 'shares', 'splitKind', 'version'],
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
    splitKind: { enum: ['equal', 'exact', 'shares'] },
    version: { type: 'integer', minimum: 1 },
  },
};

/** The three ways of giving a split, each optional here: the body must give exactly one of them. */
const splitProperties = {
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
};

/** A body with none of the three splits, or with more than one, is of the wrong shape. */
const exactlyOneSplit = {
  oneOf: [{ required: ['splitBetween'] }, { required: ['splitExactly'] }, { required: ['splitByShares'] }],
};

export function registerExpenseRoutes(app: FastifyInstance, db: DatabaseSync): void {
  app.post<{ Params: { id: string }; Body: NewExpense }>(
    '/groups/:id/expenses',
    {
      schema: {
        body: {
          type: 'object',
          required: ['description', 'amount', 'date'],
          properties: {
            description: { type: 'string' },
            amount: { type: 'integer' },
            date: { type: 'string' },
            ...splitProperties,
          },
          ...exactlyOneSplit,
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

  app.put<{ Params: { id: string }; Body: ExpenseEdit }>(
    '/expenses/:id',
    {
      schema: {
        body: {
          type: 'object',
          required: ['description', 'amount', 'date', 'version'],
          properties: {
            description: { type: 'string' },
            amount: { type: 'integer' },
            date: { type: 'string' },
            version: { type: 'integer', minimum: 1 },
            ...splitProperties,
          },
          ...exactlyOneSplit,
        },
      },
    },
    (request, reply) => {
      const accountId = requireCaller(db, request);
      editExpense(db, accountId, request.params.id, request.body);
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { id: string } }>('/expenses/:id', (request, reply) => {
    const accountId = requireCaller(db, request);
    deleteExpense(db, accountId, request.params.id);
    return reply.code(204).send();
  });
}
