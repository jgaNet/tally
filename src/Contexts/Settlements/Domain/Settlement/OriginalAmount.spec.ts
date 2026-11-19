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
    expect(paid.data.amountInGroupCurrency()).toBe(2386);
    expect(paid.data.snapshot()).toEqual({ currency: 'CHF', amount: 2500, rate: '0.9542' });

    // 1 hundredth at 0.5 is 0.5 of a hundredth: a half, rounded up to 1.
    const half = OriginalAmount.decide({ currency: 'USD', amount: 1, groupCurrency: 'EUR', offer: offered('0.5') });
    if (half.isFailure()) throw new Error('the payment must be decided');
    expect(half.data.amountInGroupCurrency()).toBe(1);
  });

  it('converts a provider fee by the same rate, a fee of nothing staying nothing', () => {
    const paid = OriginalAmount.decide({
      currency: 'CHF',
      amount: 2500,
      groupCurrency: 'EUR',
      offer: offered('0.9542'),
    });
    if (paid.isFailure()) throw new Error('the payment must be decided');
    expect(paid.data.convert(100)).toBe(95);
    expect(paid.data.convert(0)).toBe(0);
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
    const unknown = OriginalAmount.decide({ currency: 'JPY', amount: 100, groupCurrency: 'EUR', offer: offered('1') });
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
