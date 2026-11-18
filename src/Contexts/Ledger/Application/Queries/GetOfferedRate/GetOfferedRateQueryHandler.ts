import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { Clock, ExecutionContext, QueryHandler } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { isCurrency } from '@SharedKernel/Domain/Currency';

import { IOfferedRates } from '@Contexts/Ledger/Application/Ports/IOfferedRates';
import { ExpenseDate } from '@Contexts/Ledger/Domain/Expense/ExpenseDate';
import { IGroupCurrency } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupCurrency';

/** The rate Tally offers from a currency to a group's, on a day (request 22), as the API answers it. */
export interface OfferedRateView {
  currency: string;
  date: string;
  rate: string;
}

/**
 * A signed-in member reads the rate Tally offers from a currency to their group's, on a day (today when none is given), as
 * the rates service gives it. To anyone who is not a member the group does not exist. A currency that is the group's or not one
 * of Tally's has no rate, and a day the calendar does not have, or one after today, is refused by name. The service is asked
 * through the port; when it offers none, there is no rate to read (ADR 13).
 */
export class GetOfferedRateQueryHandler extends QueryHandler<
  IOfferedRates,
  { groupId: string; currency: string; date?: string },
  IResult<OfferedRateView>
> {
  constructor(
    offeredRates: IOfferedRates,
    private groupCurrency: IGroupCurrency,
    private clock: Clock,
  ) {
    super(offeredRates);
  }

  async execute(
    { groupId, currency, date }: { groupId: string; currency: string; date?: string },
    context: ExecutionContext,
  ): Promise<IResult<OfferedRateView>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return Result.fail(caller.error);

    const today = this.clock();
    const groupsCurrency = await this.groupCurrency.currencyOf(groupId, caller.data.value);
    if (!groupsCurrency) return Result.fail(new NotFoundException('Ledger', 'Group not found'));
    if (!isCurrency(currency) || currency === groupsCurrency) {
      return Result.fail(new NotFoundException('Ledger', 'No rate is offered for this currency'));
    }

    const day = date ?? today.toISOString().slice(0, 10);
    const validDay = ExpenseDate.create(day, today);
    if (validDay.isFailure()) return Result.fail(validDay.error);

    const offer = await this.queries.rateOf({ from: currency, to: groupsCurrency, date: day });
    if (offer.kind !== 'offered') return Result.fail(new NotFoundException('Ledger', 'No rate is offered'));

    return Result.ok({ currency, date: day, rate: offer.rate });
  }
}
