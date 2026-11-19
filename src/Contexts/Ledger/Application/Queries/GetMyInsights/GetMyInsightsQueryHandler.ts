import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { IResult, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { IGroupCurrency } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupCurrency';
import { CATEGORIES } from '@Contexts/Ledger/Domain/Expense/Category';
import { IInsightQueries } from '@Contexts/Ledger/Application/Ports/IInsightQueries';
import { InsightReadModel } from '@Contexts/Ledger/Application/ReadModel/InsightReadModel';

/**
 * A signed-in person reads what they spent across the groups they are a member of now (request 37): their shares, by month,
 * currency and category, each in the group's currency. A line is kept only where the shares add up to more than 0. The earliest
 * month first; in a month the currencies alphabetically; in a currency the categories in the order of request 24. Nobody else's
 * shares are read.
 */
export class GetMyInsightsQueryHandler extends QueryHandler<IInsightQueries, void, IResult<InsightReadModel[]>> {
  constructor(
    queries: IInsightQueries,
    private readonly groupMembers: IGroupMembers,
    private readonly groupCurrency: IGroupCurrency,
  ) {
    super(queries);
  }

  async execute(_: void, context: ExecutionContext): Promise<IResult<InsightReadModel[]>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return caller;

    const currencies = new Map<string, string>();
    for (const groupId of await this.groupMembers.groupsOf(caller.data)) {
      const currency = await this.groupCurrency.currencyOf(groupId);
      if (currency !== null) currencies.set(groupId.value, currency);
    }

    const totals = new Map<string, InsightReadModel>();
    for (const share of await this.queries.sharesOf(caller.data.value, [...currencies.keys()])) {
      const currency = currencies.get(share.groupId);
      if (currency === undefined) continue;
      const key = `${share.month}|${currency}|${share.category}`;
      const line = totals.get(key) ?? { month: share.month, currency, category: share.category, amount: 0 };
      totals.set(key, { ...line, amount: line.amount + share.amount });
    }

    const lines = [...totals.values()]
      .filter(line => line.amount > 0)
      .sort(
        (a, b) =>
          a.month.localeCompare(b.month) ||
          a.currency.localeCompare(b.currency) ||
          CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category),
      );
    return Result.ok(lines);
  }
}
