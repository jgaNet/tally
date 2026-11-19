import { callerOf, query } from '@Architecture/Application/Lite/UseCase';
import { Result } from '@Architecture/Domain';

import { InsightView } from '@Contexts/Ledger/Domain/Insight/DTOs';
import { IInsightQueries } from '@Contexts/Ledger/Domain/Insight/Ports/IInsightQueries';
import { CATEGORIES, Category } from '@Contexts/Ledger/Domain/Expense/Category';
import { IGroupCurrency } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupCurrency';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';

/**
 * What the caller spent across the groups they are a member of now, by month, currency and category (request 37, docs/adr/0037). Each
 * group's shares are summed in the group's currency, whatever it was paid in; a group the caller left counts for nothing. The lines are
 * the earliest month first, then the currencies in alphabetical order, then the categories in the order the categories are listed; only
 * what was spent (a share above 0) is listed. Each person reads their own: the caller is the only account whose shares are read.
 */
export const getMyInsights = query(
  'GetMyInsights',
  (insights: IInsightQueries, groupMembers: IGroupMembers, groupCurrency: IGroupCurrency) =>
    async (_input: void, context) => {
      const by = callerOf(context);
      const groupIds = await groupMembers.currentGroupIdsOf(by);
      const currencies = new Map<string, string>();
      for (const groupId of groupIds) {
        const currency = await groupCurrency.currencyOf(by, groupId);
        if (currency !== undefined) currencies.set(groupId, currency);
      }
      const shares = await insights.sharesOf(
        by,
        groupIds.filter(groupId => currencies.has(groupId)),
      );

      const totals = new Map<string, InsightView>();
      for (const share of shares) {
        const currency = currencies.get(share.groupId);
        if (currency === undefined) continue;
        const key = `${share.month}|${currency}|${share.category}`;
        const line = totals.get(key) ?? { month: share.month, currency, category: share.category, amount: 0 };
        line.amount += share.amount;
        totals.set(key, line);
      }

      const lines = [...totals.values()]
        .filter(line => line.amount > 0)
        .sort(
          (a, b) =>
            a.month.localeCompare(b.month) ||
            a.currency.localeCompare(b.currency) ||
            CATEGORIES.indexOf(a.category as Category) - CATEGORIES.indexOf(b.category as Category),
        );
      return Result.ok(lines);
    },
);
