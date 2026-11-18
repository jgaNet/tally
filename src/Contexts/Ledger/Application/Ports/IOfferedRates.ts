import { ExpenseDate } from '@Contexts/Ledger/Domain/Expense/ExpenseDate';
import { CURRENCIES, ExpenseMoney } from '@Contexts/Ledger/Domain/Expense/OriginalAmount';
import { RateOffer } from '@Contexts/Ledger/Domain/Expense/RateOffer';

/** What Ledger asks a rate for: one currency in another, on a day (`YYYY-MM-DD`). */
export interface RateQuery {
  from: string;
  to: string;
  date: string;
}

/**
 * Ledger's own port onto the rates service, an outside system with an API of its own (request 22): the rate offered from one
 * currency to another on a day, as a plain value Ledger takes or refuses (DOMAIN-NON-DETERMINISM). The adapter answers over
 * the service's HTTP API; nothing here names it (ADR 13).
 */
export interface IOfferedRates {
  rateOf(query: RateQuery): Promise<RateOffer>;
}

/**
 * The rate offered for an expense's money, asked by the handler before the Expense decides (ADR 13). Asked only for an amount
 * in another currency that is one of Tally's, on a day that is a real one: anything else is refused by the Expense itself, and
 * the service is not asked about it. Null when nothing is asked.
 */
export async function offerForExpense(
  offeredRates: IOfferedRates,
  money: ExpenseMoney,
  groupCurrency: string,
  date: string,
  today: Date,
): Promise<RateOffer | null> {
  if (!('original' in money)) return null;

  const { currency } = money.original;
  if (!CURRENCIES.includes(currency) || currency === groupCurrency) return null;
  if (ExpenseDate.create(date, today).isFailure()) return null;

  return offeredRates.rateOf({ from: currency, to: groupCurrency, date });
}
