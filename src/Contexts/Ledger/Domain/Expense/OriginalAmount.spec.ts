import { describe, expect, it } from '@jest/globals';

import { OriginalAmount } from '@Contexts/Ledger/Domain/Expense/OriginalAmount';

const decide = (currency: string, amount: number, rate: string, groupCurrency = 'EUR') =>
  OriginalAmount.decide({ currency, amount, rate }, groupCurrency);

describe('OriginalAmount', () => {
  it('converts the original at its rate, rounded to the nearest whole number, a half up', () => {
    expect(decide('CHF', 1234, '1.0625').data!.toGroupAmount()).toBe(1311n);
    expect(decide('USD', 1000, '0.9545').data!.toGroupAmount()).toBe(955n);
    expect(decide('USD', 1, '0.5').data!.toGroupAmount()).toBe(1n);
    expect(decide('USD', 1, '0.4999995').isFailure()).toBe(true);
    expect(decide('USD', 1, '0.499999').data!.toGroupAmount()).toBe(0n);
  });

  it('reads a rate as exact millionths, so a whole rate and a decimal one agree', () => {
    expect(decide('CHF', 5, '1').data!.toGroupAmount()).toBe(5n);
    expect(decide('CHF', 5, '12.5').data!.toGroupAmount()).toBe(63n);
    expect(decide('CHF', 3, '0.333333').data!.toGroupAmount()).toBe(1n);
  });

  it('keeps the currency, the amount and the rate exactly as given', () => {
    const original = decide('GBP', 500, '1.50').data!;
    expect([original.currency, original.amount, original.rate]).toEqual(['GBP', 500, '1.50']);
  });

  it('refuses a currency that is not Tally’s, or the group’s own, by name', () => {
    expect(decide('JPY', 1, '1').error?.type).toBe('InvalidOriginalCurrency');
    expect(decide('EUR', 1, '1').error?.type).toBe('OriginalCurrencyIsGroupCurrency');
  });

  it('refuses an amount that is not a whole number from 1 to 100 000 000, by name', () => {
    for (const amount of [0, -1, 1.5, 100_000_001]) {
      expect(decide('CHF', amount, '1').error?.type).toBe('InvalidOriginalAmount');
    }
    expect(decide('CHF', 100_000_000, '1').isFailure()).toBe(false);
  });

  it('refuses a rate that is not a positive decimal with at most six digits after the point, by name', () => {
    for (const rate of ['', '0', '0.0', '-1', '1.', '.5', '1.1234567', 'abc', '1e3', '1,5']) {
      expect(decide('CHF', 1, rate).error?.type).toBe('InvalidOriginalRate');
    }
  });
});
