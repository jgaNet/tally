import { Result } from '@Architecture/Domain';
import { callerOf, query } from '@Architecture/Application/Lite/UseCase';
import { EXPENSE_CATEGORIES, ExpenseCategory } from '@Contexts/Ledger/Domain/Expense/ExpenseCategory';

import { IExpenseQueries } from './IExpenseQueries';
import { IGroupCurrency } from './IGroupCurrency';
import { IGroupMembers } from './IGroupMembers';

/** One line of a person's spending (request 37): what their shares add up to in a month, a currency and a category. */
export interface InsightView {
  month: string;
  currency: string;
  category: ExpenseCategory;
  amount: number;
}

/**
 * A person reads what they spent across every group they are a member of now (request 37): for each month, currency and category where
 * their shares add up to more than 0, the sum of their shares of the groups' expenses of that category dated in that month (UTC), each
 * in its group's currency. The earliest month first; in a month, the currencies alphabetically; in a currency, the categories in the order
 * request 24 lists them. Groups they have left count for nothing, and so do deleted expenses. Each person reads their own only.
 */
export const getMyInsights = query(
  'GetMyInsights',
  (groupMembers: IGroupMembers, groupCurrency: IGroupCurrency, expenses: IExpenseQueries) =>
    async (_input: void, context) => {
      const by = callerOf(context);
      const groupIds = await groupMembers.groupsOf(by);

      const currencies = new Map<string, string>();
      for (const groupId of groupIds) {
        const currency = await groupCurrency.currencyOf(groupId, by);
        if (currency !== undefined) currencies.set(groupId, currency);
      }

      const totals = new Map<string, InsightView>();
      for (const spent of await expenses.spendingOf(by, groupIds)) {
        const currency = currencies.get(spent.groupId);
        if (currency === undefined) continue;
        const key = `${spent.month}|${currency}|${spent.category}`;
        const line = totals.get(key) ?? { month: spent.month, currency, category: spent.category, amount: 0 };
        totals.set(key, { ...line, amount: line.amount + spent.amount });
      }

      const answer = [...totals.values()]
        .filter(line => line.amount > 0)
        .sort(
          (a, b) =>
            compare(a.month, b.month) ||
            compare(a.currency, b.currency) ||
            EXPENSE_CATEGORIES.indexOf(a.category) - EXPENSE_CATEGORIES.indexOf(b.category),
        );
      return Result.ok(answer);
    },
);

/** Orders two strings by their code units, not by the locale: months and currency codes compare the same everywhere. */
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
