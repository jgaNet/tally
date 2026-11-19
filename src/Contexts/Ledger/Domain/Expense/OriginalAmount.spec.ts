import { OriginalAmount } from '@Contexts/Ledger/Domain/Expense/OriginalAmount';
import { RateOffer } from '@Contexts/Ledger/Domain/Expense/RateOffer';

/** A server started without a rates service: the payer's rate stands, as it is given. */
const NO_SERVICE: RateOffer = { kind: 'no-service' };
const NONE: RateOffer = { kind: 'none' };
const offered = (rate: string): RateOffer => ({ kind: 'offered', rate });

const paid = (currency: string, amount: number, rate: string, offer: RateOffer | null = NO_SERVICE) =>
  OriginalAmount.create({ currency, amount, rate }, 'EUR', offer);

describe('OriginalAmount, converted into the group currency', () => {
  it('computes the amount times the rate, rounded to the nearest whole number, a half up, in exact arithmetic', () => {
    expect((paid('CHF', 1234, '1.0625').data as OriginalAmount).groupAmount('EUR')).toBe(1311);
    expect((paid('CHF', 1000, '0.9545').data as OriginalAmount).groupAmount('EUR')).toBe(955);
    expect((paid('USD', 1000, '0.9542').data as OriginalAmount).groupAmount('EUR')).toBe(954);
    expect((paid('USD', 5, '0.5').data as OriginalAmount).groupAmount('EUR')).toBe(3);
    expect((paid('USD', 1, '0.5').data as OriginalAmount).groupAmount('EUR')).toBe(1);
    expect((paid('GBP', 100, '12.5').data as OriginalAmount).groupAmount('EUR')).toBe(1250);
    expect((paid('GBP', 3, '0.333333').data as OriginalAmount).groupAmount('EUR')).toBe(1);
  });

  it('keeps the currency, the amount and the rate exactly as given, the rate as its string', () => {
    const original = paid('AUD', 2500, '1') as { data: OriginalAmount };
    expect(original.data.value).toEqual({ currency: 'AUD', amount: 2500, rate: '1', rateSource: 'stated' });
  });

  it('refuses a currency that is not Tally’s, or the group’s own, an amount out of range, and a rate that is not valid', () => {
    expect(paid('XXX', 100, '1')).toMatchObject({ error: { type: 'InvalidOriginalCurrency' } });
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

describe('OriginalAmount, its rate settled against the offer (request 22)', () => {
  it('takes the offered rate when the rate is left out, and keeps it as the service gave it, from the offer', () => {
    const taken = OriginalAmount.create({ currency: 'USD', amount: 1000 }, 'EUR', offered('0.95'));
    expect(taken.data).toBeInstanceOf(OriginalAmount);
    expect((taken.data as OriginalAmount).value).toEqual({
      currency: 'USD',
      amount: 1000,
      rate: '0.95',
      rateSource: 'offered',
    });
    expect((taken.data as OriginalAmount).groupAmount('EUR')).toBe(950);
  });

  it('refuses a rate left out when no rate is offered, or the service is not there to offer one', () => {
    const left = (offer: RateOffer | null) => OriginalAmount.create({ currency: 'USD', amount: 1000 }, 'EUR', offer);
    expect(left(NONE)).toMatchObject({ error: { type: 'NoRateOffered' } });
    expect(left(NO_SERVICE)).toMatchObject({ error: { type: 'NoRateOffered' } });
    expect(left(null)).toMatchObject({ error: { type: 'NoRateOffered' } });
  });

  it('takes a stated rate within 2 % of the offer, the boundary included, and refuses one beyond it', () => {
    for (const rate of ['0.931', '0.969', '0.95', '0.9405', '0.9595']) {
      expect(paid('USD', 1000, rate, offered('0.95')).isSuccess()).toBe(true);
    }
    for (const rate of ['0.93', '0.97', '0.9', '1']) {
      expect(paid('USD', 1000, rate, offered('0.95'))).toMatchObject({ error: { type: 'RateOutsideBand' } });
    }
  });

  it('takes a stated rate as it is given when there is no rates service, whatever it is', () => {
    expect((paid('USD', 1000, '3', NO_SERVICE).data as OriginalAmount).value.rate).toBe('3');
  });

  it('refuses a stated rate when the service offers none for its currency and day', () => {
    expect(paid('USD', 1000, '0.95', NONE)).toMatchObject({ error: { type: 'NoRateOffered' } });
    expect(paid('USD', 1000, '0.95', null)).toMatchObject({ error: { type: 'NoRateOffered' } });
  });

  it('refuses an offer that is not a rate as no offer', () => {
    expect(paid('USD', 1000, '0.95', offered('abc'))).toMatchObject({ error: { type: 'NoRateOffered' } });
  });

  it('keeps the source of the rate, and restores it as it was', () => {
    const taken = OriginalAmount.create({ currency: 'USD', amount: 1000 }, 'EUR', offered('0.95'))
      .data as OriginalAmount;
    expect(OriginalAmount.restore({ ...taken.value })?.value).toEqual(taken.value);
  });
});
