import { OriginalAmount } from '@Contexts/Ledger/Domain/Expense/OriginalAmount';
import { RateOffer } from '@Contexts/Ledger/Domain/Expense/RateOffer';

/** No rates service is configured: the payer's rate is taken as it is (request 21). */
const UNCONFIGURED: RateOffer = { kind: 'unconfigured' };
const offered = (rate: string): RateOffer => ({ kind: 'offered', rate });

const original = (overrides: Partial<{ currency: string; amount: number; rate: string }> = {}) => ({
  currency: 'CHF',
  amount: 1234,
  rate: '1.0625',
  ...overrides,
});

/** The original amount of a request, which the test means to be valid: a refusal here is a failure of the test. */
function valid(request: ReturnType<typeof original>, groupCurrency: string): OriginalAmount {
  const created = OriginalAmount.create(request, groupCurrency, UNCONFIGURED);
  if (created.isFailure()) throw new Error(created.error.type);
  return created.data;
}

describe('OriginalAmount.inGroupCurrency', () => {
  it('is the original amount times the rate, rounded to the nearest whole number, a half rounded up (request 21)', () => {
    // 1234 at 1.0625 is 1311.125, so 1311; 1000 at 0.9545 is 954.5, so 955: the half goes up.
    expect(valid(original(), 'EUR').inGroupCurrency()).toBe(1311);
    expect(valid(original({ amount: 1000, rate: '0.9545' }), 'EUR').inGroupCurrency()).toBe(955);
    expect(valid(original({ amount: 1, rate: '0.5' }), 'EUR').inGroupCurrency()).toBe(1);
    expect(valid(original({ amount: 1, rate: '0.499999' }), 'EUR').inGroupCurrency()).toBe(0);
  });

  it('computes in exact decimal arithmetic, so that no float rounding moves a half', () => {
    // 0.1 + 0.2 style errors would move 1.15 * 100 off the half; the rate is counted in millionths instead.
    expect(valid(original({ amount: 115, rate: '1.000001' }), 'EUR').inGroupCurrency()).toBe(115);
    expect(valid(original({ amount: 5_000_000, rate: '0.000001' }), 'EUR').inGroupCurrency()).toBe(5);
  });

  it('keeps the currency, the amount and the rate exactly as they were given, the rate as the same string', () => {
    const kept = OriginalAmount.create(original({ rate: '12.5' }), 'EUR', UNCONFIGURED);
    expect(kept.isSuccess()).toBe(true);
    if (kept.isFailure()) return;
    expect(kept.data.toSnapshot()).toEqual({ currency: 'CHF', amount: 1234, rate: '12.5' });
    expect(valid(original({ rate: '1' }), 'EUR').toSnapshot().rate).toBe('1');
  });
});

describe('OriginalAmount.create refusals', () => {
  it.each([
    ['a currency that is not Tally’s', original({ currency: 'JPY' }), 'InvalidOriginalCurrency'],
    ['the group’s own currency', original({ currency: 'EUR' }), 'InvalidOriginalCurrency'],
    ['an amount of 0', original({ amount: 0 }), 'InvalidOriginalAmount'],
    ['an amount above 100 000 000', original({ amount: 100_000_001 }), 'InvalidOriginalAmount'],
    ['a fraction of an amount', original({ amount: 12.5 }), 'InvalidOriginalAmount'],
    ['a rate of 0', original({ rate: '0' }), 'InvalidRate'],
    ['a rate with 7 digits after the point', original({ rate: '1.0000001' }), 'InvalidRate'],
    ['a rate with no digit before the point', original({ rate: '.5' }), 'InvalidRate'],
    ['a rate with a sign', original({ rate: '-1' }), 'InvalidRate'],
    ['a rate in exponent form', original({ rate: '1e3' }), 'InvalidRate'],
  ])('refuses %s by name', (_, request, type) => {
    const refused = OriginalAmount.create(request, 'EUR', UNCONFIGURED);
    expect(refused.isFailure()).toBe(true);
    if (refused.isSuccess()) return;
    expect(refused.error.type).toBe(type);
  });
});

describe('OriginalAmount.create: the rate offered (request 22)', () => {
  /** A request with its rate left out (request 22). */
  const left = (overrides: Partial<{ currency: string; amount: number }> = {}) => ({
    currency: 'CHF',
    amount: 1234,
    ...overrides,
  });

  it('takes the offered rate when the rate is left out, and keeps it as the same string', () => {
    const taken = OriginalAmount.create(left({ amount: 1000, currency: 'USD' }), 'EUR', offered('0.95'));
    expect(taken.isSuccess()).toBe(true);
    if (taken.isFailure()) return;
    expect(taken.data.toSnapshot()).toEqual({ currency: 'USD', amount: 1000, rate: '0.95' });
    expect(taken.data.inGroupCurrency()).toBe(950);
  });

  it('takes a stated rate within 2 % of the offered one, both ends included (0.95 offered)', () => {
    for (const stated of ['0.931', '0.969', '0.95']) {
      const taken = OriginalAmount.create(original({ currency: 'USD', rate: stated }), 'EUR', offered('0.95'));
      expect(taken.isSuccess()).toBe(true);
    }
  });

  it('refuses by name a stated rate more than 2 % from the offered one (0.95 offered)', () => {
    for (const stated of ['0.93', '0.97']) {
      const refused = OriginalAmount.create(original({ currency: 'USD', rate: stated }), 'EUR', offered('0.95'));
      expect(refused.isFailure() && refused.error.type).toBe('RateOutsideBand');
    }
  });

  it('refuses by name a left-out rate when no rate is offered, and a stated one too', () => {
    for (const offer of [{ kind: 'none' } as const, null]) {
      const left_ = OriginalAmount.create(left({ currency: 'USD' }), 'EUR', offer);
      const stated = OriginalAmount.create(original({ currency: 'USD', rate: '0.95' }), 'EUR', offer);
      expect(left_.isFailure() && left_.error.type).toBe('NoRateOffered');
      expect(stated.isFailure() && stated.error.type).toBe('NoRateOffered');
    }
  });

  it('takes the stated rate, whatever it is, when no rates service is configured', () => {
    const taken = OriginalAmount.create(original({ rate: '9.5' }), 'EUR', UNCONFIGURED);
    expect(taken.isSuccess() && taken.data.rate).toBe('9.5');
  });

  it('still refuses a stated rate of the wrong shape before it compares it', () => {
    const refused = OriginalAmount.create(original({ rate: '0.95000001' }), 'EUR', offered('0.95'));
    expect(refused.isFailure() && refused.error.type).toBe('InvalidRate');
  });
});
