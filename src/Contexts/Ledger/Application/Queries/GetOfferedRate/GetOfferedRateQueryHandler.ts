import { Clock, ExecutionContext, QueryHandler } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { ExpenseDate } from '@Contexts/Ledger/Domain/Expense/ExpenseDate';
import { OriginalAmount } from '@Contexts/Ledger/Domain/Expense/OriginalAmount';
import { IGroupCurrency } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupCurrency';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { IOfferedRates } from '@Contexts/Ledger/Application/Ports/IOfferedRates';
import { RateReadModel } from '@Contexts/Ledger/Application/ReadModel/RateReadModel';

/**
 * A member of a group reads the rate offered from a currency to the group's on a day, today when none is given (request
 * 22). For anyone else the group does not exist. A currency that is the group's, or not one of Tally's, has no rate; and a
 * day with no rate offered is the same answer.
 */
export class GetOfferedRateQueryHandler extends QueryHandler<
  IOfferedRates,
  { groupId: string; currency: string; date?: string },
  IResult<RateReadModel>
> {
  constructor(
    rates: IOfferedRates,
    private readonly groupCurrency: IGroupCurrency,
    private readonly groupMembers: IGroupMembers,
    private readonly clock: Clock,
  ) {
    super(rates);
  }

  async execute(
    { groupId, currency, date }: { groupId: string; currency: string; date?: string },
    context: ExecutionContext,
  ): Promise<IResult<RateReadModel>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return caller;

    const group = new Id(groupId);
    const members = await this.groupMembers.currentMembers(group);
    if (!members.some(member => member.equals(caller.data))) {
      return Result.fail(new NotFoundException('Ledger', 'Group not found'));
    }
    const groupCurrencyOf = await this.groupCurrency.currencyOf(group);
    if (groupCurrencyOf === null || OriginalAmount.checkCurrency(currency, groupCurrencyOf).isFailure()) {
      return Result.fail(new NotFoundException('Ledger', 'No rate is offered for this currency'));
    }
    const day = ExpenseDate.parse(date ?? this.clock().toISOString().slice(0, 10));
    if (day.isFailure()) return day;

    const offer = await this.queries.rateOn({ from: currency, to: groupCurrencyOf, date: day.data.value });
    if (offer.kind !== 'offered') {
      return Result.fail(new NotFoundException('Ledger', 'No rate is offered for that day'));
    }
    return Result.ok({ currency, date: day.data.value, rate: offer.rate });
  }
}
