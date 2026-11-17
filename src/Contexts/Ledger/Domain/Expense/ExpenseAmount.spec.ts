import { OriginalAmount } from '@Contexts/Ledger/Domain/Expense/ExpenseAmount';

describe('OriginalAmount.toGroupAmount, the amount in the group currency (request 21)', () => {
  const converted = (amount: number, rate: string) =>
    OriginalAmount.create({ currency: 'CHF', amount, rate }, 'EUR').data?.toGroupAmount();

  it('is the amount times the rate, rounded to the nearest whole number', () => {
    expect(converted(1234, '1.0625')).toBe(1311); // 1311.125
    expect(converted(1000, '0.9545')).toBe(955); // 954.5, a half rounded up
  });

  it('rounds a half up, and a smaller fraction down', () => {
    expect(converted(1, '0.5')).toBe(1);
    expect(converted(2, '0.25')).toBe(1);
    expect(converted(1, '0.4')).toBe(0);
    expect(converted(1, '0.499999')).toBe(0);
    expect(converted(1, '0.500000')).toBe(1);
  });

  it('is exact where a float would not be: no rounding on the way', () => {
    // 0.1 and 0.2 are not exact in binary floating point; their product in millionths is.
    expect(converted(5, '0.1')).toBe(1); // 0.5 rounds up, where 5 * 0.1 is 0.5000000000000001 or 0.49999999999999994 in floats
    expect(converted(3, '0.3')).toBe(1); // 0.9
    expect(converted(100_000_000, '12.5')).toBe(1_250_000_000);
  });

  it('keeps the rate it was given, as the string it is', () => {
    const paid = OriginalAmount.create({ currency: 'USD', amount: 100, rate: '12.5' }, 'EUR').data;
    expect(paid?.rate).toBe('12.5');
    expect(paid?.toSnapshot()).toEqual({ currency: 'USD', amount: 100, rate: '12.5' });
  });
});

describe('OriginalAmount.create, refusing what it does not hold (request 21)', () => {
  const create = (input: { currency: string; amount: number; rate: string }, groupCurrency = 'EUR') =>
    OriginalAmount.create(input, groupCurrency);

  it('accepts an amount in one of Tally currencies other than the group', () => {
    expect(create({ currency: 'CHF', amount: 1234, rate: '1.0625' }).isSuccess()).toBe(true);
    expect(create({ currency: 'GBP', amount: 1, rate: '1' }).isSuccess()).toBe(true);
    expect(create({ currency: 'AUD', amount: 100_000_000, rate: '0.000001' }).isSuccess()).toBe(true);
  });

  it('refuses a currency that is not one of Tally currencies, by name', () => {
    expect(create({ currency: 'XYZ', amount: 1, rate: '1' }).error?.type).toBe('UnknownCurrency');
    expect(create({ currency: 'eur', amount: 1, rate: '1' }).error?.type).toBe('UnknownCurrency');
  });

  it("refuses the group's own currency: then the amount is the amount itself", () => {
    expect(create({ currency: 'EUR', amount: 1, rate: '1' }).error?.type).toBe('OriginalCurrencyIsGroupCurrency');
  });

  it('refuses an amount that is not 1 to 100 000 000 in hundredths', () => {
    for (const amount of [0, -5, 1.5, 100_000_001]) {
      expect(create({ currency: 'CHF', amount, rate: '1' }).error?.type).toBe('InvalidOriginalAmount');
    }
  });

  it('refuses a rate that is not a decimal with at most 6 digits after the point', () => {
    for (const rate of ['', 'abc', '1.', '.5', '-1', '1e3', '1,5', '1.0000001', ' 1']) {
      expect(create({ currency: 'CHF', amount: 1, rate }).error?.type).toBe('InvalidRate');
    }
  });

  it('refuses a rate that is 0, by name', () => {
    expect(create({ currency: 'CHF', amount: 1, rate: '0' }).error?.type).toBe('NonPositiveRate');
    expect(create({ currency: 'CHF', amount: 1, rate: '0.000000' }).error?.type).toBe('NonPositiveRate');
  });

  it('reads back a kept value without the group currency, which the store kept after it was checked', () => {
    expect(create({ currency: 'CHF', amount: 1234, rate: '1.0625' }, 'CHF').error?.type).toBe(
      'OriginalCurrencyIsGroupCurrency',
    );
    expect(OriginalAmount.create({ currency: 'CHF', amount: 1234, rate: '1.0625' }).isSuccess()).toBe(true);
  });
});
