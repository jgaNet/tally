import { OriginalAmount } from '@Contexts/Ledger/Domain/Expense/OriginalAmount';

/**
 * Each amount in its currency's own minor unit (request 40): the worked examples of the request, and the rule that a currency
 * which counts in hundredths converts as it always did.
 */
const offer = { kind: 'unconfigured' as const };
const originalOf = (currency: string, amount: number, rate: string, group: string) => {
  const created = OriginalAmount.create({ currency, amount, rate }, group, offer);
  if (created.isFailure()) throw created.error;
  return created.data;
};

describe('OriginalAmount in the minor unit of each currency (request 40)', () => {
  it('converts 12.50 euros into yen: 1250 euro cents at 161.5 yen per euro is 2018.75 yen, so 2019', () => {
    expect(originalOf('EUR', 1250, '161.5', 'JPY').inGroupCurrency('JPY')).toBe(2019);
  });

  it('converts 10 dollars into dinars: 1000 cents at 0.3075 dinars per dollar is 3.075 dinars, so 3075 thousandths', () => {
    expect(originalOf('USD', 1000, '0.3075', 'KWD').inGroupCurrency('KWD')).toBe(3075);
  });

  it('converts 10 000 yen into euros: 10 000 yen at 0.0062 euros per yen is 62 euros, so 6200 cents', () => {
    expect(originalOf('JPY', 10000, '0.0062', 'EUR').inGroupCurrency('EUR')).toBe(6200);
  });

  it('keeps the rounding a half up in the group’s minor unit, not the original’s', () => {
    // 1 yen at 0.005 euros per yen is 0.005 euros, which is 0.5 cents: a half up is 1 cent.
    expect(originalOf('JPY', 1, '0.005', 'EUR').inGroupCurrency('EUR')).toBe(1);
    // 1 euro cent (0.01 euros) at 50 yen per euro is 0.5 yen: a half up is 1 yen.
    expect(originalOf('EUR', 1, '50', 'JPY').inGroupCurrency('JPY')).toBe(1);
  });

  it('between two currencies of hundredths, gives what it gave before (1234 at 1.0625 is 1311)', () => {
    expect(originalOf('USD', 1234, '1.0625', 'EUR').inGroupCurrency('EUR')).toBe(1311);
  });

  it('refuses an amount that is not a whole number of its currency’s minor unit, as before', () => {
    expect(OriginalAmount.create({ currency: 'JPY', amount: 1.5, rate: '1' }, 'EUR', offer).isFailure()).toBe(true);
  });
});
