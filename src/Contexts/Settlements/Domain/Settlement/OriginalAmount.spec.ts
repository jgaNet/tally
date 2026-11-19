import { OriginalAmount } from '@Contexts/Settlements/Domain/Settlement/OriginalAmount';
import {
  InvalidOriginalAmount,
  InvalidOriginalCurrency,
  NoRateOffered,
  SameCurrencyAsTheGroup,
} from '@Contexts/Settlements/Domain/Settlement/SettlementExceptions';

describe('OriginalAmount (request 39)', () => {
  const create = (amount: number, rate: string | null, currency = 'CHF', group = 'EUR') =>
    OriginalAmount.create({ currency, amount }, group, rate);

  it('converts the amount at the rate to the nearest whole number, a half up, in exact arithmetic', () => {
    // 1000 at 0.9545 is 954.5, and so 955.
    expect(create(1000, '0.9545').data?.inGroupCurrency(1000)).toBe(955);
    // 1234 at 1.0625 is 1311.125, and so 1311.
    expect(create(1234, '1.0625').data?.inGroupCurrency(1234)).toBe(1311);
    // 3000 at 0.95 is 2850 exactly.
    expect(create(3000, '0.95').data?.inGroupCurrency(3000)).toBe(2850);
  });

  it('converts a fee the same way, in the payment’s currency', () => {
    const original = create(2000, '1.10').data as OriginalAmount;
    expect(original.inGroupCurrency(101)).toBe(111);
  });

  it('keeps the currency, the amount and the rate as they were given', () => {
    const original = create(3000, '0.95').data as OriginalAmount;
    expect(original).toMatchObject({ currency: 'CHF', amount: 3000, rate: '0.95' });
  });

  it('refuses a currency Tally does not count in, the group’s own currency, an amount out of range, and no rate', () => {
    expect(create(100, '1', 'JPY').error).toBeInstanceOf(InvalidOriginalCurrency);
    expect(create(100, '1', 'EUR').error).toBeInstanceOf(SameCurrencyAsTheGroup);
    expect(create(0, '1').error).toBeInstanceOf(InvalidOriginalAmount);
    expect(create(100_000_001, '1').error).toBeInstanceOf(InvalidOriginalAmount);
    expect(create(100, null).error).toBeInstanceOf(NoRateOffered);
    expect(create(100, '0').error).toBeInstanceOf(NoRateOffered);
    expect(create(100, '1.2345678').error).toBeInstanceOf(NoRateOffered);
  });

  it('restores what was kept, and refuses what cannot have been kept', () => {
    expect(OriginalAmount.restore({ currency: 'USD', amount: 2000, rate: '1.10' })?.inGroupCurrency(2000)).toBe(2200);
    expect(OriginalAmount.restore({ currency: 'XXX', amount: 2000, rate: '1.10' })).toBeNull();
  });
});
