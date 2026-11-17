import {
  isOfferableRate,
  OfferedRate,
  OriginalAmount,
  recordedRate,
} from '@Contexts/Ledger/Domain/Expense/ExpenseAmount';

/** No rates service is configured: the payer's rate stands, as request 21 has it. */
const UNAVAILABLE: OfferedRate = { kind: 'unavailable' };
const offer = (rate: string): OfferedRate => ({ kind: 'offered', rate });

describe('OriginalAmount.toGroupAmount, the amount in the group currency (request 21)', () => {
  const converted = (amount: number, rate: string) =>
    OriginalAmount.create({ currency: 'CHF', amount, rate }, 'EUR', UNAVAILABLE).data?.toGroupAmount();

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
    const paid = OriginalAmount.create({ currency: 'USD', amount: 100, rate: '12.5' }, 'EUR', UNAVAILABLE).data;
    expect(paid?.rate).toBe('12.5');
    expect(paid?.toSnapshot()).toEqual({ currency: 'USD', amount: 100, rate: '12.5' });
  });
});

describe('OriginalAmount.create, refusing what it does not hold (request 21)', () => {
  const create = (input: { currency: string; amount: number; rate?: string }, groupCurrency = 'EUR') =>
    OriginalAmount.create(input, groupCurrency, UNAVAILABLE);

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

  it('reads back a kept value, which the store kept after it was checked, without deciding a rate again', () => {
    expect(OriginalAmount.read({ currency: 'CHF', amount: 1234, rate: '1.0625' }).isSuccess()).toBe(true);
    expect(OriginalAmount.read({ currency: 'CHF', amount: 1234, rate: '0' }).error?.type).toBe('NonPositiveRate');
  });
});

describe('the rate an expense in another currency is recorded at (request 22, docs/adr/0021)', () => {
  it('takes the rate offered when the payer leaves its rate out', () => {
    expect(recordedRate(undefined, offer('0.95')).data).toBe('0.95');
    const paid = OriginalAmount.create({ currency: 'USD', amount: 1000 }, 'EUR', offer('0.9545'));
    expect(paid.data?.rate).toBe('0.9545');
    expect(paid.data?.toGroupAmount()).toBe(955);
  });

  it('refuses a rate left out with no rate offered, by name: an expense is never recorded at no rate', () => {
    expect(recordedRate(undefined, { kind: 'none' }).error?.type).toBe('NoRateOffered');
    expect(recordedRate(undefined, UNAVAILABLE).error?.type).toBe('NoRateOffered');
  });

  it('takes the payer rate, whatever it is, when no rates service is configured (request 21)', () => {
    expect(recordedRate('1.2345', UNAVAILABLE).data).toBe('1.2345');
    expect(recordedRate('9999', UNAVAILABLE).data).toBe('9999');
  });

  it('refuses a payer rate when a rates service offers none, by name, as there is nothing to compare it with', () => {
    expect(recordedRate('0.95', { kind: 'none' }).error?.type).toBe('NoRateOffered');
  });

  it('takes a payer rate within 2 % of the offered rate, and refuses one more than 2 % away, by name', () => {
    // with "0.95" offered, the band is 0.931 to 0.969
    expect(recordedRate('0.931', offer('0.95')).data).toBe('0.931');
    expect(recordedRate('0.969', offer('0.95')).data).toBe('0.969');
    expect(recordedRate('0.95', offer('0.95')).data).toBe('0.95');
    expect(recordedRate('0.93', offer('0.95')).error?.type).toBe('RateOutsideBand');
    expect(recordedRate('0.97', offer('0.95')).error?.type).toBe('RateOutsideBand');
  });

  it('measures the band exactly, to the millionth, on a rate of any size', () => {
    expect(recordedRate('102.000000', offer('100')).data).toBe('102.000000'); // exactly 2 %: within the band
    expect(recordedRate('102.000001', offer('100')).error?.type).toBe('RateOutsideBand');
    expect(recordedRate('97.999999', offer('100')).error?.type).toBe('RateOutsideBand');
    expect(recordedRate('101.999999', offer('100')).data).toBe('101.999999');
    expect(recordedRate('0.000001', offer('0.000001')).data).toBe('0.000001');
  });

  it('refuses a rate that is not a decimal, or is 0, whatever the offer says', () => {
    expect(recordedRate('abc', offer('0.95')).error?.type).toBe('InvalidRate');
    expect(recordedRate('abc', UNAVAILABLE).error?.type).toBe('InvalidRate');
    expect(recordedRate('0', UNAVAILABLE).error?.type).toBe('NonPositiveRate');
    expect(recordedRate('0', { kind: 'none' }).error?.type).toBe('NonPositiveRate');
  });

  it('accepts only an offered rate that is a decimal of at most 6 digits, greater than 0', () => {
    expect(isOfferableRate('0.95')).toBe(true);
    expect(isOfferableRate('12')).toBe(true);
    expect(isOfferableRate('0')).toBe(false);
    expect(isOfferableRate('0.0000000')).toBe(false);
    expect(isOfferableRate('0.9500001')).toBe(false);
    expect(isOfferableRate(0.95)).toBe(false);
    expect(isOfferableRate(undefined)).toBe(false);
  });
});
