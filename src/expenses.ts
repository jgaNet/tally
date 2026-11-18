import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { writeAudit } from './audit';
import { writeBudgetPassing } from './budgets';
import { CATEGORIES, DEFAULT_CATEGORY, type Category } from './categories';
import { inTransaction } from './database';
import { isRealDay, todayUtc } from './days';
import { CURRENCIES, findGroupOf, refuseIfArchived } from './groups';
import { isMember } from './members';
import { writeExpenseNotices } from './notices';
import { Refusal } from './refusal';
import { MILLIONTHS, offeredRate, rateMillionths, type RatesConfig } from './rates';
import { requireCaller } from './sessions';
import { templateSplitOf } from './templates';

const DESCRIPTION_MAX = 100;
const AMOUNT_MAX = 100_000_000;

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
  category: Category;
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
 * An amount paid in another currency as a member gives it: as `Original`, except that the rate may be left out, which takes
 * the rate offered for its currency to the group's on the day of the expense.
 */
export interface GivenOriginal {
  currency: string;
  amount: number;
  rate?: string;
}

/**
 * What a member records: the amount is in hundredths of the group's currency, like every amount, or `original`, what was
 * paid in another currency. Exactly one of the two is given. The split is given exactly one way: `splitBetween` for an
 * equal split, `splitExactly` for amounts, `splitByShares` for shares.
 */
export interface NewExpense {
  description: string;
  amount?: number;
  original?: GivenOriginal;
  date: string;
  /** The expense's category; `other` when left out. */
  category?: Category;
  splitBetween?: string[];
  splitExactly?: ExactShare[];
  splitByShares?: ShareCount[];
  /** The id of a template of the group, whose split the expense is split by in place of a split given here. */
  template?: string;
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
  category: string;
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
    category: row.category as Category,
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
export type Split =
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

export function refuse(type: string, message: string): never {
  throw new Refusal(422, type, message);
}

/** The description, trimmed: 1 to 100 characters, counted as characters and not as code units. */
export function checkDescription(description: string): string {
  const trimmed = description.trim();
  const length = Array.from(trimmed).length;
  if (length < 1 || length > DESCRIPTION_MAX) {
    refuse('InvalidDescription', `The description needs 1 to ${DESCRIPTION_MAX} characters, not only spaces.`);
  }
  return trimmed;
}

export function checkAmount(amount: number): void {
  if (amount < 1 || amount > AMOUNT_MAX) {
    refuse('InvalidAmount', `The amount must be from 1 to ${AMOUNT_MAX}, in hundredths of the currency.`);
  }
}

/** A rate as a decimal string, with its value in millionths. */
interface Converting {
  rate: string;
  millionths: bigint;
}

/** A rate as a decimal string, with its value in millionths; undefined when the text is not a rate. */
function converting(rate: string): Converting | undefined {
  const millionths = rateMillionths(rate);
  return millionths === undefined ? undefined : { rate, millionths };
}

/**
 * What the rates service offers for an expense in another currency: whether the server has a rates service at all, and the
 * rate it offers on the expense's day, if any. Without a rates service, a rate the payer gives is taken as it is.
 */
interface RateOffer {
  configured: boolean;
  rate?: string;
}

/**
 * The rate offered for the original of an expense: the rate of its currency to the group's on the expense's day. It is asked
 * of the rates service before anything is written, as the write itself does not wait. An expense in the group's currency, or
 * with a day that is not one, asks nothing.
 */
async function offerFor(
  rates: RatesConfig,
  input: Pick<NewExpense, 'original' | 'date'>,
  groupCurrency: string,
): Promise<RateOffer> {
  const configured = Boolean(rates.url);
  const original = input.original;
  if (
    !configured ||
    original === undefined ||
    !(CURRENCIES as readonly string[]).includes(original.currency) ||
    original.currency === groupCurrency ||
    !isRealDay(input.date)
  ) {
    return { configured };
  }
  const from = original.currency;
  return { configured, rate: await offeredRate(rates, { from, to: groupCurrency, date: input.date }) };
}

/**
 * Whether the given rate is within 2 % of the offered one: their difference is at most a fiftieth of the offered rate.
 * Both are in millionths, so the comparison is exact.
 */
function withinTwoPercent(given: bigint, offered: bigint): boolean {
  const difference = given > offered ? given - offered : offered - given;
  return difference * 50n <= offered;
}

/**
 * The rate an amount in another currency is converted at. A rate left out is the rate offered. A rate given is taken when the
 * server has no rates service; otherwise it must be within 2 % of the rate offered. A rate with no offer to take or to compare
 * with is refused, and so is a rate that is not a decimal greater than 0 with at most 6 digits after the point. `about` says
 * which rate this is, for the message of the refusal.
 */
function rateOf(given: string | undefined, offer: RateOffer, about: string): Converting {
  const offered = offer.rate === undefined ? undefined : converting(offer.rate);
  if (given === undefined) {
    if (offered === undefined) {
      refuse('NoRateOffered', `There is no rate offered for ${about}, so the rate must be given.`);
    }
    return offered;
  }
  const payers = converting(given);
  if (payers === undefined) {
    refuse('InvalidRate', 'The rate must be a decimal number greater than 0, with at most 6 digits after the point.');
  }
  if (offer.configured) {
    if (offered === undefined) {
      refuse('NoRateOffered', `There is no rate offered for ${about} to check the rate given against.`);
    }
    if (!withinTwoPercent(payers.millionths, offered.millionths)) {
      refuse(
        'RateDiffersFromOffered',
        `The rate ${given} differs from the rate offered for ${about}, ${offered.rate}, by more than 2 %.`,
      );
    }
  }
  return payers;
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
 * currency, converted at the rate `rateOf` settles on. The input gives exactly one of `amount` and `original`; the request's
 * schema refuses the others as the wrong shape, and this holds the same rule for whatever else reaches it.
 */
function amountOf(
  input: Pick<NewExpense, 'amount' | 'original' | 'date'>,
  groupCurrency: string,
  offer: RateOffer,
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
  const about = `${original.currency} to ${groupCurrency} on ${input.date}`;
  const { rate, millionths } = rateOf(original.rate, offer, about);
  const converted = convertedAmount(original.amount, millionths);
  if (converted < 1n || converted > BigInt(AMOUNT_MAX)) {
    refuse('InvalidAmount', `The amount in ${groupCurrency}, as converted, must be from 1 to ${AMOUNT_MAX}.`);
  }
  return {
    amount: Number(converted),
    original: { currency: original.currency, amount: original.amount, rate },
  };
}

function checkDate(date: string): void {
  if (!isRealDay(date)) refuse('InvalidDate', 'The date must be a day of the calendar, as YYYY-MM-DD.');
  // `YYYY-MM-DD` days order the same way as text, so the comparison is on the strings.
  if (date > todayUtc()) refuse('FutureDate', 'The expense cannot be dated after today, in UTC.');
}

/**
 * The split the input gives: one of its four ways, which are the three splits and a template of the group, whose split it
 * takes. Exactly one must be given; the request's schema refuses the others as the wrong shape, and this holds the same
 * rule for whatever else reaches it.
 */
function splitOf(db: DatabaseSync, groupId: string, input: NewExpense): Split {
  const { splitBetween, splitExactly, splitByShares, template } = input;
  const given = [splitBetween, splitExactly, splitByShares, template].filter(part => part !== undefined);
  if (given.length !== 1) {
    throw new Refusal(
      400,
      'InvalidRequest',
      'The expense needs exactly one split: splitBetween, splitExactly, splitByShares or template.',
    );
  }
  if (template !== undefined) return templateSplitOf(db, groupId, template);
  if (splitBetween !== undefined) return { kind: 'equal', members: splitBetween };
  if (splitExactly !== undefined) return { kind: 'exact', shares: splitExactly };
  if (splitByShares === undefined) throw new Error('unreachable: one split is given');
  return { kind: 'shares', shares: splitByShares };
}

/** The members of a split, in the order it was given. */
export function membersOf(split: Split): string[] {
  return split.kind === 'equal' ? split.members : split.shares.map(share => share.memberId);
}

/**
 * The shares of the split of an amount. An exact split's amounts are 0 or more and add up to the amount,
 * exactly; a split by shares gives each member at least one share. Otherwise the split is refused. The
 * split has been checked to name members, so the first member of an equal or weighted split exists.
 */
export function sharesOf(split: Split, amount: number): Share[] {
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
export function checkSplit(db: DatabaseSync, groupId: string, payerId: string, members: readonly string[]): void {
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
export function writeShares(db: DatabaseSync, expenseId: string, shares: readonly Share[]): void {
  const insertShare = db.prepare(
    'INSERT INTO expense_shares (expense_id, position, account_id, amount) VALUES (?, ?, ?, ?)',
  );
  shares.forEach((share, position) => {
    insertShare.run(expenseId, position, share.memberId, share.amount);
  });
}

/** What `recordExpense` writes: an expense whose split is already checked and computed. */
export interface RecordedExpense {
  id: string;
  groupId: string;
  description: string;
  amount: number;
  date: string;
  paidBy: string;
  splitKind: SplitKind;
  category: Category;
  shares: readonly Share[];
  /** The moment it is recorded, which dates its notices. */
  at: string;
  original?: Original;
}

/**
 * Writes an expense, its shares, the notices of its members, and the budget notices its recording passes. It is called
 * inside a write transaction.
 */
export function recordExpense(db: DatabaseSync, expense: RecordedExpense): void {
  db.prepare(
    'INSERT INTO expenses (id, group_id, description, amount, date, paid_by, split_kind, category, version, created_at, original_currency, original_amount, original_rate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)',
  ).run(
    expense.id,
    expense.groupId,
    expense.description,
    expense.amount,
    expense.date,
    expense.paidBy,
    expense.splitKind,
    expense.category,
    expense.at,
    expense.original?.currency ?? null,
    expense.original?.amount ?? null,
    expense.original?.rate ?? null,
  );
  writeShares(db, expense.id, expense.shares);
  writeExpenseNotices(db, expense, expense.shares);
  writeBudgetPassing(db, expense.groupId, expense.category, expense.date, expense.at);
  writeAudit(db, expense.groupId, {
    by: expense.paidBy,
    action: 'expense-recorded',
    subjectId: expense.id,
    amount: expense.amount,
    at: expense.at,
  });
}

/**
 * Records an expense of the group, paid by the account, split as the input gives it, and returns its id.
 * The account must be a member of the group; for anyone else the group does not exist. An expense in another
 * currency with no rate given takes the rate offered, which is asked of the rates service before the write.
 */
export async function createExpense(
  db: DatabaseSync,
  rates: RatesConfig,
  accountId: string,
  groupId: string,
  input: NewExpense,
): Promise<string> {
  const group = findGroupOf(db, accountId, groupId);
  if (!group) throw new Refusal(404, 'NotFound', 'There is no such group.');
  refuseIfArchived(db, groupId);
  const description = checkDescription(input.description);
  const offer = await offerFor(rates, input, group.currency);
  const { amount, original } = amountOf(input, group.currency, offer);
  checkDate(input.date);
  const id = randomUUID();
  const recordedAt = new Date().toISOString();
  // The split is checked and the expense, its shares and the notices of its members are written together, or not at all.
  inTransaction(db, () => {
    refuseIfArchived(db, groupId);
    const split = splitOf(db, groupId, input);
    checkSplit(db, groupId, accountId, membersOf(split));
    const shares = sharesOf(split, amount);
    recordExpense(db, {
      id,
      groupId,
      description,
      amount,
      date: input.date,
      paidBy: accountId,
      splitKind: split.kind,
      category: input.category ?? DEFAULT_CATEGORY,
      shares,
      at: recordedAt,
      original,
    });
  });
  return id;
}

/** The expense, when the account is a member of its group. For anyone else it does not exist. */
export function findExpenseOf(db: DatabaseSync, accountId: string, expenseId: string): Expense | undefined {
  const row = db
    .prepare(
      `SELECT e.id, e.group_id, e.description, e.amount, e.date, e.paid_by, e.split_kind, e.category, e.version,
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
 * The expense, when the account may change it: found for the account, changeable by it, and not concerning a member who
 * has left the group.
 */
export function changeableExpense(db: DatabaseSync, accountId: string, expenseId: string): Expense {
  const expense = findExpenseOf(db, accountId, expenseId);
  if (!expense) throw new Refusal(404, 'NotFound', 'There is no such expense.');
  refuseIfArchived(db, expense.groupId);
  checkMayChange(db, accountId, expense);
  checkNoFormerMember(db, expense);
  return expense;
}

/**
 * Replaces the expense whole with the one given, from the version its author read, and gives it one more
 * version. The payer stays the one who paid, and must stay in the split. The shares are computed again.
 * An expense changed since that version is refused with `ExpenseChanged`, and nothing of the edit is kept.
 * The rate offered for an edit in another currency is asked of the rates service before the write. Check,
 * version and write are one write transaction, so two edits from the same version cannot both land.
 */
export async function editExpense(
  db: DatabaseSync,
  rates: RatesConfig,
  accountId: string,
  expenseId: string,
  edit: ExpenseEdit,
): Promise<void> {
  const current = changeableExpense(db, accountId, expenseId);
  const group = findGroupOf(db, accountId, current.groupId);
  if (!group) throw new Refusal(404, 'NotFound', 'There is no such group.');
  const offer = await offerFor(rates, edit, group.currency);
  inTransaction(db, () => {
    const expense = changeableExpense(db, accountId, expenseId);
    if (edit.version !== expense.version) {
      throw new Refusal(409, 'ExpenseChanged', 'The expense changed since this version was read: read it again.');
    }
    const description = checkDescription(edit.description);
    const { amount, original } = amountOf(edit, group.currency, offer);
    checkDate(edit.date);
    const split = splitOf(db, expense.groupId, edit);
    checkSplit(db, expense.groupId, expense.paidBy, membersOf(split));
    const shares = sharesOf(split, amount);
    const category = edit.category ?? DEFAULT_CATEGORY;
    const at = new Date().toISOString();
    db.prepare(
      'UPDATE expenses SET description = ?, amount = ?, date = ?, split_kind = ?, category = ?, original_currency = ?, original_amount = ?, original_rate = ?, version = version + 1 WHERE id = ? AND version = ?',
    ).run(
      description,
      amount,
      edit.date,
      split.kind,
      category,
      original?.currency ?? null,
      original?.amount ?? null,
      original?.rate ?? null,
      expenseId,
      edit.version,
    );
    db.prepare('DELETE FROM expense_shares WHERE expense_id = ?').run(expenseId);
    writeShares(db, expenseId, shares);
    writeBudgetPassing(db, expense.groupId, category, edit.date, at);
    writeAudit(db, expense.groupId, { by: accountId, action: 'expense-edited', subjectId: expenseId, amount, at });
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
    refuseIfArchived(db, expense.groupId);
    checkMayChange(db, accountId, expense);
    checkNoFormerMember(db, expense);
    writeAudit(db, expense.groupId, {
      by: accountId,
      action: 'expense-deleted',
      subjectId: expenseId,
      amount: expense.amount,
      at: new Date().toISOString(),
    });
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
  required: ['id', 'groupId', 'description', 'amount', 'date', 'paidBy', 'shares', 'splitKind', 'category', 'version'],
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
    category: { enum: [...CATEGORIES] },
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

/** The ways of giving a split, each optional here: the body must give exactly one of them. */
const splitProperties = {
  template: { type: 'string' },
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

/** A body with none of the splits, or with more than one, is of the wrong shape. */
const exactlyOneSplit = {
  oneOf: [
    { required: ['splitBetween'] },
    { required: ['splitExactly'] },
    { required: ['splitByShares'] },
    { required: ['template'] },
  ],
};

/**
 * The amount of an expense: in the group's currency, or `original`, what was paid in another. Exactly one of them. The
 * rate of an original may be left out: the rate offered is taken then.
 */
const amountProperties = {
  amount: { type: 'integer' },
  original: {
    type: 'object',
    required: ['currency', 'amount'],
    properties: { currency: { type: 'string' }, amount: { type: 'integer' }, rate: { type: 'string' } },
  },
};

const exactlyOneAmount = {
  oneOf: [{ required: ['amount'] }, { required: ['original'] }],
};

/** An expense's category, when given: one of the categories, `other` when left out. */
const categoryProperty = { category: { type: 'string', enum: [...CATEGORIES] } };

export function registerExpenseRoutes(app: FastifyInstance, db: DatabaseSync, rates: RatesConfig): void {
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
            ...categoryProperty,
            ...splitProperties,
          },
          allOf: [exactlyOneSplit, exactlyOneAmount],
        },
        response: { 201: idSchema },
      },
    },
    async (request, reply) => {
      const accountId = requireCaller(db, request);
      const id = await createExpense(db, rates, accountId, request.params.id, request.body);
      return reply.code(201).send({ id });
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
            ...categoryProperty,
            version: { type: 'integer', minimum: 1 },
            ...splitProperties,
          },
          allOf: [exactlyOneSplit, exactlyOneAmount],
        },
      },
    },
    async (request, reply) => {
      const accountId = requireCaller(db, request);
      await editExpense(db, rates, accountId, request.params.id, request.body);
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { id: string } }>('/expenses/:id', (request, reply) => {
    const accountId = requireCaller(db, request);
    deleteExpense(db, accountId, request.params.id);
    return reply.code(204).send();
  });
}
