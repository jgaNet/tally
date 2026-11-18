import type { FastifyInstance } from 'fastify';
import { CATEGORIES, type Category } from './categories';
import type { Database, Queryable } from './database';
import { requireCaller } from './sessions';

/** What a person spent in a month, in a currency, in a category: the sum of their shares, in the minor unit of the currency. */
export interface Insight {
  month: string;
  currency: string;
  category: Category;
  amount: number;
}

/**
 * What the account spent across the groups it is a member of now: for each month, currency and category where its shares
 * add up to more than 0, the sum of its shares in the group's expenses of that category dated in that month, in UTC.
 * An expense counts in its group's currency, as it is kept. Expenses that are deleted are not kept, so count for nothing,
 * and a group the account has left is not one it is a member of, so counts for nothing too. A merged group has no
 * members of its own, and its expenses are the group kept's, so each is counted once. An archived group still counts:
 * what was spent in it was spent.
 *
 * The lines are the earliest month first; in a month, the currencies in alphabetical order; in a currency, the categories
 * in the order they are listed. A read changes nothing.
 */
export async function listInsightsOf(db: Queryable, accountId: string): Promise<Insight[]> {
  const rows = await db.all<Insight>(
    `SELECT substr(e.date, 1, 7) AS month, g.currency, e.category, SUM(s.amount) AS amount
     FROM expense_shares s
     JOIN expenses e ON e.id = s.expense_id
     JOIN groups g ON g.id = e.group_id
     JOIN group_members m ON m.group_id = g.id AND m.account_id = s.account_id AND m.left_at IS NULL
     WHERE s.account_id = ?
     GROUP BY substr(e.date, 1, 7), g.currency, e.category
     HAVING SUM(s.amount) > 0`,
    [accountId],
  );
  return rows
    .map(row => ({ month: row.month, currency: row.currency, category: row.category, amount: row.amount }))
    .sort(
      (a, b) =>
        compareText(a.month, b.month) ||
        compareText(a.currency, b.currency) ||
        CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category),
    );
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const insightSchema = {
  type: 'object',
  required: ['month', 'currency', 'category', 'amount'],
  properties: {
    month: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' },
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
    category: { enum: [...CATEGORIES] },
    amount: { type: 'integer', minimum: 1 },
  },
};

/** The insights are read by the person they are about, and by nobody else: the route names no other account. */
export function registerInsightRoutes(app: FastifyInstance, db: Database): void {
  app.get(
    '/accounts/me/insights',
    { schema: { response: { 200: { type: 'array', items: insightSchema } } } },
    async request => listInsightsOf(db, await requireCaller(db, request)),
  );
}
