import { isCurrencyCode } from '@SharedKernel/Domain/Currency';

import { ISettlementRates } from '@Contexts/Settlements/Application/Ports/ISettlementRates';
import { PaidIn } from '@Contexts/Settlements/Domain/Settlement/OriginalAmount';

/**
 * What a settlement's command gives as its money (request 39): an amount in the group's currency, or what is paid in another currency,
 * exactly one of them, as the transport gives it.
 */
export type MoneyPayload = { amount: number } | { original: { currency: string; amount: number } };

/**
 * The money a command decides on, with the rate asked for it when it is in another currency. The rate is asked here, once, on the day
 * the command is decided (UTC), and the book takes it: the payer gives no rate. A currency that is not one of Tally's, or the group's
 * own, is not asked for: the book refuses it.
 */
export const paidInOf = async (
  money: MoneyPayload,
  groupCurrency: string,
  rates: ISettlementRates,
  now: Date,
): Promise<PaidIn> => {
  if (!('original' in money)) return { amount: money.amount };
  const { currency, amount } = money.original;
  const rate =
    isCurrencyCode(currency) && currency !== groupCurrency
      ? await rates.rateOn({ from: currency, to: groupCurrency, date: now.toISOString().slice(0, 10) })
      : null;
  return { original: { currency, amount }, groupCurrency, rate };
};
