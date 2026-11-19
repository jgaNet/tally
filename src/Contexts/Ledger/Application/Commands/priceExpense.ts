import { Id, IResult, Result } from '@Architecture/Domain';
import { Amount } from '@Contexts/Ledger/Domain/Expense/Amount';
import { OriginalRequest } from '@Contexts/Ledger/Domain/Expense/DTOs';
import { ExpenseDate } from '@Contexts/Ledger/Domain/Expense/ExpenseDate';
import { NotAGroupMember } from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';
import { OriginalAmount } from '@Contexts/Ledger/Domain/Expense/OriginalAmount';
import { RateSource } from '@Contexts/Ledger/Domain/Expense/RateOffer';
import { IGroupCurrency } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupCurrency';
import { IOfferedRates } from '@Contexts/Ledger/Application/Ports/IOfferedRates';

/**
 * The amount an expense is decided on: its amount in the group's currency, what it was paid in when it was another
 * currency, and where its rate came from (request 22; null when it was paid in the group's currency).
 */
export interface PricedExpense {
  amount: Amount;
  original: OriginalAmount | null;
  rateSource: RateSource | null;
}

/**
 * An expense's amount as a command gives it (requests 21 and 22): either `amount`, in the group's currency, as it always
 * was, or `original`, what was paid in another currency, converted at the rate taken into the group's. The rate is the one
 * given, checked against the rate offered for the expense's day, or the offer itself when it is left out (ADR 15). The
 * group's currency is asked of Groups, and the offer of the rates service, only for the second; a group that does not
 * exist has no member, as a split of one has none.
 */
export async function priceExpense(
  { amount, original }: { amount?: number; original?: OriginalRequest },
  groupId: Id,
  date: ExpenseDate,
  currencies: IGroupCurrency,
  rates: IOfferedRates,
): Promise<IResult<PricedExpense>> {
  if (original === undefined) {
    const inGroupCurrency = Amount.create(amount as number);
    if (inGroupCurrency.isFailure()) return inGroupCurrency;
    return Result.ok({ amount: inGroupCurrency.data, original: null, rateSource: null });
  }

  const groupCurrency = await currencies.currencyOf(groupId);
  if (groupCurrency === null) return Result.fail(new NotAGroupMember());
  const inCurrency = OriginalAmount.checkCurrency(original.currency, groupCurrency);
  if (inCurrency.isFailure()) return inCurrency;
  const offer = await rates.rateOn({ from: original.currency, to: groupCurrency, date: date.value });
  const taken = OriginalAmount.takeRate({ rate: original.rate, offer });
  if (taken.isFailure()) return taken;
  const paid = OriginalAmount.create({
    currency: original.currency,
    amount: original.amount,
    rate: taken.data.rate,
    groupCurrency,
  });
  if (paid.isFailure()) return paid;
  const converted = paid.data.amountInGroupCurrency(groupCurrency);
  if (converted.isFailure()) return converted;
  return Result.ok({ amount: converted.data, original: paid.data, rateSource: taken.data.source });
}
