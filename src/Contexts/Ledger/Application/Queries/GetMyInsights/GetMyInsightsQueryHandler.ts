import { IResult, Result } from '@Architecture/Domain';
import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { CATEGORIES, Category } from '@Contexts/Ledger/Domain/Expense/Category';
import { IInsightQueries } from '@Contexts/Ledger/Domain/Expense/Ports/IInsightQueries';
import { IGroupCurrency } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupCurrency';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';

/** One line of a person's spending: their shares in one month, currency and category, above 0 (request 37). */
export interface InsightView {
  month: string;
  currency: string;
  category: Category;
  amount: number;
}

/**
 * A signed-in person reads what they spent across every group they are a member of now (request 37): for each month, currency and
 * category, the sum of their shares in the group's expenses of that category dated in that month (UTC), each in its group's currency.
 * Deleted expenses count for nothing, and so do the groups they have left. The lines are in the order of the month, then the currency
 * alphabetically, then the categories in the order request 24 lists them. Each person reads their own, and nobody else's.
 */
export class GetMyInsightsQueryHandler extends QueryHandler<IInsightQueries, undefined, IResult<InsightView[]>> {
  constructor(
    queries: IInsightQueries,
    private groupMembers: IGroupMembers,
    private groupCurrency: IGroupCurrency,
  ) {
    super(queries);
  }

  async execute(_: undefined, context: ExecutionContext): Promise<IResult<InsightView[]>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return Result.fail(caller.error);
    const accountId = caller.data.value;

    // The groups the person is a member of now, each with the currency it counts in (ADR 12): a group that is not theirs has none.
    const currencies = new Map<string, string>();
    for (const groupId of await this.groupMembers.groupsOf(accountId)) {
      const currency = await this.groupCurrency.currencyOf(groupId, accountId);
      if (currency !== null) currencies.set(groupId, currency);
    }

    const rows = await this.queries.sharesOf(accountId, [...currencies.keys()]);
    const totals = new Map<string, InsightView>();
    for (const row of rows) {
      const currency = currencies.get(row.groupId);
      if (currency === undefined) continue;
      const key = `${row.month}|${currency}|${row.category}`;
      const total = totals.get(key) ?? { month: row.month, currency, category: row.category, amount: 0 };
      total.amount += row.amount;
      totals.set(key, total);
    }

    const views = [...totals.values()].filter(view => view.amount > 0).sort(byMonthCurrencyCategory);
    return Result.ok(views);
  }
}

function byMonthCurrencyCategory(a: InsightView, b: InsightView): number {
  if (a.month !== b.month) return a.month < b.month ? -1 : 1;
  if (a.currency !== b.currency) return a.currency < b.currency ? -1 : 1;
  return CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category);
}
