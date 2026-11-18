import { Clock, ExecutionContext, QueryHandler } from '@Architecture/Application';
import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { isCurrencyCode } from '@SharedKernel/Domain/Currency';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { IOfferedRates } from '@Contexts/Ledger/Application/Ports/IOfferedRates';
import { OfferedRateReadModel } from '@Contexts/Ledger/Application/ReadModel/OfferedRateReadModel';
import { IGroupCurrency } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupCurrency';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { SpentOn } from '@Contexts/Ledger/Domain/Expense/SpentOn';

/**
 * A signed-in member of a group reads the rate Tally offers from a currency to the group's on a day (today when no day is given),
 * as the rates service gives it (request 22). For anyone who is not a member the group does not exist. The answer is `404` when
 * no rate is offered, or when the currency is the group's own or not one of Tally's. The day is checked as an expense's is, against
 * the application's clock, which the wiring passes.
 */
export class GetOfferedRateQueryHandler extends QueryHandler<
  IOfferedRates,
  { groupId: string; currency: string; date?: string },
  IResult<OfferedRateReadModel>
> {
  constructor(
    rates: IOfferedRates,
    private groupMembers: IGroupMembers,
    private groupCurrency: IGroupCurrency,
    private clock: Clock,
  ) {
    super(rates);
  }

  async execute(
    { groupId, currency, date }: { groupId: string; currency: string; date?: string },
    context: ExecutionContext,
  ): Promise<IResult<OfferedRateReadModel>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return caller;

    if (!(await this.groupMembers.isMember(groupId, caller.data))) {
      return Result.fail(new NotFoundException('Ledger', 'Group not found', { id: groupId }));
    }
    const groupsCurrency = await this.groupCurrency.currencyOf(groupId);
    if (!groupsCurrency) return Result.fail(new NotFoundException('Ledger', 'Group not found', { id: groupId }));

    const today = this.clock().toISOString().slice(0, 10);
    const day = SpentOn.create(date ?? today, today);
    if (day.isFailure()) return day;

    if (!isCurrencyCode(currency) || currency === groupsCurrency) {
      return Result.fail(new NotFoundException('Ledger', 'Rate not found', { currency }));
    }
    const offer = await this.queries.rateOn({ from: currency, to: groupsCurrency, date: day.data.value });
    if (offer.kind !== 'offered') {
      return Result.fail(new NotFoundException('Ledger', 'Rate not found', { currency, date: day.data.value }));
    }
    return Result.ok({ currency, date: day.data.value, rate: offer.rate });
  }
}
