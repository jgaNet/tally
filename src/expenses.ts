import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { inTransaction } from './database';
import { CURRENCIES, findGroupOf } from './groups';
import { isMember } from './members';
import { writeExpenseNotices } from './notices';
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
  /** What was paid in another currency than the group's, as it was given. Absent for an expense in the group's currency. */
  original?: Original;
}

/**
 * An amount paid in another currency than the group's: `amount` is in hundredths of `currency`, and `rate` is what one
 * of `currency` is worth in the group's currency, as the payer gave it: a decimal string.
 */
export interface Original {
  currency: string;
  amount: number;
  rate: string;
}

/**
 * What a member records: the amount is in hundredths of the group's currency, like every amount, or `original`, what was
 * paid in another currency. Exactly one of the two is given. The split is given exactly one way: `splitBetween` for an
 * equal split, `splitExactly` for amounts, `splitByShares` for shares.
 */
export interface NewExpense {
  description: string;
  amount?: number;
  original?: Original;
  date: string;
  splitBetween?: string[];
  splitExactly?: ExactShare[];
  splitByShares?: ShareCount[];
}

/** An edit gives the expense again, whole, from the version its author read. */
export interface ExpenseEdit extends NewExpense {
  version: number;
}

/** An expense as its row keeps it, with the columns of what was paid in another currency. */
export interface ExpenseRow {
  id: string;
  group_id: string;
  description: string;
  amount: number;
  date: string;
  paid_by: string;
  split_kind: SplitKind;
  version: number;
  original_currency: string | null;
  original_amount: number | null;
  original_rate: string | null;
}

/** The expense a row keeps, with the shares it is split into, in the order of their split. */
export function expenseOf(row: ExpenseRow, shares: Share[]): Expense {
  const expense: Expense = {
    id: row.id,
    groupId: row.group_id,
    description: row.description,
    amount: row.amount,
    date: row.date,
    paidBy: row.paid_by,
    shares,
    splitKind: row.split_kind,
    version: row.version,
  };
  if (row.original_currency !== null && row.original_amount !== null && row.original_rate !== null) {
    expense.original = { currency: row.original_currency, amount: row.original_amount, rate: row.original_rate };
  }
  return expense;
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
 * the number of members, rounded down; the remainder, less than that number, goes whole to the share of
 * the member listed first in the split, whoever paid.
 */
export function equalShares(amount: number, splitBetween: readonly string[]): Share[] {
  const each = Math.floor(amount / splitBetween.length);
  const remainder = amount - each * splitBetween.length;
  return splitBetween.map((memberId, index) => ({ memberId, amount: index === 0 ? each + remainder : each }));
}

/**
 * The shares of a split by shares, in the order the split was given. Each member's share is the amount
 * times their shares, divided by the total of the shares, rounded down. The remainder, less than the
 * number of members, goes whole to the share of the member listed first in the split, whoever paid, so
 * the shares add up to the amount exactly. The arithmetic is on arbitrary-size integers, so no number of
 * shares can overflow it.
 */
export function sharesByWeight(amount: number, weights: readonly ShareCount[]): Share[] {
  const total = weights.reduce((sum, weight) => sum + BigInt(weight.shares), 0n);
  const shares = weights.map(weight => ({
    memberId: weight.memberId,
    amount: Number((BigInt(amount) * BigInt(weight.shares)) / total),
  }));
  const remainder = amount - shares.reduce((sum, share) => sum + share.amount, 0);
  return shares.map((share, index) => (index === 0 ? { ...share, amount: share.amount + remainder } : share));
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

/** A rate, as a decimal string: whole digits, and at most 6 digits after the point. */
const RATE_SHAPE = /^(\d+)(?:\.(\d{1,6}))?$/;
/** A rate is kept as a whole number of millionths, so that the conversion is exact. */
const MILLIONTHS = 1_000_000n;

/** The rate as a whole number of millionths. A rate that is not a decimal greater than 0 is refused. */
function parseRate(rate: string): bigint {
  const match = RATE_SHAPE.exec(rate);
  const millionths = match ? BigInt(match[1] + (match[2] ?? '').padEnd(6, '0')) : 0n;
  if (millionths <= 0n) {
    refuse('InvalidRate', 'The rate must be a decimal number greater than 0, with at most 6 digits after the point.');
  }
  return millionths;
}

/**
 * The amount in the group's currency of an amount paid in another, at a rate in millionths: the product, rounded to the
 * nearest whole number, a half rounded up. Everything is in whole numbers, so the rounding is exact.
 */
function convertedAmount(original: number, millionths: bigint): bigint {
  const product = BigInt(original) * millionths;
  return (2n * product + MILLIONTHS) / (2n * MILLIONTHS);
}

/**
 * The amount of an expense in the group's currency, and the original it was paid in when it was paid in another
 * currency. The input gives exactly one of `amount` and `original`; the request's schema refuses the others as the
 * wrong shape, and this holds the same rule for whatever else reaches it.
 */
function amountOf(
  input: Pick<NewExpense, 'amount' | 'original'>,
  groupCurrency: string,
): { amount: number; original?: Original } {
  const { amount, original } = input;
  const wrongShape = () =>
    new Refusal(400, 'InvalidRequest', "The expense needs one amount: amount, in the group's currency, or original.");
  if (original === undefined) {
    if (amount === undefined) throw wrongShape();
    checkAmount(amount);
    return { amount };
  }
  if (amount !== undefined) throw wrongShape();
  if (!(CURRENCIES as readonly string[]).includes(original.currency) || original.currency === groupCurrency) {
    refuse(
      'InvalidCurrency',
      `The original currency must be one of ${CURRENCIES.join(', ')}, other than the group's currency, ${groupCurrency}.`,
    );
  }
  checkAmount(original.amount);
  const converted = convertedAmount(original.amount, parseRate(original.rate));
  if (converted < 1n || converted > BigInt(AMOUNT_MAX)) {
    refuse('InvalidAmount', `The amount in ${groupCurrency}, as converted, must be from 1 to ${AMOUNT_MAX}.`);
  }
  return {
    amount: Number(converted),
    original: { currency: original.currency, amount: original.amount, rate: original.rate },
  };
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
 * exactly; a split by shares gives each member at least one share. Otherwise the split is refused. The
 * split has been checked to name members, so the first member of an equal or weighted split exists.
 */
function sharesOf(split: Split, amount: number): Share[] {
  switch (split.kind) {
    case 'equal':
      return equalShares(amount, split.members);
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
      return sharesByWeight(amount, split.shares);
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
  const group = findGroupOf(db, accountId, groupId);
  if (!group) throw new Refusal(404, 'NotFound', 'There is no such group.');
  const description = checkDescription(input.description);
  const { amount, original } = amountOf(input, group.currency);
  checkDate(input.date);
  const id = randomUUID();
  const recordedAt = new Date().toISOString();
  // The split is checked and the expense, its shares and the notices of its members are written together, or not at all.
  inTransaction(db, () => {
    const split = splitOf(input);
    checkSplit(db, groupId, accountId, membersOf(split));
    const shares = sharesOf(split, amount);
    db.prepare(
      'INSERT INTO expenses (id, group_id, description, amount, date, paid_by, split_kind, version, created_at, original_currency, original_amount, original_rate) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)',
    ).run(
      id,
      groupId,
      description,
      amount,
      input.date,
      accountId,
      split.kind,
      recordedAt,
      original?.currency ?? null,
      original?.amount ?? null,
      original?.rate ?? null,
    );
    writeShares(db, id, shares);
    writeExpenseNotices(db, { id, groupId, paidBy: accountId, at: recordedAt }, shares);
  });
  return id;
}

/** The expense, when the account is a member of its group. For anyone else it does not exist. */
export function findExpenseOf(db: DatabaseSync, accountId: string, expenseId: string): Expense | undefined {
  const row = db
    .prepare(
      `SELECT e.id, e.group_id, e.description, e.amount, e.date, e.paid_by, e.split_kind, e.version,
         e.original_currency, e.original_amount, e.original_rate
       FROM expenses e JOIN group_members m ON m.group_id = e.group_id
       WHERE e.id = ? AND m.account_id = ? AND m.left_at IS NULL`,
    )
    .get(expenseId, accountId) as ExpenseRow | undefined;
  if (!row) return undefined;
  const shares = db
    .prepare('SELECT account_id, amount FROM expense_shares WHERE expense_id = ? ORDER BY position')
    .all(expenseId) as unknown as ShareRow[];
  return expenseOf(
    row,
    shares.map(share => ({ memberId: share.account_id, amount: share.amount })),
  );
}

/**
 * An expense that concerns a member who has left the group, as its payer or in its split, is frozen: it
 * can no longer be edited or deleted, so that the balance of the member who left stays 0.
 */
function checkNoFormerMember(db: DatabaseSync, expense: Expense): void {
  const concerned = [expense.paidBy, ...expense.shares.map(share => share.memberId)];
  if (concerned.some(memberId => !isMember(db, expense.groupId, memberId))) {
    throw new Refusal(
      409,
      'ExpenseOfFormerMember',
      'The expense concerns a member who has left the group, so it can no longer be changed.',
    );
  }
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
    checkNoFormerMember(db, expense);
    if (edit.version !== expense.version) {
      throw new Refusal(409, 'ExpenseChanged', 'The expense changed since this version was read: read it again.');
    }
    const group = findGroupOf(db, accountId, expense.groupId);
    if (!group) throw new Refusal(404, 'NotFound', 'There is no such group.');
    const description = checkDescription(edit.description);
    const { amount, original } = amountOf(edit, group.currency);
    checkDate(edit.date);
    const split = splitOf(edit);
    checkSplit(db, expense.groupId, expense.paidBy, membersOf(split));
    const shares = sharesOf(split, amount);
    db.prepare(
      'UPDATE expenses SET description = ?, amount = ?, date = ?, split_kind = ?, original_currency = ?, original_amount = ?, original_rate = ?, version = version + 1 WHERE id = ? AND version = ?',
    ).run(
      description,
      amount,
      edit.date,
      split.kind,
      original?.currency ?? null,
      original?.amount ?? null,
      original?.rate ?? null,
      expenseId,
      edit.version,
    );
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
    checkNoFormerMember(db, expense);
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
    original: {
      type: 'object',
      required: ['currency', 'amount', 'rate'],
      properties: {
        currency: { type: 'string', enum: [...CURRENCIES] },
        amount: { type: 'integer' },
        rate: { type: 'string' },
      },
    },
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

/** The amount of an expense: in the group's currency, or `original`, what was paid in another. Exactly one of them. */
const amountProperties = {
  amount: { type: 'integer' },
  original: {
    type: 'object',
    required: ['currency', 'amount', 'rate'],
    properties: { currency: { type: 'string' }, amount: { type: 'integer' }, rate: { type: 'string' } },
  },
};

const exactlyOneAmount = {
  oneOf: [{ required: ['amount'] }, { required: ['original'] }],
};

export function registerExpenseRoutes(app: FastifyInstance, db: DatabaseSync): void {
  app.post<{ Params: { id: string }; Body: NewExpense }>(
    '/groups/:id/expenses',
    {
      schema: {
        body: {
          type: 'object',
          required: ['description', 'date'],
          properties: {
            description: { type: 'string' },
            ...amountProperties,
            date: { type: 'string' },
            ...splitProperties,
          },
          allOf: [exactlyOneSplit, exactlyOneAmount],
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
          required: ['description', 'date', 'version'],
          properties: {
            description: { type: 'string' },
            ...amountProperties,
            date: { type: 'string' },
            version: { type: 'integer', minimum: 1 },
            ...splitProperties,
          },
          allOf: [exactlyOneSplit, exactlyOneAmount],
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
