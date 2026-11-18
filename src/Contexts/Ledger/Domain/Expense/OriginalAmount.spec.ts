import { OriginalAmount } from '@Contexts/Ledger/Domain/Expense/OriginalAmount';

/** An expense paid in `currency` at `rate`, the group being in EUR. */
const paid = (amount: number, rate: string, currency = 'USD') =>
  OriginalAmount.create({ currency, amount, rate, groupCurrency: 'EUR' });

/** The amount in the group's currency, as a number, of an expense that is accepted. */
const converted = (amount: number, rate: string, currency = 'USD') => {
  const original = paid(amount, rate, currency).data!;
  return original.amountInGroupCurrency().data!.value;
};

describe('OriginalAmount: the amount in the group currency', () => {
  it('is the original amount times the rate, rounded to the nearest whole number', () => {
    expect(converted(1234, '1.0625')).toBe(1311);
    expect(converted(1000, '0.9545')).toBe(955);
  });

  it('rounds a half up', () => {
    expect(converted(1, '0.5')).toBe(1);
    expect(converted(3, '0.5')).toBe(2);
    expect(converted(2, '0.25')).toBe(1);
  });

  it('rounds down what is below a half', () => {
    expect(converted(1000, '0.9544')).toBe(954);
    expect(paid(1, '0.49999').data!.amountInGroupCurrency().error?.type).toBe('InvalidAmount');
  });

  it('is exact where a float would not be: 7 at 0.142857 is 0.999999, so 1', () => {
    expect(converted(7, '0.142857')).toBe(1);
  });

  it('takes a rate with no point, or with fewer than six digits after it', () => {
    expect(converted(40, '1')).toBe(40);
    expect(converted(10, '12.5')).toBe(125);
    expect(converted(3, '1.000001')).toBe(3);
  });

  it('refuses a converted amount that is not from 1 to 100 000 000, as any amount is', () => {
    const big = paid(100_000_000, '2').data!;
    expect(big.amountInGroupCurrency().isFailure()).toBe(true);
    expect(big.amountInGroupCurrency().error?.type).toBe('InvalidAmount');
    expect(paid(1, '0.4').data!.amountInGroupCurrency().isFailure()).toBe(true);
  });

  it('keeps the rate as the string it was given', () => {
    expect(paid(1, '0.9542').data!.rate).toBe('0.9542');
    expect(paid(1, '1').data!.rate).toBe('1');
    expect(paid(1, '12.5').data!.rate).toBe('12.5');
  });
});

describe('OriginalAmount: what is refused, by name', () => {
  it.each(['0', '0.000000', '0.0', '.5', '1.', '1.0000001', '-1', '1e3', 'abc', '', ' 1'])(
    'refuses the rate %j as InvalidRate',
    rate => {
      const result = paid(1, rate);
      expect(result.isFailure()).toBe(true);
      expect(result.error?.type).toBe('InvalidRate');
    },
  );

  it("refuses the group's own currency as SameCurrencyAsGroup", () => {
    expect(paid(10, '1', 'EUR').error?.type).toBe('SameCurrencyAsGroup');
  });

  it('refuses a currency that is not one of Tally’s as InvalidOriginalCurrency', () => {
    expect(paid(10, '1', 'JPY').error?.type).toBe('InvalidOriginalCurrency');
  });

  it.each([0, -5, 100_000_001, 1.5])('refuses the amount %p as InvalidOriginalAmount', amount => {
    expect(paid(amount, '1').error?.type).toBe('InvalidOriginalAmount');
  });

  it('accepts each of Tally’s currencies other than the group’s', () => {
    for (const currency of ['USD', 'GBP', 'CHF', 'CAD', 'AUD']) {
      expect(paid(10, '1', currency).isFailure()).toBe(false);
    }
  });
});

describe('OriginalAmount: a stored one', () => {
  it('reads back what was stored, and refuses corrupted data by throwing', () => {
    const stored = OriginalAmount.fromSnapshot({ currency: 'CHF', amount: 1000, rate: '0.9542' });
    expect(stored.currency).toBe('CHF');
    expect(stored.rate).toBe('0.9542');
    expect(() => OriginalAmount.fromSnapshot({ currency: 'XXX', amount: 1, rate: '1' })).toThrow();
    expect(() => OriginalAmount.fromSnapshot({ currency: 'USD', amount: 1, rate: '0' })).toThrow();
  });
});
