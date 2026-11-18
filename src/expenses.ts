import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { recordAudit } from './audit';
import { noticeBudgetPassed } from './budgets';
import { CATEGORIES, DEFAULT_CATEGORY, isCategory, type Category } from './categories';
import { isCalendarDay, todayInUtc } from './days';
import { assertNotArchived, CURRENCIES, findGroupOfMember, membersOfGroup, type Currency, type Group } from './groups';
import { noticeExpense } from './notices';
import { millionthsOf, offeredRate, RATE_SHAPE, type RatesConfig } from './rates';
import { Refusal } from './refusal';
import { characters } from './text';
import { inReadSnapshot, inTransaction } from './transactions';
import { splitOfTemplate } from './templates';

/** A description has 1 to this many characters. */
const MAX_DESCRIPTION_LENGTH = 100;
/** An amount is in hundredths of the group's currency (as every amount of a group is), from 1 to 100 000 000. */
export const MIN_AMOUNT = 1;
export const MAX_AMOUNT = 100_000_000;

/** How far a rate given may differ from the rate offered, in percent of the offered rate: 2. A rate that differs by more is refused. */
const RATE_TOLERANCE_PERCENT = 2n;

/** How an expense was split: equally between its members, by exact amounts, or by shares. */
export type SplitKind = 'equal' | 'exact' | 'shares';

/** One member's part of an expense. */
export interface Share {
  readonly memberId: string;
  readonly amount: number;
}

/**
 * What an expense was paid in, when it was paid in another currency: `amount` hundredths of `currency`, at `rate`
 * (what one of that currency is worth in the group's currency, as the payer stated it, kept as given).
 */
export interface OriginalAmount {
  readonly currency: Currency;
  readonly amount: number;
  readonly rate: string;
}

/** What the application knows of an expense, as a member of its group sees it. `date` is a `YYYY-MM-DD` day. */
export interface Expense {
  readonly id: string;
  readonly groupId: string;
  readonly description: string;
  /** The amount in the group's currency: the original amount at its rate, when it was paid in another currency. */
  readonly amount: number;
  readonly date: string;
  readonly paidBy: string;
  /** 1 when the expense is recorded, one more at each edit. */
  readonly version: number;
  /** How the expense was split: `equal` (an expense recorded before splits by shares or exact amounts too). */
  readonly splitKind: SplitKind;
  /** The shares, in the order the split was given. */
  readonly shares: readonly Share[];
  /** What the expense was paid in, when in another currency; absent when it is in the group's currency. */
  readonly original?: OriginalAmount;
  /** The category of the expense: `other` when it was given none. */
  readonly category: Category;
}

interface ExpenseRow {
  id: string;
  group_id: string;
  description: string;
  amount: number;
  spent_on: string;
  paid_by: string;
  version: number;
  split_kind: SplitKind;
  original_currency: Currency | null;
  original_amount: number | null;
  rate: string | null;
  category: Category;
}

interface ShareRow {
  member_id: string;
  amount: number;
}

interface ShareOfExpenseRow extends ShareRow {
  expense_id: string;
}

/**
 * How an expense is split, as its request names it: exactly one of the three. The members of each part
 * are in the order of the split.
 */
export type SplitInput =
  | { readonly kind: 'equal'; readonly memberIds: readonly string[] }
  | { readonly kind: 'exact'; readonly parts: readonly { readonly memberId: string; readonly amount: number }[] }
  | { readonly kind: 'shares'; readonly parts: readonly { readonly memberId: string; readonly shares: number }[] };

/**
 * A split as an expense gives it: the split itself, or `template`, the id of one of its group's templates, whose split it
 * is split by (under the same rules, as it stands when the expense is recorded or edited).
 */
export type SplitGiven = SplitInput | { readonly kind: 'template'; readonly templateId: string };

/**
 * Divides `amount` equally between `memberIds`, in their order: each share is the amount divided by
 * their number, rounded down; the remainder, less than their number, goes whole to the share of the
 * first member listed, whoever paid. The shares add up to `amount` exactly.
 */
export function equalShares(amount: number, memberIds: readonly string[]): Share[] {
  const count = memberIds.length;
  const remainder = amount % count;
  const each = (amount - remainder) / count;
  return memberIds.map((memberId, index) => ({
    memberId,
    amount: index === 0 ? each + remainder : each,
  }));
}

/**
 * Divides `amount` by shares, in the order given: each member's share is the amount times their shares,
 * divided by the total of the shares, rounded down. It is computed in whole numbers, so it is exact
 * however large the shares. What is left over, less than the number of members, goes whole to the
 * share of the first member listed, whoever paid. The shares add up to `amount` exactly. Each member
 * has at least 1 share.
 */
export function sharesByCount(
  amount: number,
  parts: readonly { readonly memberId: string; readonly shares: number }[],
): Share[] {
  const total = parts.reduce((sum, part) => sum + BigInt(part.shares), 0n);
  const floors = parts.map(part => ({
    memberId: part.memberId,
    amount: Number((BigInt(amount) * BigInt(part.shares)) / total),
  }));
  const remainder = amount - floors.reduce((sum, share) => sum + share.amount, 0);
  return floors.map((share, index) =>
    index === 0 ? { memberId: share.memberId, amount: share.amount + remainder } : share,
  );
}

/**
 * The original amount times its rate, rounded to the nearest whole number, a half rounded up: 1234 at `"1.0625"`
 * is 1311.125, so 1311; 1000 at `"0.9545"` is 954.5, so 955. It is computed in whole numbers (the rate in
 * millionths), so it is exact. The original amount is a whole number.
 */
export function convertedAmount(originalAmount: number, rate: string): number {
  return Number((BigInt(originalAmount) * millionthsOf(rate) + 500_000n) / 1_000_000n);
}

/**
 * An expense's amount as it is given: in the group's currency, or in another currency at a rate, which is then
 * converted (see {@link amountInGroupCurrency}). The currency is not yet checked. A `rate` left out (`undefined`) is
 * the rate offered for the currency on the expense's date.
 */
export type ExpenseAmount =
  | { readonly kind: 'group'; readonly amount: number }
  | {
      readonly kind: 'original';
      readonly currency: string;
      readonly amount: number;
      readonly rate: string | undefined;
    };

/**
 * The rate the rates service offers for an expense's original currency on its date, as the check of the rate sees it.
 * `undefined` when the server has no rates service: the rate given is taken whatever it is, and a rate left out is
 * refused. Otherwise `offered` is the rate offered, `undefined` when none is.
 */
export type RateOffer = { readonly offered: string | undefined } | undefined;

/**
 * The fields an expense is given with, when it is recorded or edited. `category` is one of the categories, or left out
 * (`undefined`) for `other`.
 */
export interface ExpenseFields {
  readonly description: string;
  readonly amount: ExpenseAmount;
  readonly date: string;
  readonly split: SplitGiven;
  readonly category?: string;
}

/**
 * The rate an expense in another currency is recorded at: the rate given, when there is one, checked against the rate
 * offered (when the server has a rates service) to differ by no more than {@link RATE_TOLERANCE_PERCENT} of it; or the
 * rate offered, when the rate is left out. Refused with `422` when the rate given is not a rate, when no rate is
 * offered to check it against or to take in its place, or when it differs from the rate offered by more.
 */
function rateOf(currency: string, groupCurrency: Currency, rate: string | undefined, offer: RateOffer): string {
  if (rate === undefined) {
    if (offer?.offered === undefined) {
      throw new Refusal(
        422,
        'RateIsNotOffered',
        `No rate is offered from ${currency} to ${groupCurrency} on this day, so the expense cannot be recorded at one: give its rate.`,
      );
    }
    return offer.offered;
  }
  if (!RATE_SHAPE.test(rate) || millionthsOf(rate) === 0n) {
    throw new Refusal(
      422,
      'RateIsInvalid',
      'The rate must be a decimal number greater than 0, with at most 6 digits after the point.',
    );
  }
  if (offer === undefined) return rate;
  if (offer.offered === undefined) {
    throw new Refusal(
      422,
      'RateIsNotOffered',
      `No rate is offered from ${currency} to ${groupCurrency} on this day, so the rate given cannot be checked.`,
    );
  }
  // |rate - offered| > 2 % of offered, in millionths: |rate - offered| * 100 > 2 * offered.
  const given = millionthsOf(rate);
  const offered = millionthsOf(offer.offered);
  const difference = given > offered ? given - offered : offered - given;
  if (difference * 100n > RATE_TOLERANCE_PERCENT * offered) {
    throw new Refusal(
      422,
      'RateDiffersFromOffered',
      `The rate differs from the rate offered from ${currency} to ${groupCurrency} on this day, ${offer.offered}, by more than 2 %.`,
    );
  }
  return rate;
}

/**
 * The amount in the group's currency of an expense given as `input`, with what it was paid in when that is another
 * currency, at the rate {@link rateOf} settles. Refused with `422` (the error names the rule) when the other currency is
 * not one of Tally's or is the group's own, when its amount is not a whole number from {@link MIN_AMOUNT} to
 * {@link MAX_AMOUNT}, when the rate is refused (see {@link rateOf}), or when the amount converted is not from
 * {@link MIN_AMOUNT} to {@link MAX_AMOUNT}.
 */
function amountInGroupCurrency(
  groupCurrency: Currency,
  input: ExpenseAmount,
  offer: RateOffer,
): { amount: number; original: OriginalAmount | undefined } {
  if (input.kind === 'group') return { amount: input.amount, original: undefined };
  const { currency, amount } = input;
  if (!(CURRENCIES as readonly string[]).includes(currency)) {
    throw new Refusal(422, 'CurrencyIsUnsupported', `The currency must be one of ${CURRENCIES.join(', ')}.`);
  }
  if (currency === groupCurrency) {
    throw new Refusal(
      422,
      'CurrencyIsTheGroupsCurrency',
      `An expense in the group's currency, ${groupCurrency}, is given with its amount, not with another currency.`,
    );
  }
  if (!Number.isSafeInteger(amount) || amount < MIN_AMOUNT || amount > MAX_AMOUNT) {
    throw new Refusal(
      422,
      'OriginalAmountIsInvalid',
      `The original amount must be a whole number from ${MIN_AMOUNT} to ${MAX_AMOUNT}.`,
    );
  }
  const rate = rateOf(currency, groupCurrency, input.rate, offer);
  const converted = convertedAmount(amount, rate);
  if (converted < MIN_AMOUNT || converted > MAX_AMOUNT) {
    throw new Refusal(
      422,
      'AmountIsInvalid',
      `The original amount at its rate must be a whole number from ${MIN_AMOUNT} to ${MAX_AMOUNT} in the group's currency.`,
    );
  }
  return { amount: converted, original: { currency: currency as Currency, amount, rate } };
}

/** The split an expense gives, with a template's split in place of it: it is then the split of the template in the group. */
function resolveSplit(db: DatabaseSync, groupId: string, given: SplitGiven): SplitInput {
  if (given.kind !== 'template') return given;
  const split = splitOfTemplate(db, groupId, given.templateId);
  if (!split) {
    throw new Refusal(422, 'TemplateNotInGroup', 'The template must be one of the templates of the group.');
  }
  return split;
}

/** The members a split names, in the order it names them. */
function membersOfSplit(split: SplitInput): string[] {
  return split.kind === 'equal' ? [...split.memberIds] : split.parts.map(part => part.memberId);
}

/**
 * The rules of an exact split and of a split by shares that concern their values (the members have
 * been checked already): each exact amount is a whole number from 0, and they add up to `amount`; each
 * count of shares is a whole number from 1.
 */
function checkSplitValues(amount: number, split: SplitInput): void {
  if (split.kind === 'exact') {
    if (!split.parts.every(part => Number.isInteger(part.amount) && part.amount >= 0 && part.amount <= MAX_AMOUNT)) {
      throw new Refusal(
        422,
        'ShareAmountIsInvalid',
        `Each exact amount must be a whole number from 0 to ${MAX_AMOUNT}.`,
      );
    }
    const total = split.parts.reduce((sum, part) => sum + part.amount, 0);
    if (total !== amount) {
      throw new Refusal(422, 'AmountsDoNotAddUp', 'The exact amounts must add up to the amount of the expense.');
    }
  }
  if (split.kind === 'shares' && !split.parts.every(part => Number.isSafeInteger(part.shares) && part.shares >= 1)) {
    throw new Refusal(422, 'SharesAreInvalid', 'Each member must have a whole number of shares, at least 1.');
  }
}

/** The shares of an expense of `amount` split as given, the split having been checked first. */
function sharesOfSplit(amount: number, split: SplitInput): Share[] {
  switch (split.kind) {
    case 'equal':
      return equalShares(amount, split.memberIds);
    case 'exact':
      return split.parts.map(part => ({ memberId: part.memberId, amount: part.amount }));
    case 'shares':
      return sharesByCount(amount, split.parts);
  }
}

/**
 * Checks the fields of an expense of `groupId`, in `groupCurrency`, paid by `payerId`, under the rules of recording
 * one, and answers the description trimmed of surrounding spaces, the amount in the group's currency with what it was
 * paid in, the shares it gives, and its category (`other` when none is given). Refused with `422` (the error names the
 * rule) when a rule is broken. Writes nothing; the caller runs it in its transaction.
 */
export function checkExpenseFields(
  db: DatabaseSync,
  groupId: string,
  groupCurrency: Currency,
  payerId: string,
  fields: ExpenseFields,
  offer: RateOffer,
  today: string = todayInUtc(),
): {
  description: string;
  amount: number;
  original: OriginalAmount | undefined;
  shares: Share[];
  category: Category;
  splitKind: SplitKind;
} {
  const { description, date } = fields;
  const category = fields.category ?? DEFAULT_CATEGORY;
  if (!isCategory(category)) {
    throw new Refusal(422, 'CategoryIsUnsupported', `The category must be one of ${CATEGORIES.join(', ')}.`);
  }
  const trimmedDescription = description.trim();
  if (characters(description) > MAX_DESCRIPTION_LENGTH || trimmedDescription.length === 0) {
    throw new Refusal(
      422,
      'DescriptionIsInvalid',
      `The description must have 1 to ${MAX_DESCRIPTION_LENGTH} characters and not be only spaces.`,
    );
  }
  const { amount, original } = amountInGroupCurrency(groupCurrency, fields.amount, offer);
  if (!Number.isInteger(amount) || amount < MIN_AMOUNT || amount > MAX_AMOUNT) {
    throw new Refusal(422, 'AmountIsInvalid', `The amount must be a whole number from ${MIN_AMOUNT} to ${MAX_AMOUNT}.`);
  }
  if (!isCalendarDay(date)) {
    throw new Refusal(422, 'DateIsInvalid', 'The date must be a real day of the calendar, written YYYY-MM-DD.');
  }
  if (date > today) {
    throw new Refusal(422, 'DateIsInTheFuture', 'The date must not be after today (UTC).');
  }
  const split = resolveSplit(db, groupId, fields.split);
  const members = membersOfSplit(split);
  if (members.length === 0) {
    throw new Refusal(422, 'SplitIsEmpty', 'The expense must be split between at least one member.');
  }
  if (new Set(members).size !== members.length) {
    throw new Refusal(422, 'SplitRepeatsAMember', 'Each member may be listed once in the split.');
  }
  const groupMembers = new Set(membersOfGroup(db, groupId).map(member => member.memberId));
  if (members.some(memberId => !groupMembers.has(memberId))) {
    throw new Refusal(422, 'MemberNotInGroup', 'Every member of the split must be a member of the group.');
  }
  if (!members.includes(payerId)) {
    throw new Refusal(422, 'PayerNotInSplit', 'The payer must be one of the members the expense is split between.');
  }
  checkSplitValues(amount, split);
  return {
    description: trimmedDescription,
    amount,
    original,
    shares: sharesOfSplit(amount, split),
    category,
    splitKind: split.kind,
  };
}

/** Writes the expense's shares, in the order of the split. */
function writeShares(db: DatabaseSync, expenseId: string, shares: readonly Share[]) {
  const insertShare = db.prepare(
    'INSERT INTO expense_shares (expense_id, position, member_id, amount) VALUES (?, ?, ?, ?)',
  );
  shares.forEach((share, position) => {
    insertShare.run(expenseId, position, share.memberId, share.amount);
  });
}

/**
 * The columns an expense's original amount is kept in, in the order of the columns: all `null` when the expense is in
 * the group's currency.
 */
function originalColumns(original: OriginalAmount | undefined): [Currency | null, number | null, string | null] {
  return original ? [original.currency, original.amount, original.rate] : [null, null, null];
}

/**
 * Writes a checked expense at version 1 with its shares, and tells the members of its split of their shares; then
 * notices its month of its category as passed, when it passes the category's budget. The caller's transaction keeps
 * them together. `recurring` names the recurring expense and the day it is recorded for.
 */
export function insertExpense(
  db: DatabaseSync,
  input: {
    id: string;
    groupId: string;
    payerId: string;
    date: string;
    checked: {
      description: string;
      amount: number;
      original: OriginalAmount | undefined;
      shares: Share[];
      category: Category;
      splitKind: SplitKind;
    };
    at: string;
    recurring?: string;
  },
): void {
  const { id, groupId, payerId, date, checked, at } = input;
  const [originalCurrency, originalAmount, rate] = originalColumns(checked.original);
  db.prepare(
    `INSERT INTO expenses (id, group_id, description, amount, spent_on, paid_by, version, split_kind,
       original_currency, original_amount, rate, recurring_id, recurring_day, category, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    groupId,
    checked.description,
    checked.amount,
    date,
    payerId,
    checked.splitKind,
    originalCurrency,
    originalAmount,
    rate,
    input.recurring ?? null,
    input.recurring === undefined ? null : date,
    checked.category,
    at,
  );
  writeShares(db, id, checked.shares);
  recordAudit(db, { groupId, at, by: payerId, action: 'expense-recorded', subjectId: id, amount: checked.amount });
  // The members of the split are told of their shares in the same transaction: the notices exist with the expense.
  noticeExpense(db, { expenseId: id, groupId, payerId, shares: checked.shares, at });
  noticeBudgetPassed(db, { groupId, category: checked.category, date, at });
}

export interface RecordExpenseInput extends ExpenseFields {
  readonly groupId: string;
  /** The member who records the expense: its payer. */
  readonly payerId: string;
}

/**
 * The rate offer for an expense of `amount` on `date` in a group of `groupCurrency` (see {@link RateOffer}). The rates
 * service is asked only for an amount in another currency, on a real day, and only when the server has one; it is asked
 * outside any transaction, so that no write is held while it answers.
 */
async function rateOfferFor(
  rates: RatesConfig,
  groupCurrency: Currency,
  amount: ExpenseAmount,
  date: string,
): Promise<RateOffer> {
  if (rates.url === undefined || amount.kind !== 'original') return undefined;
  const { currency } = amount;
  const isOtherCurrency = (CURRENCIES as readonly string[]).includes(currency) && currency !== groupCurrency;
  if (!isOtherCurrency || !isCalendarDay(date)) return { offered: undefined };
  return { offered: await offeredRate(rates, { from: currency, to: groupCurrency, date }) };
}

/**
 * Records an expense the payer paid in the group, split as `split` gives, and returns its id. Refused
 * with `404` when the payer is not a member of the group; otherwise with `422` when the description,
 * amount, its original currency or rate, date or split breaks a rule (the error names it). The description is
 * stored trimmed of surrounding spaces; an amount in another currency is stored with its rate, converted to the
 * group's currency. A rate left out is the rate the rates service offers for its currency on the date (see
 * {@link rateOfferFor}); a rate given is checked against it. It is recorded at version 1.
 *
 * The rate is asked outside any transaction, so that no write is held while it answers; the rules are checked again
 * in the transaction that keeps the expense, so a member who left in between is refused as before.
 */
export async function recordExpense(db: DatabaseSync, rates: RatesConfig, input: RecordExpenseInput): Promise<string> {
  const { groupId, payerId, date } = input;
  const id = randomUUID();
  const asked = findGroupOfMember(db, payerId, groupId);
  if (!asked) {
    throw new Refusal(404, 'GroupNotFound', 'No group has this id.');
  }
  assertNotArchived(asked);
  const offer = await rateOfferFor(rates, asked.currency, input.amount, date);
  inTransaction(db, () => {
    const group = findGroupOfMember(db, payerId, groupId);
    if (!group) {
      throw new Refusal(404, 'GroupNotFound', 'No group has this id.');
    }
    assertNotArchived(group);
    const checked = checkExpenseFields(db, groupId, group.currency, payerId, input, offer);
    insertExpense(db, { id, groupId, payerId, date, checked, at: new Date().toISOString() });
  });
  return id;
}

/** What an expense was paid in, when in another currency; `undefined` when it is in the group's currency. */
function originalOf(row: ExpenseRow): OriginalAmount | undefined {
  if (row.original_currency === null || row.original_amount === null || row.rate === null) return undefined;
  return { currency: row.original_currency, amount: row.original_amount, rate: row.rate };
}

/** An expense as it reads, given its row and its shares in the order of the split. */
function expenseOf(row: ExpenseRow, shares: readonly ShareRow[]): Expense {
  const original = originalOf(row);
  return {
    id: row.id,
    groupId: row.group_id,
    description: row.description,
    amount: row.amount,
    date: row.spent_on,
    paidBy: row.paid_by,
    version: row.version,
    splitKind: row.split_kind,
    shares: shares.map(share => ({ memberId: share.member_id, amount: share.amount })),
    ...(original ? { original } : {}),
    category: row.category,
  };
}

/**
 * The expense with this id, when `accountId` is a member of its group; `undefined` otherwise, as if it
 * did not exist. Reading never changes it.
 */
export function findExpenseOfMember(db: DatabaseSync, accountId: string, expenseId: string): Expense | undefined {
  const row = db
    .prepare(
      `SELECT e.id, e.group_id, e.description, e.amount, e.spent_on, e.paid_by, e.version, e.split_kind,
              e.original_currency, e.original_amount, e.rate, e.category FROM expenses e
       JOIN group_members m ON m.group_id = e.group_id
       WHERE e.id = ? AND m.account_id = ? AND m.left_at IS NULL`,
    )
    .get(expenseId, accountId) as ExpenseRow | undefined;
  if (!row) return undefined;
  const shares = db
    .prepare('SELECT member_id, amount FROM expense_shares WHERE expense_id = ? ORDER BY position ASC')
    .all(row.id) as unknown as ShareRow[];
  return expenseOf(row, shares);
}

/**
 * Every expense of the group that is not deleted, as a member of the group reads each: the latest date
 * first, and on the same date the most recently recorded first. An edit does not change when an
 * expense was recorded, so it does not move it. Refused with `404` when `accountId` is not a member of
 * the group, as if it did not exist. It reads one consistent state of the file and changes nothing.
 */
export function expensesOfGroup(db: DatabaseSync, accountId: string, groupId: string): Expense[] {
  return inReadSnapshot(db, () => {
    if (!findGroupOfMember(db, accountId, groupId)) {
      throw new Refusal(404, 'GroupNotFound', 'No group has this id.');
    }
    const rows = db
      .prepare(
        `SELECT id, group_id, description, amount, spent_on, paid_by, version, split_kind,
                original_currency, original_amount, rate, category FROM expenses
         WHERE group_id = ? ORDER BY spent_on DESC, created_at DESC, rowid DESC`,
      )
      .all(groupId) as unknown as ExpenseRow[];
    const shareRows = db
      .prepare(
        `SELECT s.expense_id, s.member_id, s.amount FROM expense_shares s
         JOIN expenses e ON e.id = s.expense_id
         WHERE e.group_id = ? ORDER BY s.expense_id ASC, s.position ASC`,
      )
      .all(groupId) as unknown as ShareOfExpenseRow[];
    const sharesByExpense = new Map<string, ShareRow[]>();
    for (const share of shareRows) {
      const shares = sharesByExpense.get(share.expense_id) ?? [];
      shares.push(share);
      sharesByExpense.set(share.expense_id, shares);
    }
    return rows.map(row => expenseOf(row, sharesByExpense.get(row.id) ?? []));
  });
}

/**
 * The expense `editorId` may change, with its group: they must be a member of its group (else `404`, as if it did not
 * exist), and its payer or the group's owner (else `403`). An expense whose payer or a member of whose
 * split has left the group cannot be changed (`409`): an expense of a member who left stays as it was. Answers the expense
 * as it is now.
 */
export function expenseChangeableBy(
  db: DatabaseSync,
  editorId: string,
  expenseId: string,
): { expense: Expense; group: Group } {
  const expense = findExpenseOfMember(db, editorId, expenseId);
  if (!expense) throw new Refusal(404, 'ExpenseNotFound', 'No expense has this id.');
  const group = findGroupOfMember(db, editorId, expense.groupId);
  if (!group) throw new Refusal(404, 'ExpenseNotFound', 'No expense has this id.');
  assertNotArchived(group);
  if (editorId !== expense.paidBy && editorId !== group.ownerId) {
    throw new Refusal(403, 'NotPayerOrOwner', 'Only the payer of the expense or the owner of its group may change it.');
  }
  const currentMembers = new Set(membersOfGroup(db, expense.groupId).map(member => member.memberId));
  const concernsLeaver =
    !currentMembers.has(expense.paidBy) || expense.shares.some(share => !currentMembers.has(share.memberId));
  if (concernsLeaver) {
    throw new Refusal(
      409,
      'MemberHasLeft',
      'The expense concerns a member who has left the group, so it cannot be changed or deleted.',
    );
  }
  return { expense, group };
}

export interface EditExpenseInput extends ExpenseFields {
  readonly expenseId: string;
  /** The member who edits the expense: its payer or the group's owner. */
  readonly editorId: string;
  /** The version of the expense the edit was made from, the one its author read. */
  readonly version: number;
}

/**
 * Replaces the expense, whole, from the version the edit was made from, and answers it as it now
 * stands (at the next version). The fields are checked under the rules of recording an expense; the
 * payer stays the one who paid, and the amount (in the group's currency, or in another one at its rate, which is left out
 * to take the rate offered on the date, see {@link recordExpense}), the shares and how they were split are replaced.
 * Refused with `404` when the editor is not a member of the expense's
 * group, with `403` when the editor is neither its payer nor the group's owner, with `409` when the expense has
 * changed since the version given. A refused edit keeps nothing: the edit is one transaction, so two edits of one
 * version cannot both be kept.
 */
export async function editExpense(db: DatabaseSync, rates: RatesConfig, input: EditExpenseInput): Promise<Expense> {
  const { expenseId, editorId, version, date } = input;
  // The rate is asked for the expense as it is now, outside the transaction; the edit's own rules are checked inside it.
  const asked = findExpenseOfMember(db, editorId, expenseId);
  const askedGroup = asked && findGroupOfMember(db, editorId, asked.groupId);
  if (askedGroup) assertNotArchived(askedGroup);
  const offer = askedGroup ? await rateOfferFor(rates, askedGroup.currency, input.amount, date) : undefined;
  return inTransaction(db, () => {
    const { expense, group } = expenseChangeableBy(db, editorId, expenseId);
    if (expense.version !== version) {
      throw new Refusal(
        409,
        'ExpenseChanged',
        `The expense has changed since version ${version}: it is at version ${expense.version}. Read it again.`,
      );
    }
    const checked = checkExpenseFields(db, expense.groupId, group.currency, expense.paidBy, input, offer);
    const [originalCurrency, originalAmount, rate] = originalColumns(checked.original);
    const updated = db
      .prepare(
        `UPDATE expenses SET description = ?, amount = ?, spent_on = ?, split_kind = ?,
                original_currency = ?, original_amount = ?, rate = ?, category = ?, version = version + 1
         WHERE id = ? AND version = ?`,
      )
      .run(
        checked.description,
        checked.amount,
        date,
        checked.splitKind,
        originalCurrency,
        originalAmount,
        rate,
        checked.category,
        expenseId,
        version,
      );
    if (updated.changes !== 1) {
      throw new Refusal(409, 'ExpenseChanged', 'The expense has changed since it was read. Read it again.');
    }
    db.prepare('DELETE FROM expense_shares WHERE expense_id = ?').run(expenseId);
    writeShares(db, expenseId, checked.shares);
    const at = new Date().toISOString();
    recordAudit(db, {
      groupId: expense.groupId,
      at,
      by: editorId,
      action: 'expense-edited',
      subjectId: expenseId,
      amount: checked.amount,
    });
    // The month the edit leaves the expense in, in its category, is checked against the budget as a record is.
    noticeBudgetPassed(db, { groupId: expense.groupId, category: checked.category, date, at });
    return findExpenseOfMember(db, editorId, expenseId) as Expense;
  });
}

/**
 * Deletes the expense, and its receipt with it: it is no longer read, and counts in no balance. Refused like an edit: `404`
 * when the deleter is not a member of its group, `403` when they are neither its payer nor the
 * group's owner.
 */
export function deleteExpense(db: DatabaseSync, input: { expenseId: string; deleterId: string }): void {
  const { expenseId, deleterId } = input;
  inTransaction(db, () => {
    const { expense } = expenseChangeableBy(db, deleterId, expenseId);
    recordAudit(db, {
      groupId: expense.groupId,
      at: new Date().toISOString(),
      by: deleterId,
      action: 'expense-deleted',
      subjectId: expenseId,
      amount: expense.amount,
    });
    db.prepare('DELETE FROM receipts WHERE expense_id = ?').run(expenseId);
    db.prepare('DELETE FROM expense_shares WHERE expense_id = ?').run(expenseId);
    db.prepare('DELETE FROM expenses WHERE id = ?').run(expenseId);
  });
}
