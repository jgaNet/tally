import { OriginalAmount } from '@Contexts/Settlements/Domain/Settlement/OriginalAmount';

/** A settlement paid in another currency is counted in the group's minor unit, whatever the currencies (request 40, ADR 25). */
const offered = (rate: string) => ({ kind: 'offered' as const, rate });
const paid = (currency: string, amount: number, rate: string, group: string) => {
  const created = OriginalAmount.create({ currency, amount }, group, offered(rate));
  if (created.isFailure()) throw created.error;
  return created.data;
};

describe('a settlement paid in another currency, in the minor unit of each (request 40)', () => {
  it('counts 12.50 euros in a yen group as 2019 yen, and 10 dollars in a dinar group as 3075 thousandths', () => {
    expect(paid('EUR', 1250, '161.5', 'JPY').groupAmount()).toBe(2019);
    expect(paid('USD', 1000, '0.3075', 'KWD').groupAmount()).toBe(3075);
  });

  it('counts 10 000 yen in a euro group as 6200 cents', () => {
    expect(paid('JPY', 10000, '0.0062', 'EUR').groupAmount()).toBe(6200);
  });

  it('converts a fee the provider gives in the payment’s currency, in that currency’s minor unit, into the group’s', () => {
    // 1 000 yen of fee, paid in euros at 0.0062 euros per yen: 6.2 euros, so 620 cents.
    expect(paid('JPY', 10000, '0.0062', 'EUR').convert(1000)).toBe(620);
  });
});
