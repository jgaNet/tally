import { randomUUID } from 'node:crypto';
import type { Database } from '../database';
import type { Category } from '../budgets/categories';

/** A notice of an expense: to a member of its split but its payer, with their share of it. */
export interface ExpenseNotice {
  id: string;
  kind: 'expense';
  groupId: string;
  expenseId: string;
  /** The member's share of the expense, in hundredths of the group's currency. */
  amount: number;
  /** When the notice was made: the moment the expense was recorded. */
  at: string;
}

/** A reminder to a member who has owed too much for too long: what they still owe, in the group. */
export interface ReminderNotice {
  id: string;
  kind: 'reminder';
  groupId: string;
  /** What the member still owes, in hundredths of the group's currency: more than 2000. */
  amount: number;
  /** When the background job made the reminder. */
  at: string;
}

/**
 * A notice to every member of a group when a month's spending in a category passes its budget: once for each
 * group, category and month.
 */
export interface BudgetNotice {
  id: string;
  kind: 'budget';
  groupId: string;
  category: Category;
  /** The month, `YYYY-MM`, in UTC. */
  month: string;
  /** The category's budget for the month, in hundredths of the group's currency. */
  budget: number;
  /** What the month spends in the category, in hundredths of the group's currency: more than `budget`. */
  amount: number;
  /** When the notice was made: the moment the expense that passed the budget was recorded or edited. */
  at: string;
}

export type Notice = ExpenseNotice | ReminderNotice | BudgetNotice;

interface NoticeRow {
  id: string;
  kind: 'expense' | 'reminder' | 'budget';
  group_id: string;
  expense_id: string | null;
  category: Category | null;
  month: string | null;
  budget: number | null;
  amount: number;
  created_at: string;
}

/** What a month's spending in a category, passing its budget, is told to every member of the group. */
export interface BudgetPassing {
  groupId: string;
  category: Category;
  month: string;
  budget: number;
  amount: number;
}

/**
 * Writes a budget notice to every member of `groupId`, the payer included. Called inside the transaction that
 * records or edits the expense that passed the budget, and only once for the group, category and month.
 */
export function recordBudgetNotices(db: Database, passing: BudgetPassing, at: string): void {
  const members = db
    .prepare('SELECT account_id FROM memberships WHERE group_id = ?')
    .all(passing.groupId) as unknown as {
    account_id: string;
  }[];
  const insert = db.prepare(
    `INSERT INTO notices (id, account_id, kind, group_id, expense_id, category, month, budget, amount, created_at)
     VALUES (?, ?, 'budget', ?, NULL, ?, ?, ?, ?, ?)`,
  );
  for (const { account_id } of members) {
    insert.run(
      randomUUID(),
      account_id,
      passing.groupId,
      passing.category,
      passing.month,
      passing.budget,
      passing.amount,
      at,
    );
  }
}

/**
 * Writes a notice to each member of an expense's split but its payer, with their share. Called inside
 * the transaction that records the expense, so the notices exist exactly when the expense does: none is
 * written twice, and none is left behind when the expense is refused.
 */
export function recordExpenseNotices(
  db: Database,
  expense: { id: string; groupId: string; paidBy: string; shares: readonly { memberId: string; amount: number }[] },
  at: string,
): void {
  const insert = db.prepare(
    `INSERT INTO notices (id, account_id, kind, group_id, expense_id, amount, created_at)
     VALUES (?, ?, 'expense', ?, ?, ?, ?)`,
  );
  for (const share of expense.shares) {
    if (share.memberId === expense.paidBy) {
      continue;
    }
    insert.run(randomUUID(), share.memberId, expense.groupId, expense.id, share.amount, at);
  }
}

/** The signed-in account's own notices, the most recent first. Nobody else's are read. Reading changes nothing. */
export function noticesOf(db: Database, accountId: string): Notice[] {
  const rows = db
    .prepare(
      `SELECT id, kind, group_id, expense_id, category, month, budget, amount, created_at
         FROM notices
        WHERE account_id = ?
        ORDER BY created_at DESC, rowid DESC`,
    )
    .all(accountId) as unknown as NoticeRow[];
  return rows.map(toNotice);
}

/** The notice as it is answered: a reminder names no expense, so it has no `expenseId`; a budget notice names its category. */
function toNotice(row: NoticeRow): Notice {
  if (row.kind === 'reminder') {
    return { id: row.id, kind: 'reminder', groupId: row.group_id, amount: row.amount, at: row.created_at };
  }
  if (row.kind === 'budget') {
    return {
      id: row.id,
      kind: 'budget',
      groupId: row.group_id,
      category: row.category as Category, // a budget notice always names its category (see the schema)
      month: row.month as string,
      budget: row.budget as number,
      amount: row.amount,
      at: row.created_at,
    };
  }
  return {
    id: row.id,
    kind: 'expense',
    groupId: row.group_id,
    expenseId: row.expense_id as string, // an expense's notice always names its expense (see the schema)
    amount: row.amount,
    at: row.created_at,
  };
}
