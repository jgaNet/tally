import { Id, IResult, Result } from '@Architecture/Domain';
import { Amount } from '@Contexts/Ledger/Domain/Expense/Amount';
import { OriginalRequest } from '@Contexts/Ledger/Domain/Expense/DTOs';
import { NotAGroupMember } from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';
import { OriginalAmount } from '@Contexts/Ledger/Domain/Expense/OriginalAmount';
import { IGroupCurrency } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupCurrency';

/** The amount an expense is decided on: its amount in the group's currency, and what it was paid in, when it was another currency. */
export interface PricedExpense {
  amount: Amount;
  original: OriginalAmount | null;
}

/**
 * An expense's amount as a command gives it (request 21): either `amount`, in the group's currency, as it always was, or
 * `original`, what was paid in another currency, converted at the rate given into the group's. The group's currency is
 * asked of Groups only for the second; a group that does not exist has no member, as a split of one has none.
 */
export async function priceExpense(
  { amount, original }: { amount?: number; original?: OriginalRequest },
  groupId: Id,
  currencies: IGroupCurrency,
): Promise<IResult<PricedExpense>> {
  if (original === undefined) {
    const inGroupCurrency = Amount.create(amount as number);
    if (inGroupCurrency.isFailure()) return inGroupCurrency;
    return Result.ok({ amount: inGroupCurrency.data, original: null });
  }

  const groupCurrency = await currencies.currencyOf(groupId);
  if (groupCurrency === null) return Result.fail(new NotAGroupMember());
  const paid = OriginalAmount.create({
    currency: original.currency,
    amount: original.amount,
    rate: original.rate,
    groupCurrency,
  });
  if (paid.isFailure()) return paid;
  const converted = paid.data.amountInGroupCurrency();
  if (converted.isFailure()) return converted;
  return Result.ok({ amount: converted.data, original: paid.data });
}
