import type { Database, Querier } from './database';
import { CATEGORIES, isCategory, type Category } from './categories';
import { deletedAmong } from './accounts';
import { assertNotArchived, findGroupOfMember, membersOfGroup, type Group } from './groups';
import { noticeBudget } from './notices';
import { Refusal } from './refusal';
import { inReadSnapshot, inTransaction } from './transactions';

/** A budget is from 1 to 100 000 000, in hundredths of the group's currency (as every amount of a group is). */
export const MIN_BUDGET = 1;
export const MAX_BUDGET = 100_000_000;

/** A category's budget of a group, with what the current month spends in the category. */
export interface Budget {
  readonly category: Category;
  readonly amount: number;
  readonly spent: number;
}

interface BudgetRow {
  category: Category;
  amount: number;
}

/** The month, `YYYY-MM`, of an instant, in UTC. */
export function monthOf(instant: Date): string {
  return instant.toISOString().slice(0, 7);
}

/** The first day of `month` and the first day of the month after it, as `YYYY-MM-DD`: the days a month's expenses fall on. */
function monthDays(month: string): { from: string; to: string } {
  const year = Number(month.slice(0, 4));
  const monthIndex = Number(month.slice(5, 7)) - 1;
  return {
    from: new Date(Date.UTC(year, monthIndex, 1)).toISOString().slice(0, 10),
    to: new Date(Date.UTC(year, monthIndex + 1, 1)).toISOString().slice(0, 10),
  };
}

/**
 * What the group's expenses of `category` dated in `month` add up to, in the group's currency. A deleted expense is no
 * longer kept, so it counts in nothing.
 */
async function spentIn(db: Querier, groupId: string, category: Category, month: string): Promise<number> {
  const { from, to } = monthDays(month);
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM expenses
       WHERE group_id = ? AND category = ? AND spent_on >= ? AND spent_on < ?`,
    )
    .get<{ total: number }>(groupId, category, from, to);
  return Number(row?.total ?? 0);
}

/**
 * The group, when `callerId` is its owner; a non-member is `404` (as if it did not exist), an archived group `409` (see
 * {@link assertNotArchived}), another member `403`.
 */
async function ownedGroup(db: Querier, callerId: string, groupId: string): Promise<Group> {
  const group = await findGroupOfMember(db, callerId, groupId);
  if (!group) throw new Refusal(404, 'GroupNotFound', 'No group has this id.');
  assertNotArchived(group);
  if (group.ownerId !== callerId) {
    throw new Refusal(403, 'NotOwner', 'Only the owner of the group may set or remove its budgets.');
  }
  return group;
}

/** The category, when it is one of the categories; refused with `422` otherwise. */
function knownCategory(category: string): Category {
  if (!isCategory(category)) {
    throw new Refusal(422, 'CategoryIsUnsupported', `The category must be one of ${CATEGORIES.join(', ')}.`);
  }
  return category;
}

/**
 * Sets the budget of a category of a group: its owner only. Setting it again replaces the amount. Setting a budget makes
 * no notice by itself. Refused with `404` for a non-member, `403` for a member who is not the owner, `422` when the
 * category is not one of the categories or the amount is not a whole number from {@link MIN_BUDGET} to {@link MAX_BUDGET}.
 */
export async function setBudget(
  db: Database,
  input: { groupId: string; callerId: string; category: string; amount: number },
): Promise<void> {
  const { groupId, callerId, amount } = input;
  await inTransaction(db, async tx => {
    await ownedGroup(tx, callerId, groupId);
    const category = knownCategory(input.category);
    if (!Number.isInteger(amount) || amount < MIN_BUDGET || amount > MAX_BUDGET) {
      throw new Refusal(
        422,
        'BudgetAmountIsInvalid',
        `A budget must be a whole number from ${MIN_BUDGET} to ${MAX_BUDGET}.`,
      );
    }
    await tx
      .prepare(
        `INSERT INTO budgets (group_id, category, amount) VALUES (?, ?, ?)
         ON CONFLICT (group_id, category) DO UPDATE SET amount = excluded.amount`,
      )
      .run(groupId, category, amount);
  });
}

/**
 * Removes the budget of a category of a group: its owner only (refused as {@link setBudget} is). Removing a category
 * that has no budget changes nothing and is answered the same.
 */
export async function removeBudget(
  db: Database,
  input: { groupId: string; callerId: string; category: string },
): Promise<void> {
  const { groupId, callerId } = input;
  await inTransaction(db, async tx => {
    await ownedGroup(tx, callerId, groupId);
    const category = knownCategory(input.category);
    await tx.prepare('DELETE FROM budgets WHERE group_id = ? AND category = ?').run(groupId, category);
  });
}

/**
 * The budgets of a group that a member reads: each category that has one, in the order of the categories, with its
 * amount and what the month of `now` (in UTC) spends in it. Refused with `404` when `accountId` is not a member, as if
 * the group did not exist. Reading changes nothing.
 */
export async function budgetsOfGroup(db: Database, accountId: string, groupId: string, now: Date): Promise<Budget[]> {
  return inReadSnapshot(db, async snapshot => {
    if (!(await findGroupOfMember(snapshot, accountId, groupId))) {
      throw new Refusal(404, 'GroupNotFound', 'No group has this id.');
    }
    const rows = await snapshot
      .prepare('SELECT category, amount FROM budgets WHERE group_id = ?')
      .all<BudgetRow>(groupId);
    const month = monthOf(now);
    const budgets: Budget[] = [];
    for (const row of rows) {
      budgets.push({
        category: row.category,
        amount: Number(row.amount),
        spent: await spentIn(snapshot, groupId, row.category, month),
      });
    }
    return budgets.sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category));
  });
}

/**
 * Makes the notices of a group's budget passed, if the expense just recorded or edited (dated `date`, in `category`)
 * leaves its month of that category over the budget: one to each current member, the payer too, with what the month
 * spends. A month of a category is noticed once, ever: a month that goes further over, or comes back under and over
 * again, makes no other. Called in the transaction that keeps the expense, so the notices exist exactly when it does.
 */
export async function noticeBudgetPassed(
  db: Querier,
  input: { groupId: string; category: Category; date: string; at: string },
): Promise<void> {
  const { groupId, category, at } = input;
  const month = input.date.slice(0, 7);
  const budget = await db
    .prepare('SELECT amount FROM budgets WHERE group_id = ? AND category = ?')
    .get<{ amount: number }>(groupId, category);
  if (budget === undefined) return;
  const spent = await spentIn(db, groupId, category, month);
  if (spent <= budget.amount) return;
  const passed = await db
    .prepare('SELECT 1 FROM budget_months_passed WHERE group_id = ? AND category = ? AND month = ?')
    .get(groupId, category, month);
  if (passed !== undefined) return;
  await db
    .prepare('INSERT INTO budget_months_passed (group_id, category, month, passed_at) VALUES (?, ?, ?, ?)')
    .run(groupId, category, month, at);
  // A deleted account is told nothing: the notices go to the members who are not deleted.
  const members = await membersOfGroup(db, groupId);
  const memberIds = members.map(member => member.memberId);
  const deleted = await deletedAmong(db, memberIds);
  for (const member of members) {
    if (deleted.has(member.memberId)) continue;
    await noticeBudget(db, {
      recipientId: member.memberId,
      groupId,
      category,
      month,
      budget: Number(budget.amount),
      amount: spent,
      at,
    });
  }
}
