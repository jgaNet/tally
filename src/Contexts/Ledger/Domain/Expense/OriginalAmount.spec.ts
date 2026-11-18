import { OriginalAmount } from '@Contexts/Ledger/Domain/Expense/OriginalAmount';

const original = (overrides: Partial<{ currency: string; amount: number; rate: string }> = {}) => ({
  currency: 'CHF',
  amount: 1234,
  rate: '1.0625',
  ...overrides,
});

/** The original amount of a request, which the test means to be valid: a refusal here is a failure of the test. */
function valid(request: ReturnType<typeof original>, groupCurrency: string): OriginalAmount {
  const created = OriginalAmount.create(request, groupCurrency);
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
    const kept = OriginalAmount.create(original({ rate: '12.5' }), 'EUR');
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
    const refused = OriginalAmount.create(request, 'EUR');
    expect(refused.isFailure()).toBe(true);
    if (refused.isSuccess()) return;
    expect(refused.error.type).toBe(type);
  });
});
