import { type Database, inTransaction } from '../database';
import { requireMembership, requireNotArchived } from '../groups/groups';
import { MAX_AMOUNT } from '../expenses/validation';
import { recordBudgetNotices } from '../notices/notices';
import { Refusal } from '../refusal';
import { CATEGORIES, type Category, categoryOf } from './categories';

export interface Budget {
  category: Category;
  /** In hundredths of the group's currency. */
  amount: number;
  /** What the current month spends in the category, in hundredths of the group's currency. */
  spent: number;
}

/** The month a day of the calendar is in, `YYYY-MM`: the first seven characters of `YYYY-MM-DD`, in UTC. */
export const monthOf = (day: string): string => day.slice(0, 7);

/** The current month, `YYYY-MM`, in UTC. */
export const currentMonth = (at: Date = new Date()): string => at.toISOString().slice(0, 7);

/** What `groupId` spends in `category` in `month`: its expenses of that category dated in that month. */
export async function spentIn(db: Database, groupId: string, category: Category, month: string): Promise<number> {
  const row = await db.row<{ spent: number }>(
    `SELECT COALESCE(SUM(amount), 0) AS spent FROM expenses
      WHERE group_id = ? AND category = ? AND substr(date, 1, 7) = ?`,
    [groupId, category, month],
  );
  return Number((row as { spent: number }).spent);
}

/** The owner of the group, for a member of it: any other member is refused, and anyone outside as if there were no group. */
async function requireOwner(db: Database, groupId: string, accountId: string): Promise<void> {
  const group = await requireMembership(db, groupId, accountId);
  await requireNotArchived(db, groupId);
  if (group.ownerId !== accountId) {
    throw new Refusal(403, 'NotPermitted', 'Only the owner of the group may set or remove its budgets.');
  }
}

/**
 * Sets the monthly budget of `category` in `groupId` to `amount`, in hundredths of the group's currency, from 1 to
 * `MAX_AMOUNT`, replacing any budget it had. Only the owner may. Setting a budget makes no notice by itself.
 */
export async function setBudget(
  db: Database,
  groupId: string,
  accountId: string,
  category: string,
  amount: number,
): Promise<void> {
  await inTransaction(db, async () => {
    await requireOwner(db, groupId, accountId);
    const checked = categoryOf(category);
    if (!Number.isInteger(amount) || amount < 1 || amount > MAX_AMOUNT) {
      throw new Refusal(422, 'InvalidBudget', `The budget must be a whole number from 1 to ${MAX_AMOUNT}.`);
    }
    await db.execute(
      `INSERT INTO budgets (group_id, category, amount, set_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (group_id, category) DO UPDATE SET amount = excluded.amount, set_at = excluded.set_at`,
      [groupId, checked, amount, new Date().toISOString()],
    );
  });
}

/** Removes the budget of `category` in `groupId`, by its owner. A category with no budget is refused with `404`. */
export async function removeBudget(db: Database, groupId: string, accountId: string, category: string): Promise<void> {
  await inTransaction(db, async () => {
    await requireOwner(db, groupId, accountId);
    const removed = await db.execute('DELETE FROM budgets WHERE group_id = ? AND category = ?', [
      groupId,
      categoryOf(category),
    ]);
    if (removed !== 1) {
      throw new Refusal(404, 'NotFound', 'This category has no budget.');
    }
  });
}

/**
 * The budgets of `groupId`, each category that has one, in the order of the categories, with what the month of `at`
 * spends in it. Reading changes nothing.
 */
export async function budgetsOf(db: Database, groupId: string, at: Date = new Date()): Promise<Budget[]> {
  const rows = await db.rows<{ category: Category; amount: number }>(
    'SELECT category, amount FROM budgets WHERE group_id = ?',
    [groupId],
  );
  const month = currentMonth(at);
  const budgets: Budget[] = [];
  for (const category of CATEGORIES) {
    const row = rows.find(budget => budget.category === category);
    if (row !== undefined) {
      budgets.push({ category, amount: row.amount, spent: await spentIn(db, groupId, category, month) });
    }
  }
  return budgets;
}

/**
 * Called inside the transaction that records or edits an expense of `groupId` in `category` on `date`, made at `at`.
 * When its month now spends more than the category's budget, and no notice was yet made for that group, category
 * and month, every member of the group is told once. A month that goes further over, or comes back under and over
 * again, is told nothing more.
 */
export async function noticeIfPassed(
  db: Database,
  groupId: string,
  category: Category,
  date: string,
  at: string,
): Promise<void> {
  const budget = await db.row<{ amount: number }>('SELECT amount FROM budgets WHERE group_id = ? AND category = ?', [
    groupId,
    category,
  ]);
  if (budget === undefined) {
    return;
  }
  const month = monthOf(date);
  const spent = await spentIn(db, groupId, category, month);
  if (spent <= budget.amount) {
    return;
  }
  const passed = await db.execute(
    'INSERT INTO budget_passings (group_id, category, month, at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
    [groupId, category, month, at],
  );
  if (passed !== 1) {
    return;
  }
  await recordBudgetNotices(db, { groupId, category, month, budget: budget.amount, amount: spent }, at);
}
