import { randomUUID } from 'node:crypto';
import { noticeIfPassed } from '../budgets/budgets';
import type { Category } from '../budgets/categories';
import { type Database, inTransaction } from '../database';
import { currencyOfGroup, leftMembersAmong, requireMembership } from '../groups/groups';
import type { Currency } from '../groups/validation';
import { recordExpenseNotices } from '../notices/notices';
import { type RatesConfig, offeredRate } from '../rates/rates';
import { Refusal } from '../refusal';
import { splitOfTemplate } from '../templates/templates';
import {
  type ExpenseInput,
  type MoneyInput,
  type Original,
  type RateOffer,
  type SplitInput,
  type SplitKind,
  type ValidExpense,
  isAcceptableDate,
  isOtherCurrency,
  validateExpense,
} from './validation';

/** What an expense is split by, as a request gives it: one of the three splits, or a template of its group. */
export type SplitRequest = SplitInput | { kind: 'template'; templateId: string };

/** An expense as a request gives it: its split may be a template, which is split by as if its split had been given. */
export type ExpenseRequest = Omit<ExpenseInput, 'split'> & { split: SplitRequest };

/** The split an expense of `groupId` is checked by: a template's own split, as saved, for a template. */
function splitFor(db: Database, groupId: string, split: SplitRequest): SplitInput {
  return split.kind === 'template' ? splitOfTemplate(db, groupId, split.templateId) : split;
}

export interface Share {
  memberId: string;
  /** In hundredths of the group's currency. */
  amount: number;
}

export interface Expense {
  id: string;
  groupId: string;
  description: string;
  amount: number;
  date: string;
  /** The account id of the member who recorded it. */
  paidBy: string;
  /** 1 when recorded, and one more at each edit. */
  version: number;
  /** How it was split: equally, by exact amounts, or by shares. */
  splitKind: SplitKind;
  /** What it was for: one of the categories. An expense given none is `other`. */
  category: Category;
  /** In the order of the split. Present when it was paid in another currency: `amount` is then the group's. */
  original?: Original;
  /** In the order of the split. */
  shares: Share[];
}

/**
 * Divides `amount` equally between `splitBetween`, in that order. Each share is the amount divided
 * by the number of members, rounded down; the remainder goes whole to the first member's share, so
 * the shares add up to the amount exactly, whoever paid.
 */
export function equalShares(amount: number, splitBetween: readonly string[]): Share[] {
  const base = Math.floor(amount / splitBetween.length);
  const remainder = amount - base * splitBetween.length;
  return splitBetween.map((memberId, position) => ({
    memberId,
    amount: position === 0 ? base + remainder : base,
  }));
}

/**
 * Each member's share of `amount` as their `splitByShares` say: the amount times their shares, divided
 * by the total of the shares, rounded down. The remainder goes whole to the first member's share, so
 * the shares add up to the amount exactly, whoever paid. Computed in integers of any size, so no
 * product overflows.
 */
export function sharesByCount(amount: number, splitByShares: readonly { memberId: string; shares: number }[]): Share[] {
  const total = splitByShares.reduce((sum, split) => sum + BigInt(split.shares), 0n);
  const parts = splitByShares.map(split => (BigInt(amount) * BigInt(split.shares)) / total);
  const remainder = BigInt(amount) - parts.reduce((sum, part) => sum + part, 0n);
  return splitByShares.map((split, position) => ({
    memberId: split.memberId,
    amount: Number(position === 0 ? parts[position] + remainder : parts[position]),
  }));
}

/** The shares of an expense of `amount` split as `split` says, in the order of the split. */
export function sharesOf(split: SplitInput, amount: number): Share[] {
  switch (split.kind) {
    case 'equal':
      return equalShares(amount, split.splitBetween);
    case 'exact':
      return split.splitExactly.map(share => ({ memberId: share.memberId, amount: share.amount }));
    case 'shares':
      return sharesByCount(amount, split.splitByShares);
  }
}

/**
 * The rate offer an expense's money is checked against. Only an expense in another currency, on a day that
 * may be recorded, asks the rates service; the rest need no rate. The rates service is asked outside any
 * transaction, since it is slow: the offer is then checked and written in one. An expense whose currency or
 * day is not allowed gets no offer, and is refused for that by `validateExpense`, before any rate.
 */
export async function rateOfferFor(
  rates: RatesConfig,
  groupCurrency: Currency,
  money: MoneyInput,
  date: string,
): Promise<RateOffer> {
  if (money.kind !== 'other' || !isOtherCurrency(money.currency, groupCurrency) || !isAcceptableDate(date)) {
    return { configured: false };
  }
  if (rates.url === '') {
    return { configured: false };
  }
  return { configured: true, offered: await offeredRate(rates, money.currency, groupCurrency, date) };
}

/**
 * Records an expense of `groupId` that `payerId` paid, split as its input says. `payerId` must be a member of
 * the group, or the group is refused as not there. An expense in another currency that states no rate is
 * recorded at the rate offered for its currency on its date (see `rateOfferFor`). The expense and its shares
 * are written together, or not at all.
 */
export async function createExpense(
  db: Database,
  rates: RatesConfig,
  groupId: string,
  payerId: string,
  input: ExpenseRequest,
): Promise<string> {
  const { currency } = requireMembership(db, groupId, payerId);
  const offer = await rateOfferFor(rates, currency, input.money, input.date);
  return inTransaction(db, () => {
    const group = requireMembership(db, groupId, payerId);
    const expense = validateExpense(
      { ...input, split: splitFor(db, groupId, input.split) },
      memberIdsOf(db, groupId),
      payerId,
      group.currency,
      offer,
    );
    return insertExpense(db, groupId, payerId, expense, new Date().toISOString());
  });
}

/** Writes a checked expense, its shares and its notices. Runs inside `inTransaction`. */
export function insertExpense(
  db: Database,
  groupId: string,
  payerId: string,
  expense: ValidExpense,
  at: string,
): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO expenses (id, group_id, description, amount, date, paid_by, version, split_kind,
                           original_currency, original_amount, original_rate, category, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    groupId,
    expense.description,
    expense.amount,
    expense.date,
    payerId,
    expense.split.kind,
    ...originalColumns(expense.original),
    expense.category,
    at,
  );
  const shares = sharesOf(expense.split, expense.amount);
  writeShares(db, id, shares);
  recordExpenseNotices(db, { id, groupId, paidBy: payerId, shares }, at);
  noticeIfPassed(db, groupId, expense.category, expense.date, at);
  return id;
}

/** The account ids of the members of `groupId`. */
export function memberIdsOf(db: Database, groupId: string): Set<string> {
  const rows = db.prepare('SELECT account_id FROM memberships WHERE group_id = ?').all(groupId) as unknown as {
    account_id: string;
  }[];
  return new Set(rows.map(row => row.account_id));
}

/** The columns that keep an expense's original amount, its currency and its rate: all null when it has none. */
function originalColumns(original: Original | undefined): [string | null, number | null, string | null] {
  return [original?.currency ?? null, original?.amount ?? null, original?.rate ?? null];
}

/** Writes the shares of an expense, in the order given: their positions are the order of the split. */
function writeShares(db: Database, expenseId: string, shares: Share[]): void {
  const insertShare = db.prepare(
    'INSERT INTO expense_shares (expense_id, position, member_id, amount) VALUES (?, ?, ?, ?)',
  );
  shares.forEach((share, position) => {
    insertShare.run(expenseId, position, share.memberId, share.amount);
  });
}

interface ExpenseRow {
  id: string;
  group_id: string;
  description: string;
  amount: number;
  date: string;
  paid_by: string;
  version: number;
  split_kind: SplitKind;
  original_currency: Currency | null;
  original_amount: number | null;
  original_rate: string | null;
  category: Category;
}

interface ShareRow {
  member_id: string;
  amount: number;
}

const EXPENSE_COLUMNS = `expenses.id, expenses.group_id, expenses.description, expenses.amount, expenses.date,
              expenses.paid_by, expenses.version, expenses.split_kind, expenses.original_currency,
              expenses.original_amount, expenses.original_rate, expenses.category`;

/** The expense from its row and its shares, which are read in the order of the split. */
function toExpense(row: ExpenseRow, shares: ShareRow[]): Expense {
  return {
    id: row.id,
    groupId: row.group_id,
    description: row.description,
    amount: row.amount,
    date: row.date,
    paidBy: row.paid_by,
    version: row.version,
    splitKind: row.split_kind,
    category: row.category,
    // Only an expense paid in another currency has an original; it is read back as it was given.
    ...(row.original_currency === null
      ? {}
      : {
          original: {
            currency: row.original_currency,
            amount: row.original_amount as number,
            rate: row.original_rate as string,
          },
        }),
    shares: shares.map(share => ({ memberId: share.member_id, amount: share.amount })),
  };
}

/**
 * The expense with this id, for a member of its group. For anyone else it is `undefined`, the same
 * as an expense that does not exist. Reading it changes nothing.
 */
export function findExpense(db: Database, expenseId: string, accountId: string): Expense | undefined {
  const row = db
    .prepare(
      `SELECT ${EXPENSE_COLUMNS}
         FROM expenses JOIN memberships ON memberships.group_id = expenses.group_id
        WHERE expenses.id = ? AND memberships.account_id = ?`,
    )
    .get(expenseId, accountId) as ExpenseRow | undefined;
  if (row === undefined) {
    return undefined;
  }
  const shares = db
    .prepare('SELECT member_id, amount FROM expense_shares WHERE expense_id = ? ORDER BY position')
    .all(expenseId) as unknown as ShareRow[];
  return toExpense(row, shares);
}

/**
 * Every expense of `groupId`, as `findExpense` reads each: the latest date first, then the most
 * recently recorded first. An edit does not change when an expense was recorded. Reading changes nothing.
 */
export function expensesOfGroup(db: Database, groupId: string): Expense[] {
  const rows = db
    .prepare(
      `SELECT ${EXPENSE_COLUMNS}
         FROM expenses
        WHERE expenses.group_id = ?
        ORDER BY expenses.date DESC, expenses.created_at DESC, expenses.rowid DESC`,
    )
    .all(groupId) as unknown as ExpenseRow[];
  const shareRows = db
    .prepare(
      `SELECT expense_shares.expense_id, expense_shares.member_id, expense_shares.amount
         FROM expense_shares JOIN expenses ON expenses.id = expense_shares.expense_id
        WHERE expenses.group_id = ?
        ORDER BY expense_shares.expense_id, expense_shares.position`,
    )
    .all(groupId) as unknown as (ShareRow & { expense_id: string })[];
  const sharesByExpense = new Map<string, ShareRow[]>();
  for (const share of shareRows) {
    const list = sharesByExpense.get(share.expense_id) ?? [];
    list.push(share);
    sharesByExpense.set(share.expense_id, list);
  }
  return rows.map(row => toExpense(row, sharesByExpense.get(row.id) ?? []));
}

/** The expense, for a member of its group. Anyone else is refused with `404`, as if it did not exist. */
export function requireExpense(db: Database, expenseId: string, accountId: string): Expense {
  const expense = findExpense(db, expenseId, accountId);
  if (!expense) {
    throw new Refusal(404, 'NotFound', 'There is no such expense.');
  }
  return expense;
}

/**
 * The expense, for an edit or a delete by `accountId`, who must be its payer or the owner of its
 * group. Another member is refused with `403`; anyone outside the group is refused with `404`, as
 * if the expense did not exist. An expense that names a member who has left is refused with `409`:
 * it is kept as it was, so that member's balance stays 0. Runs inside `inTransaction`, so the check
 * and the write cannot be split.
 */
export function requireEditor(db: Database, expenseId: string, accountId: string): Expense {
  const expense = requireExpense(db, expenseId, accountId);
  if (expense.paidBy !== accountId) {
    const group = requireMembership(db, expense.groupId, accountId);
    if (group.ownerId !== accountId) {
      throw new Refusal(403, 'NotPermitted', 'Only the member who paid for this expense, or the owner, may change it.');
    }
  }
  const named = [expense.paidBy, ...expense.shares.map(share => share.memberId)];
  if (leftMembersAmong(db, expense.groupId, named).length > 0) {
    throw new Refusal(
      409,
      'MemberHasLeft',
      'A member who has left the group is in this expense, so it cannot be changed.',
    );
  }
  return expense;
}

/**
 * Replaces the expense `expenseId` with `input`, made from `version`: the version the author read.
 * The payer stays the one who paid, and the shares are computed again from the new split. When the
 * expense has changed since `version`, the edit is refused with `409` and nothing of it is kept.
 * Two edits from the same version: the first is kept, the second is refused. An edit in another currency
 * that states no rate takes the rate offered for its currency on its date (see `rateOfferFor`).
 */
export async function updateExpense(
  db: Database,
  rates: RatesConfig,
  expenseId: string,
  accountId: string,
  input: ExpenseRequest,
  version: number,
): Promise<void> {
  // Who may edit, and the version, are settled before the rates service is asked: a refused edit asks nothing.
  const before = requireEditor(db, expenseId, accountId);
  if (before.version !== version) {
    throw staleVersion();
  }
  const offer = await rateOfferFor(rates, currencyOfGroup(db, before.groupId), input.money, input.date);
  inTransaction(db, () => {
    const current = requireEditor(db, expenseId, accountId);
    if (current.version !== version) {
      throw staleVersion();
    }
    const expense = validateExpense(
      { ...input, split: splitFor(db, current.groupId, input.split) },
      memberIdsOf(db, current.groupId),
      current.paidBy,
      currencyOfGroup(db, current.groupId),
      offer,
    );
    // The version is checked again in the write itself: it is the same check, made atomically.
    const written = db
      .prepare(
        `UPDATE expenses SET description = ?, amount = ?, date = ?, split_kind = ?,
                original_currency = ?, original_amount = ?, original_rate = ?, category = ?, version = version + 1
          WHERE id = ? AND version = ?`,
      )
      .run(
        expense.description,
        expense.amount,
        expense.date,
        expense.split.kind,
        ...originalColumns(expense.original),
        expense.category,
        expenseId,
        version,
      );
    if (written.changes !== 1) {
      throw staleVersion();
    }
    db.prepare('DELETE FROM expense_shares WHERE expense_id = ?').run(expenseId);
    writeShares(db, expenseId, sharesOf(expense.split, expense.amount));
    noticeIfPassed(db, current.groupId, expense.category, expense.date, new Date().toISOString());
  });
}

/**
 * Deletes the expense `expenseId`, by its payer or the owner of its group. It no longer exists: it
 * is not read, and it counts in no balance.
 */
export function deleteExpense(db: Database, expenseId: string, accountId: string): void {
  inTransaction(db, () => {
    requireEditor(db, expenseId, accountId);
    db.prepare('DELETE FROM receipts WHERE expense_id = ?').run(expenseId);
    db.prepare('DELETE FROM expense_shares WHERE expense_id = ?').run(expenseId);
    db.prepare('DELETE FROM expenses WHERE id = ?').run(expenseId);
  });
}

const staleVersion = (): Refusal =>
  new Refusal(409, 'StaleVersion', 'The expense has changed since the version you read: read it again and decide.');
