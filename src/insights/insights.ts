import { CATEGORIES, type Category } from '../budgets/categories';
import type { Database } from '../database';

/** What a person spent in a month, in a currency, in a category: the sum of their shares of it. */
export interface Insight {
  /** The month, `YYYY-MM`, in UTC. */
  month: string;
  /** The currency of the group the expenses are in. */
  currency: string;
  category: Category;
  /** In the minor unit of `currency`. Always more than 0. */
  amount: number;
}

interface InsightRow {
  month: string;
  currency: string;
  category: Category;
  amount: number;
}

/**
 * What `accountId` spent across every group it is a member of now: for each month, currency and category, the sum of
 * its shares in the group's expenses of that category dated in that month, in UTC. Deleted expenses are gone, so they
 * count for nothing; a group left counts for nothing, as its membership is gone; an expense counts in its group's
 * currency. A line is given only where the sum is more than 0. The earliest month first; in a month, the currencies
 * in alphabetical order; in a currency, the categories in the order of the categories. Reading changes nothing.
 */
export async function insightsOf(db: Database, accountId: string): Promise<Insight[]> {
  const rows = await db.rows<InsightRow>(
    `SELECT substr(expenses.date, 1, 7) AS month, groups.currency AS currency, expenses.category AS category,
            SUM(expense_shares.amount) AS amount
       FROM expense_shares
       JOIN expenses ON expenses.id = expense_shares.expense_id
       JOIN groups ON groups.id = expenses.group_id
       JOIN memberships ON memberships.group_id = expenses.group_id
                       AND memberships.account_id = expense_shares.member_id
      WHERE expense_shares.member_id = ?
      GROUP BY substr(expenses.date, 1, 7), groups.currency, expenses.category
     HAVING SUM(expense_shares.amount) > 0`,
    [accountId],
  );
  const rank = (category: Category) => CATEGORIES.indexOf(category);
  const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return rows
    .map(row => ({ month: row.month, currency: row.currency, category: row.category, amount: Number(row.amount) }))
    .sort((a, b) => byText(a.month, b.month) || byText(a.currency, b.currency) || rank(a.category) - rank(b.category));
}
