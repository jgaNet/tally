import { OriginalAmount } from '@Contexts/Ledger/Domain/Expense/OriginalAmount';

/** An expense paid in `currency` at `rate`, the group being in EUR. */
const paid = (amount: number, rate: string, currency = 'USD') =>
  OriginalAmount.create({ currency, amount, rate, groupCurrency: 'EUR' });

/** The amount in the group's currency, as a number, of an expense that is accepted. */
const converted = (amount: number, rate: string, currency = 'USD') => {
  const original = paid(amount, rate, currency).data!;
  return original.amountInGroupCurrency('EUR').data!.value;
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
    expect(paid(1, '0.49999').data!.amountInGroupCurrency('EUR').error?.type).toBe('InvalidAmount');
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
    expect(big.amountInGroupCurrency('EUR').isFailure()).toBe(true);
    expect(big.amountInGroupCurrency('EUR').error?.type).toBe('InvalidAmount');
    expect(paid(1, '0.4').data!.amountInGroupCurrency('EUR').isFailure()).toBe(true);
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
    expect(paid(10, '1', 'XXX').error?.type).toBe('InvalidOriginalCurrency');
  });

  it.each([0, -5, 100_000_001, 1.5])('refuses the amount %p as InvalidOriginalAmount', amount => {
    expect(paid(amount, '1').error?.type).toBe('InvalidOriginalAmount');
  });

  it('accepts each of Tally’s currencies other than the group’s', () => {
    for (const currency of ['USD', 'GBP', 'CHF', 'CAD', 'AUD', 'JPY', 'KRW', 'KWD', 'BHD']) {
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

describe('OriginalAmount.takeRate (request 22)', () => {
  const offered = (rate: string) => ({ kind: 'offered' as const, rate });

  it('takes the offer when the rate is left out, and refuses when there is none', () => {
    expect(OriginalAmount.takeRate({ offer: offered('0.95') }).data).toEqual({ rate: '0.95', source: 'offered' });
    expect(OriginalAmount.takeRate({ offer: { kind: 'none' } }).error).toMatchObject({ type: 'NoRateOffered' });
    expect(OriginalAmount.takeRate({ offer: { kind: 'unconfigured' } }).error).toMatchObject({
      type: 'NoRateOffered',
    });
  });

  it('keeps the payer’s rate, whatever it is, when no rates service is configured', () => {
    expect(OriginalAmount.takeRate({ rate: '1.0625', offer: { kind: 'unconfigured' } }).data).toEqual({
      rate: '1.0625',
      source: 'unchecked',
    });
  });

  it('checks a stated rate against the offer at exactly 2 % either side, and refuses beyond it', () => {
    const check = (rate: string) => OriginalAmount.takeRate({ rate, offer: offered('0.95') });
    expect(check('0.931').data).toEqual({ rate: '0.931', source: 'checked' });
    expect(check('0.969').data).toEqual({ rate: '0.969', source: 'checked' });
    expect(check('0.93').error).toMatchObject({ type: 'RateOutsideBand' });
    expect(check('0.97').error).toMatchObject({ type: 'RateOutsideBand' });
  });

  it('refuses a stated rate when no rate is offered to compare it with, and a rate of 0 or of another shape', () => {
    expect(OriginalAmount.takeRate({ rate: '1', offer: { kind: 'none' } }).error).toMatchObject({
      type: 'NoRateOffered',
    });
    expect(OriginalAmount.takeRate({ rate: '0', offer: offered('0.95') }).error).toMatchObject({ type: 'InvalidRate' });
    expect(OriginalAmount.takeRate({ rate: '1e3', offer: { kind: 'unconfigured' } }).error).toMatchObject({
      type: 'InvalidRate',
    });
  });
});

describe('OriginalAmount: currencies of another precision (request 40)', () => {
  const inGroup = (amount: number, rate: string, currency: string, groupCurrency: string) => {
    const original = OriginalAmount.create({ currency, amount, rate, groupCurrency }).data!;
    return original.amountInGroupCurrency(groupCurrency).data!.value;
  };

  it('is what one unit of each is worth, in the minor unit of the group’s currency', () => {
    // 12.50 euros at 161.5 yen to the euro: 2018.75 yen, so 2019 (a yen has no minor unit).
    expect(inGroup(1250, '161.5', 'EUR', 'JPY')).toBe(2019);
    // 10 dollars at 0.3075 dinars to the dollar: 3.075 dinars, so 3075 thousandths.
    expect(inGroup(1000, '0.3075', 'USD', 'KWD')).toBe(3075);
    // 10 000 yen at 0.0062 euros to the yen: 62 euros, so 6200 hundredths.
    expect(inGroup(10000, '0.0062', 'JPY', 'EUR')).toBe(6200);
  });

  it('rounds a half up in the group’s minor unit', () => {
    // 50 hundredths of a euro at 1 yen to the euro: half a yen, so 1 yen.
    expect(inGroup(50, '1', 'EUR', 'JPY')).toBe(1);
  });

  it('accepts an expense in a currency of another precision, and keeps its amount in its own minor unit', () => {
    const yen = OriginalAmount.create({ currency: 'JPY', amount: 10000, rate: '0.0062', groupCurrency: 'EUR' });
    expect(yen.isFailure()).toBe(false);
    expect(yen.data!.amount).toBe(10000);
    expect(OriginalAmount.create({ currency: 'KWD', amount: 1, rate: '1', groupCurrency: 'EUR' }).isFailure()).toBe(
      false,
    );
  });
});
