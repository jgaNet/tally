import { OriginalAmount } from '@Contexts/Settlements/Domain/Settlement/OriginalAmount';
import { RateOffer } from '@Contexts/Settlements/Domain/Settlement/RateOffer';

const offered = (rate: string): RateOffer => ({ kind: 'offered', rate });

describe('OriginalAmount, what a settlement paid in another currency is (request 39)', () => {
  it('converts the original amount at the rate offered, a half rounded up, in exact arithmetic', () => {
    const amount = OriginalAmount.create({ currency: 'CHF', amount: 1234 }, 'EUR', offered('1.0625'));
    expect(amount.isSuccess() && amount.data.groupAmount()).toBe(1311);

    const half = OriginalAmount.create({ currency: 'CHF', amount: 1000 }, 'EUR', offered('0.9545'));
    expect(half.isSuccess() && half.data.groupAmount()).toBe(955);
  });

  it('keeps the currency, the amount and the rate as the service wrote it', () => {
    const amount = OriginalAmount.create({ currency: 'USD', amount: 500 }, 'EUR', offered('0.930000'));
    expect(amount.isSuccess() && amount.data.toSnapshot()).toEqual({ currency: 'USD', amount: 500, rate: '0.930000' });
  });

  it('converts a fee in the same currency at the same rate, a half rounded up', () => {
    const amount = OriginalAmount.create({ currency: 'CHF', amount: 3000 }, 'EUR', offered('0.93'));
    expect(amount.isSuccess() && amount.data.convert(100)).toBe(93);
    expect(amount.isSuccess() && amount.data.convert(1)).toBe(1);
  });

  it('refuses a currency that is not one of Tally’s, or the group’s own', () => {
    for (const currency of ['XYZ', 'eur', 'EUR']) {
      const refused = OriginalAmount.create({ currency, amount: 100 }, 'EUR', offered('1'));
      expect(refused.isFailure() && refused.error.type).toBe('InvalidOriginalCurrency');
    }
  });

  it('refuses an amount that is not a whole number from 1 to 100 000 000 hundredths', () => {
    for (const amount of [0, -1, 1.5, 100_000_001]) {
      const refused = OriginalAmount.create({ currency: 'CHF', amount }, 'EUR', offered('1'));
      expect(refused.isFailure() && refused.error.type).toBe('InvalidOriginalAmount');
    }
    const largest = OriginalAmount.create({ currency: 'CHF', amount: 100_000_000 }, 'EUR', offered('1'));
    expect(largest.isSuccess()).toBe(true);
  });

  it('refuses by name when no rate is offered: no answer, no service, or a rate that is not a rate', () => {
    for (const offer of [{ kind: 'none' }, { kind: 'unconfigured' }, offered('0')] as RateOffer[]) {
      const refused = OriginalAmount.create({ currency: 'CHF', amount: 100 }, 'EUR', offer);
      expect(refused.isFailure() && refused.error.type).toBe('NoRateOffered');
    }
  });
});
