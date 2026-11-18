import { NO_SERVICE } from './Rate';
import { OriginalAmount } from './OriginalAmount';

const paid = (amount: number, rate: string, currency = 'CHF') => ({ currency, amount, rate });

describe('the amount in the group currency', () => {
  it('is the original times the rate, rounded to the nearest whole number, a half up (request 21)', () => {
    expect(OriginalAmount.create(paid(1234, '1.0625'), 'EUR', NO_SERVICE).data?.groupAmount()).toBe(1311);
    expect(OriginalAmount.create(paid(1000, '0.9545'), 'EUR', NO_SERVICE).data?.groupAmount()).toBe(955);
  });

  it('rounds a half up, whatever the digits before it', () => {
    expect(OriginalAmount.create(paid(1, '0.5'), 'EUR', NO_SERVICE).data?.groupAmount()).toBe(1);
    expect(OriginalAmount.create(paid(3, '0.5'), 'EUR', NO_SERVICE).data?.groupAmount()).toBe(2);
    expect(OriginalAmount.create(paid(2, '0.25'), 'EUR', NO_SERVICE).data?.groupAmount()).toBe(1);
    expect(OriginalAmount.create(paid(10, '0.25'), 'EUR', NO_SERVICE).data?.groupAmount()).toBe(3);
  });

  it('is exact at a rate of six digits after the point, where a float is not: 100 at 1.005 is 100.5, so 101', () => {
    // In floats, 100 × 1.005 is 100.49999999999999, which rounds to 100.
    expect(OriginalAmount.create(paid(100, '1.005'), 'EUR', NO_SERVICE).data?.groupAmount()).toBe(101);
  });

  it('counts an amount over the limit as the expense refuses it: 99 999 999 at 1.000001 is 100 000 099', () => {
    const original = OriginalAmount.create(paid(99_999_999, '1.000001'), 'EUR', NO_SERVICE).data!;
    expect(original.groupAmount()).toBe(100_000_099);
    expect(original.groupExpenseAmount().error?.type).toBe('InvalidExpenseAmount');
  });

  it('is 0 at a rate too small to count one whole number, and that expense is refused as any amount of 0 is', () => {
    const original = OriginalAmount.create(paid(1, '0.000001'), 'EUR', NO_SERVICE).data!;
    expect(original.groupAmount()).toBe(0);
    expect(original.groupExpenseAmount().error?.type).toBe('InvalidExpenseAmount');
  });

  it('holds a rate as the string it was given, and a rate of a whole number needs no point', () => {
    expect(OriginalAmount.create(paid(7, '1'), 'EUR', NO_SERVICE).data).toMatchObject({
      rate: '1',
      amount: 7,
      currency: 'CHF',
    });
    expect(OriginalAmount.create(paid(2, '12.5'), 'EUR', NO_SERVICE).data?.groupAmount()).toBe(25);
    expect(OriginalAmount.create(paid(2, '0.9542'), 'EUR', NO_SERVICE).data?.rate).toBe('0.9542');
  });
});

describe('the refusals of an original amount, each by its rule', () => {
  it("refuses a currency that is not one of Tally's", () => {
    expect(OriginalAmount.create(paid(10, '1', 'JPY'), 'EUR', NO_SERVICE).error?.type).toBe('InvalidOriginalCurrency');
  });

  it("refuses the group's own currency: an expense in it is not in another one", () => {
    expect(OriginalAmount.create(paid(10, '1', 'EUR'), 'EUR', NO_SERVICE).error?.type).toBe(
      'OriginalCurrencyIsGroupCurrency',
    );
  });

  it('refuses an amount that is not a whole number from 1 to 100 000 000', () => {
    for (const amount of [0, -5, 100_000_001, 1.5]) {
      expect(OriginalAmount.create(paid(amount, '1'), 'EUR', NO_SERVICE).error?.type).toBe('InvalidOriginalAmount');
    }
    expect(OriginalAmount.create(paid(100_000_000, '1'), 'EUR', NO_SERVICE).isSuccess()).toBe(true);
  });

  it('refuses a rate that is not a decimal number greater than 0 with at most 6 digits after the point', () => {
    for (const rate of ['0', '0.0', '.5', '1.', '1.1234567', '-1', '1e3', '', 'abc', ' 1']) {
      expect(OriginalAmount.create(paid(10, rate), 'EUR', NO_SERVICE).error?.type).toBe('InvalidExpenseRate');
    }
    expect(OriginalAmount.create(paid(10, '0.000001'), 'EUR', NO_SERVICE).isSuccess()).toBe(true);
  });

  it("refuses an amount in the group's currency that is over 100 000 000, the way any amount is", () => {
    const original = OriginalAmount.create(paid(100_000_000, '2'), 'EUR', NO_SERVICE).data!;
    expect(original.groupExpenseAmount().error?.type).toBe('InvalidExpenseAmount');
  });
});
