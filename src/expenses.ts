import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { findGroupOfMember, membersOfGroup } from './groups';
import { Refusal } from './refusal';
import { characters } from './text';
import { inReadSnapshot, inTransaction } from './transactions';

/** A description has 1 to this many characters. */
const MAX_DESCRIPTION_LENGTH = 100;
/** An amount is in hundredths of the group's currency (as every amount of a group is), from 1 to 100 000 000. */
export const MIN_AMOUNT = 1;
export const MAX_AMOUNT = 100_000_000;

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** How an expense was split: equally between its members, by exact amounts, or by shares. */
export type SplitKind = 'equal' | 'exact' | 'shares';

/** One member's part of an expense. */
export interface Share {
  readonly memberId: string;
  readonly amount: number;
}

/** What the application knows of an expense, as a member of its group sees it. `date` is a `YYYY-MM-DD` day. */
export interface Expense {
  readonly id: string;
  readonly groupId: string;
  readonly description: string;
  readonly amount: number;
  readonly date: string;
  readonly paidBy: string;
  /** 1 when the expense is recorded, one more at each edit. */
  readonly version: number;
  /** How the expense was split: `equal` (an expense recorded before splits by shares or exact amounts too). */
  readonly splitKind: SplitKind;
  /** The shares, in the order the split was given. */
  readonly shares: readonly Share[];
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

/** True when `text` is a real day of the calendar, written `YYYY-MM-DD`. */
function isCalendarDay(text: string): boolean {
  if (!DATE_SHAPE.test(text)) return false;
  const instant = new Date(`${text}T00:00:00.000Z`);
  return !Number.isNaN(instant.getTime()) && instant.toISOString().slice(0, 10) === text;
}

/** Today's day in UTC, `YYYY-MM-DD`. */
function todayInUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The fields an expense is given with, when it is recorded or edited. */
export interface ExpenseFields {
  readonly description: string;
  readonly amount: number;
  readonly date: string;
  readonly split: SplitInput;
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
 * Checks the fields of an expense of `groupId` paid by `payerId`, under the rules of recording one,
 * and answers the description trimmed of surrounding spaces with the shares it gives. Refused with
 * `422` (the error names the rule) when a rule is broken. Writes nothing; the caller runs it in its
 * transaction.
 */
function checkExpenseFields(
  db: DatabaseSync,
  groupId: string,
  payerId: string,
  fields: ExpenseFields,
): { description: string; shares: Share[] } {
  const { description, amount, date, split } = fields;
  const trimmedDescription = description.trim();
  if (characters(description) > MAX_DESCRIPTION_LENGTH || trimmedDescription.length === 0) {
    throw new Refusal(
      422,
      'DescriptionIsInvalid',
      `The description must have 1 to ${MAX_DESCRIPTION_LENGTH} characters and not be only spaces.`,
    );
  }
  if (!Number.isInteger(amount) || amount < MIN_AMOUNT || amount > MAX_AMOUNT) {
    throw new Refusal(422, 'AmountIsInvalid', `The amount must be a whole number from ${MIN_AMOUNT} to ${MAX_AMOUNT}.`);
  }
  if (!isCalendarDay(date)) {
    throw new Refusal(422, 'DateIsInvalid', 'The date must be a real day of the calendar, written YYYY-MM-DD.');
  }
  if (date > todayInUtc()) {
    throw new Refusal(422, 'DateIsInTheFuture', 'The date must not be after today (UTC).');
  }
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
  return { description: trimmedDescription, shares: sharesOfSplit(amount, split) };
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

export interface RecordExpenseInput extends ExpenseFields {
  readonly groupId: string;
  /** The member who records the expense: its payer. */
  readonly payerId: string;
}

/**
 * Records an expense the payer paid in the group, split as `split` gives, and returns its id. Refused
 * with `404` when the payer is not a member of the group; otherwise with `422` when the description,
 * amount, date or split breaks a rule (the error names it). The description is stored trimmed of
 * surrounding spaces. It is recorded at version 1.
 */
export function recordExpense(db: DatabaseSync, input: RecordExpenseInput): string {
  const { groupId, payerId, amount, date } = input;
  const id = randomUUID();
  inTransaction(db, () => {
    if (!findGroupOfMember(db, payerId, groupId)) {
      throw new Refusal(404, 'GroupNotFound', 'No group has this id.');
    }
    const checked = checkExpenseFields(db, groupId, payerId, input);
    db.prepare(
      'INSERT INTO expenses (id, group_id, description, amount, spent_on, paid_by, version, split_kind, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)',
    ).run(id, groupId, checked.description, amount, date, payerId, input.split.kind, new Date().toISOString());
    writeShares(db, id, checked.shares);
  });
  return id;
}

/** An expense as it reads, given its row and its shares in the order of the split. */
function expenseOf(row: ExpenseRow, shares: readonly ShareRow[]): Expense {
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
  };
}

/**
 * The expense with this id, when `accountId` is a member of its group; `undefined` otherwise, as if it
 * did not exist. Reading never changes it.
 */
export function findExpenseOfMember(db: DatabaseSync, accountId: string, expenseId: string): Expense | undefined {
  const row = db
    .prepare(
      `SELECT e.id, e.group_id, e.description, e.amount, e.spent_on, e.paid_by, e.version, e.split_kind FROM expenses e
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
        `SELECT id, group_id, description, amount, spent_on, paid_by, version, split_kind FROM expenses
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
 * The expense `editorId` may change: they must be a member of its group (else `404`, as if it did not
 * exist), and its payer or the group's owner (else `403`). An expense whose payer or a member of whose
 * split has left the group cannot be changed (`409`), so that their balance stays 0. Answers the expense
 * as it is now.
 */
function expenseChangeableBy(db: DatabaseSync, editorId: string, expenseId: string): Expense {
  const expense = findExpenseOfMember(db, editorId, expenseId);
  if (!expense) throw new Refusal(404, 'ExpenseNotFound', 'No expense has this id.');
  const ownerId = findGroupOfMember(db, editorId, expense.groupId)?.ownerId;
  if (editorId !== expense.paidBy && editorId !== ownerId) {
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
  return expense;
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
 * payer stays the one who paid, and the shares and how they were split are replaced. Refused with `404`
 * when the editor is not a member of the expense's group, with `403` when the editor is neither its
 * payer nor the group's owner, with `409` when the expense has changed since the version given. A
 * refused edit keeps nothing: the edit is one transaction, so two edits of one version cannot both be kept.
 */
export function editExpense(db: DatabaseSync, input: EditExpenseInput): Expense {
  const { expenseId, editorId, version, amount, date } = input;
  return inTransaction(db, () => {
    const expense = expenseChangeableBy(db, editorId, expenseId);
    if (expense.version !== version) {
      throw new Refusal(
        409,
        'ExpenseChanged',
        `The expense has changed since version ${version}: it is at version ${expense.version}. Read it again.`,
      );
    }
    const checked = checkExpenseFields(db, expense.groupId, expense.paidBy, input);
    const updated = db
      .prepare(
        'UPDATE expenses SET description = ?, amount = ?, spent_on = ?, split_kind = ?, version = version + 1 WHERE id = ? AND version = ?',
      )
      .run(checked.description, amount, date, input.split.kind, expenseId, version);
    if (updated.changes !== 1) {
      throw new Refusal(409, 'ExpenseChanged', 'The expense has changed since it was read. Read it again.');
    }
    db.prepare('DELETE FROM expense_shares WHERE expense_id = ?').run(expenseId);
    writeShares(db, expenseId, checked.shares);
    return findExpenseOfMember(db, editorId, expenseId) as Expense;
  });
}

/**
 * Deletes the expense: it is no longer read, and counts in no balance. Refused like an edit: `404`
 * when the deleter is not a member of its group, `403` when they are neither its payer nor the
 * group's owner.
 */
export function deleteExpense(db: DatabaseSync, input: { expenseId: string; deleterId: string }): void {
  const { expenseId, deleterId } = input;
  inTransaction(db, () => {
    expenseChangeableBy(db, deleterId, expenseId);
    db.prepare('DELETE FROM expense_shares WHERE expense_id = ?').run(expenseId);
    db.prepare('DELETE FROM expenses WHERE id = ?').run(expenseId);
  });
}
