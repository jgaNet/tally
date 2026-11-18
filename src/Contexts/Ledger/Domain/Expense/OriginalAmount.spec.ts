import { OriginalAmount } from '@Contexts/Ledger/Domain/Expense/OriginalAmount';

const paid = (currency: string, amount: number, rate: string) =>
  OriginalAmount.create({ currency, amount, rate }, 'EUR');

describe('OriginalAmount, converted into the group currency', () => {
  it('computes the amount times the rate, rounded to the nearest whole number, a half up, in exact arithmetic', () => {
    expect((paid('CHF', 1234, '1.0625').data as OriginalAmount).groupAmount()).toBe(1311);
    expect((paid('CHF', 1000, '0.9545').data as OriginalAmount).groupAmount()).toBe(955);
    expect((paid('USD', 1000, '0.9542').data as OriginalAmount).groupAmount()).toBe(954);
    expect((paid('USD', 5, '0.5').data as OriginalAmount).groupAmount()).toBe(3);
    expect((paid('USD', 1, '0.5').data as OriginalAmount).groupAmount()).toBe(1);
    expect((paid('GBP', 100, '12.5').data as OriginalAmount).groupAmount()).toBe(1250);
    expect((paid('GBP', 3, '0.333333').data as OriginalAmount).groupAmount()).toBe(1);
  });

  it('keeps the currency, the amount and the rate exactly as given, the rate as its string', () => {
    const original = paid('AUD', 2500, '1') as { data: OriginalAmount };
    expect(original.data.value).toEqual({ currency: 'AUD', amount: 2500, rate: '1' });
  });

  it('refuses a currency that is not Tally’s, or the group’s own, an amount out of range, and a rate that is not valid', () => {
    expect(paid('JPY', 100, '1')).toMatchObject({ error: { type: 'InvalidOriginalCurrency' } });
    expect(paid('EUR', 100, '1')).toMatchObject({ error: { type: 'SameCurrencyAsTheGroup' } });
    expect(paid('USD', 0, '1')).toMatchObject({ error: { type: 'InvalidOriginalAmount' } });
    expect(paid('USD', 100_000_001, '1')).toMatchObject({ error: { type: 'InvalidOriginalAmount' } });
    expect(paid('USD', 1.5, '1')).toMatchObject({ error: { type: 'InvalidOriginalAmount' } });
    for (const rate of ['0', '0.000', '-1', '1.', '.5', '1e3', 'abc', '1.0000001', '', '1,5']) {
      expect(paid('USD', 100, rate)).toMatchObject({ error: { type: 'InvalidRate' } });
    }
    expect(paid('USD', 100_000_000, '0.000001').isSuccess()).toBe(true);
  });
});
