import { describe, expect, it } from '@jest/globals';

import { OfferedRate, OriginalAmount } from '@Contexts/Ledger/Domain/Expense/OriginalAmount';

/** No rates service at all (RATES_URL not set): a rate stated is kept as request 21 keeps it. */
const NO_SERVICE: OfferedRate = { kind: 'no-service' };
const offering = (rate: string): OfferedRate => ({ kind: 'rate', rate });
const NONE: OfferedRate = { kind: 'none' };

const decide = (
  currency: string,
  amount: number,
  rate: string | undefined,
  groupCurrency = 'EUR',
  offered: OfferedRate = NO_SERVICE,
) => OriginalAmount.decide({ currency, amount, rate }, groupCurrency, offered);

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
      expect(decide('CHF', 1, rate, 'EUR', offering('0.95')).error?.type).toBe('InvalidOriginalRate');
    }
  });

  it('keeps a stated rate when no rates service is configured, whatever it is (request 21)', () => {
    expect(decide('USD', 1000, '3.7', 'EUR', NO_SERVICE).data!.rate).toBe('3.7');
  });

  it('takes the offered rate when the rate is left out, and keeps it as the service wrote it', () => {
    const taken = decide('USD', 1000, undefined, 'EUR', offering('0.95')).data!;
    expect([taken.rate, taken.toGroupAmount()]).toEqual(['0.95', 950n]);
  });

  it('refuses a rate left out when no rate is offered, or no service is configured, by name', () => {
    expect(decide('USD', 1000, undefined, 'EUR', NONE).error?.type).toBe('NoRateOffered');
    expect(decide('USD', 1000, undefined, 'EUR', NO_SERVICE).error?.type).toBe('NoRateOffered');
  });

  it('refuses a stated rate when no rate is offered to compare it with, by name', () => {
    expect(decide('USD', 1000, '0.95', 'EUR', NONE).error?.type).toBe('NoRateOffered');
  });

  it('accepts a stated rate within 2 % of the offered one, inclusive, and refuses one beyond it, by name', () => {
    for (const rate of ['0.931', '0.95', '0.969']) {
      expect(decide('USD', 1000, rate, 'EUR', offering('0.95')).isFailure()).toBe(false);
    }
    for (const rate of ['0.93', '0.97', '0.9', '1']) {
      expect(decide('USD', 1000, rate, 'EUR', offering('0.95')).error?.type).toBe('RateOutsideBand');
    }
  });

  it('measures the band in exact millionths, for any offered rate', () => {
    expect(decide('CHF', 1, '2.04', 'EUR', offering('2')).isFailure()).toBe(false);
    expect(decide('CHF', 1, '2.041', 'EUR', offering('2')).error?.type).toBe('RateOutsideBand');
    expect(decide('CHF', 1, '1.000001', 'EUR', offering('1')).isFailure()).toBe(false);
    expect(decide('CHF', 1, '0.98', 'EUR', offering('1')).isFailure()).toBe(false);
    expect(decide('CHF', 1, '0.979999', 'EUR', offering('1')).error?.type).toBe('RateOutsideBand');
  });

  it('keeps the kept rate as read back, and refuses a kept value the domain never keeps', () => {
    expect(OriginalAmount.kept({ currency: 'USD', amount: 1000, rate: '0.95' }).rate).toBe('0.95');
    expect(() => OriginalAmount.kept({ currency: 'USD', amount: 1000, rate: '0' })).toThrow();
  });
});
