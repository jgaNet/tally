import type { Querier } from './database';
import { CATEGORIES, type Category } from './categories';

/**
 * What one person spent in a month, in a currency, in a category, across the groups they are a member of now: the sum of
 * their shares in the group's expenses of that category dated in that month. `month` is `YYYY-MM`, the UTC month an
 * expense's day falls in (an expense is dated by its day, so its month is the first seven characters of that day).
 */
export interface Insight {
  readonly month: string;
  readonly currency: string;
  readonly category: Category;
  readonly amount: number;
}

interface InsightRow {
  month: string;
  currency: string;
  category: Category;
  amount: number;
}

/**
 * The insights of `accountId`: one line for each month, currency and category where its shares add up to more than 0, the
 * earliest month first; in a month, the currencies in alphabetical order; in a currency, the categories in the order of
 * {@link CATEGORIES}. Only the groups `accountId` is a current member of count: a group left counts for nothing. A deleted
 * expense is no longer kept, so it counts for nothing too; an expense counts in its group's currency, whatever it was paid in.
 *
 * Each person reads their own, and only theirs: the caller passes their own id. Reading changes nothing.
 */
export async function spendingInsightsOf(db: Querier, accountId: string): Promise<Insight[]> {
  const rows = await db
    .prepare(
      `SELECT LEFT(e.spent_on, 7) AS month, g.currency AS currency, e.category AS category,
              SUM(s.amount) AS amount
       FROM group_members m
       JOIN groups g ON g.id = m.group_id
       JOIN expenses e ON e.group_id = m.group_id
       JOIN expense_shares s ON s.expense_id = e.id AND s.member_id = m.account_id
       WHERE m.account_id = ? AND m.left_at IS NULL
       GROUP BY LEFT(e.spent_on, 7), g.currency, e.category
       HAVING SUM(s.amount) > 0`,
    )
    .all<InsightRow>(accountId);
  return rows
    .map(row => ({
      month: row.month,
      currency: row.currency,
      category: row.category,
      amount: Number(row.amount),
    }))
    .sort(
      (a, b) =>
        compareText(a.month, b.month) ||
        compareText(a.currency, b.currency) ||
        CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category),
    );
}

/** Orders two strings by their code units, as the alphabet orders the ASCII letters of a currency code. */
function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
