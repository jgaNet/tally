import { OriginalAmount } from '@Contexts/Settlements/Domain/Settlement/OriginalAmount';
import {
  InvalidOriginalAmount,
  InvalidOriginalCurrency,
  NoRateOffered,
  SameCurrencyAsGroup,
} from '@Contexts/Settlements/Domain/Settlement/SettlementExceptions';

const offered = (rate: string) => ({ kind: 'offered' as const, rate });

describe('OriginalAmount: a settlement paid in another currency (request 39)', () => {
  it('converts at the rate offered, a half rounded up, in exact integer arithmetic', () => {
    const paid = OriginalAmount.decide({
      currency: 'CHF',
      amount: 2500,
      groupCurrency: 'EUR',
      offer: offered('0.9542'),
    });
    if (paid.isFailure()) throw new Error('the payment must be decided');
    expect(paid.data.amountInGroupCurrency('EUR')).toBe(2386);
    expect(paid.data.snapshot()).toEqual({ currency: 'CHF', amount: 2500, rate: '0.9542' });

    // 1 hundredth at 0.5 is 0.5 of a hundredth: a half, rounded up to 1.
    const half = OriginalAmount.decide({ currency: 'USD', amount: 1, groupCurrency: 'EUR', offer: offered('0.5') });
    if (half.isFailure()) throw new Error('the payment must be decided');
    expect(half.data.amountInGroupCurrency('EUR')).toBe(1);
  });

  it('converts a provider fee by the same rate, a fee of nothing staying nothing', () => {
    const paid = OriginalAmount.decide({
      currency: 'CHF',
      amount: 2500,
      groupCurrency: 'EUR',
      offer: offered('0.9542'),
    });
    if (paid.isFailure()) throw new Error('the payment must be decided');
    expect(paid.data.convert(100, 'EUR')).toBe(95);
    expect(paid.data.convert(0, 'EUR')).toBe(0);
  });

  it('refuses a payment with no rate offered by name, and nothing is decided', () => {
    const none = OriginalAmount.decide({
      currency: 'CHF',
      amount: 2500,
      groupCurrency: 'EUR',
      offer: { kind: 'none' },
    });
    expect(none.isFailure() && none.error).toBeInstanceOf(NoRateOffered);
    const unconfigured = OriginalAmount.decide({
      currency: 'CHF',
      amount: 2500,
      groupCurrency: 'EUR',
      offer: { kind: 'unconfigured' },
    });
    expect(unconfigured.isFailure() && unconfigured.error).toBeInstanceOf(NoRateOffered);
  });

  it("refuses the group's own currency, a currency Tally does not have, and an amount out of range", () => {
    const own = OriginalAmount.decide({ currency: 'EUR', amount: 100, groupCurrency: 'EUR', offer: offered('1') });
    expect(own.isFailure() && own.error).toBeInstanceOf(SameCurrencyAsGroup);
    const unknown = OriginalAmount.decide({ currency: 'XXX', amount: 100, groupCurrency: 'EUR', offer: offered('1') });
    expect(unknown.isFailure() && unknown.error).toBeInstanceOf(InvalidOriginalCurrency);
    const zero = OriginalAmount.decide({ currency: 'CHF', amount: 0, groupCurrency: 'EUR', offer: offered('1') });
    expect(zero.isFailure() && zero.error).toBeInstanceOf(InvalidOriginalAmount);
    const tooMuch = OriginalAmount.decide({
      currency: 'CHF',
      amount: 100_000_001,
      groupCurrency: 'EUR',
      offer: offered('1'),
    });
    expect(tooMuch.isFailure() && tooMuch.error).toBeInstanceOf(InvalidOriginalAmount);
  });
});

describe('OriginalAmount: a settlement in a currency of another precision (request 40)', () => {
  it('converts by what one unit of each is worth, in the minor unit of the group’s currency', () => {
    // 10 000 yen at 0.0062 euros to the yen: 62 euros, so 6200 hundredths.
    const yen = OriginalAmount.decide({
      currency: 'JPY',
      amount: 10000,
      groupCurrency: 'EUR',
      offer: offered('0.0062'),
    });
    if (yen.isFailure()) throw new Error('the payment must be decided');
    expect(yen.data.amountInGroupCurrency('EUR')).toBe(6200);
    // 10 dollars at 0.3075 dinars to the dollar: 3.075 dinars, so 3075 thousandths.
    const dollars = OriginalAmount.decide({
      currency: 'USD',
      amount: 1000,
      groupCurrency: 'KWD',
      offer: offered('0.3075'),
    });
    if (dollars.isFailure()) throw new Error('the payment must be decided');
    expect(dollars.data.amountInGroupCurrency('KWD')).toBe(3075);
  });

  it('converts a provider fee in the payment’s minor unit into the group’s, by the same rate', () => {
    // A fee of one dollar (100 cents) on a payment in dollars at 0.3075 dinars to the dollar: 0.3075 dinars, 307.5 thousandths, so 308.
    const dollars = OriginalAmount.decide({
      currency: 'USD',
      amount: 1000,
      groupCurrency: 'KWD',
      offer: offered('0.3075'),
    });
    if (dollars.isFailure()) throw new Error('the payment must be decided');
    expect(dollars.data.convert(100, 'KWD')).toBe(308);
  });
});
