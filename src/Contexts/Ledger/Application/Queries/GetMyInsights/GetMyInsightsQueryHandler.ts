import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { IResult, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { ISpendingQueries } from '@Contexts/Ledger/Application/Ports/ISpendingQueries';
import { InsightReadModel } from '@Contexts/Ledger/Application/ReadModel/InsightReadModel';
import { insightsOf } from '@Contexts/Ledger/Application/Queries/GetMyInsights/insights';
import { IGroupCurrency } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupCurrency';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';

/**
 * A signed-in person reads what they spent across every group they are a member of now (request 37): their shares, by month, currency and
 * category, in the order of `insightsOf`. Each person reads their own only: the query asks for the caller's id and no other. The groups and
 * their currencies come from Groups through the ports Ledger owns (ADR 28); an expense counts in its group's currency.
 */
export class GetMyInsightsQueryHandler extends QueryHandler<ISpendingQueries, void, IResult<InsightReadModel[]>> {
  constructor(
    queries: ISpendingQueries,
    private groupMembers: IGroupMembers,
    private groupCurrency: IGroupCurrency,
  ) {
    super(queries);
  }

  async execute(_: void, context: ExecutionContext): Promise<IResult<InsightReadModel[]>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return caller;

    const currencyOf = new Map<string, string>();
    for (const groupId of await this.groupMembers.groupsOf(caller.data)) {
      const currency = await this.groupCurrency.currencyOf(groupId);
      if (currency !== null) currencyOf.set(groupId, currency);
    }
    const spending = await this.queries.sharesOf(caller.data.value, [...currencyOf.keys()]);
    return Result.ok(insightsOf(spending, currencyOf));
  }
}
