import { IResult, Result } from '@Architecture/Domain';
import { Clock } from '@Architecture/Application';
import { callerOf, query } from '@Architecture/Application/Lite/UseCase';

import { IGroupCurrency } from '@Contexts/Ledger/Application/IGroupCurrency';
import { IGroupMembers } from '@Contexts/Ledger/Application/IGroupMembers';
import { IOfferedRates } from '@Contexts/Ledger/Application/IOfferedRates';
import { Currency } from '@SharedKernel/Domain';
import {
  GroupNotFoundException,
  OfferedRateNotFoundException,
} from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';

/** The question: the rate of a currency to the group's, on a day (`date`, today when it is left out). */
export interface OfferedRateInput {
  readonly groupId: string;
  readonly currency: string;
  readonly date?: string;
}

/** The answer: the currency, the day, and the rate one of the currency is worth in the group's on that day, as the service wrote it. */
export interface OfferedRateView {
  readonly currency: string;
  readonly date: string;
  readonly rate: string;
}

/**
 * The rate offered from a currency to the group's on a day (request 22, the storm's GetOfferedRate): read by the group's members
 * only, the same `404` as a group that does not exist for anyone else. A currency that is the group's, or not one of Tally's, has no
 * rate to offer, and nor does a day that is not a real one; the rates service's answer, when it has none, is the same `404`
 * (`OfferedRateNotFound`). It asks the rates service through its port and changes nothing.
 */
export const getOfferedRate = query(
  'GetOfferedRate',
  (groupMembers: IGroupMembers, groupCurrency: IGroupCurrency, rates: IOfferedRates, clock: Clock) =>
    async ({ groupId, currency, date }: OfferedRateInput, context): Promise<IResult<OfferedRateView>> => {
      const members = await groupMembers.membersOf(groupId);
      if (!members || !members.some(member => member.memberId === callerOf(context))) {
        return Result.fail(new GroupNotFoundException());
      }
      const group = await groupCurrency.currencyOf(groupId);
      if (group === undefined) return Result.fail(new GroupNotFoundException());

      const day = date ?? clock().toISOString().slice(0, 10);
      if (!Currency.isCode(currency) || currency === group || !isRealDay(day)) {
        return Result.fail(new OfferedRateNotFoundException());
      }
      const offered = await rates.rateOf(currency, group, day);
      if (offered.kind !== 'rate') return Result.fail(new OfferedRateNotFoundException());
      return Result.ok({ currency, date: day, rate: offered.rate });
    },
);

/** A real day of the calendar (`YYYY-MM-DD`, round-tripped so that 2026-02-30 is refused). */
const isRealDay = (raw: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const day = new Date(`${raw}T00:00:00.000Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === raw;
};
