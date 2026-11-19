import { OriginalPayment } from '@Contexts/Settlements/Domain/Settlement/OriginalPayment';

const offered = (rate: string) => ({ kind: 'offered' as const, rate });

describe("what a settlement is paid in, another currency than the group's (request 39)", () => {
  it('converts an amount at the rate, to the nearest whole number, a half up, as an expense does', () => {
    const original = OriginalPayment.decide({ currency: 'USD', amount: 1000 }, 'EUR', offered('0.9545'));
    expect(original.isSuccess()).toBe(true);
    // 1000 at 0.9545 is 954.5, which is 955: the half is rounded up, computed in integers.
    expect(original.isSuccess() && original.data.groupAmountOf(1000, 'EUR')).toBe(955);
    expect(original.isSuccess() && original.data.toSnapshot()).toEqual({
      currency: 'USD',
      amount: 1000,
      rate: '0.9545',
    });
  });

  it('converts a fee at the same rate, the same way', () => {
    const original = OriginalPayment.decide({ currency: 'CHF', amount: 10000 }, 'EUR', offered('0.95'));
    if (original.isFailure()) throw original.error;
    expect(original.data.groupAmountOf(300, 'EUR')).toBe(285);
    expect(original.data.groupAmountOf(0, 'EUR')).toBe(0);
    // A rate of a whole number of 6 digits after the point is exact.
    const whole = OriginalPayment.decide({ currency: 'GBP', amount: 7 }, 'EUR', offered('2'));
    if (whole.isFailure()) throw whole.error;
    expect(whole.data.groupAmountOf(7, 'EUR')).toBe(14);
  });

  it('refuses a currency that is not one of Tally', () => {
    const refused = OriginalPayment.decide({ currency: 'XXX', amount: 100 }, 'EUR', offered('1'));
    expect(refused.error?.type).toBe('UnknownCurrency');
  });

  it("refuses the group's own currency: that is given as its amount", () => {
    const refused = OriginalPayment.decide({ currency: 'EUR', amount: 100 }, 'EUR', offered('1'));
    expect(refused.error?.type).toBe('OriginalCurrencyIsGroupCurrency');
  });

  it('refuses an amount that is not a whole number of 1 to 100 000 000 hundredths', () => {
    for (const amount of [0, -5, 1.5, 100_000_001]) {
      const refused = OriginalPayment.decide({ currency: 'CHF', amount }, 'EUR', offered('0.95'));
      expect(refused.error?.type).toBe('InvalidOriginalAmount');
    }
    expect(OriginalPayment.decide({ currency: 'CHF', amount: 100_000_000 }, 'EUR', offered('0.95')).isSuccess()).toBe(
      true,
    );
  });

  it('refuses when no rate is offered, or the one offered cannot be used', () => {
    expect(OriginalPayment.decide({ currency: 'CHF', amount: 100 }, 'EUR', { kind: 'none' }).error?.type).toBe(
      'NoRateOffered',
    );
    for (const rate of ['0', '0.000000', '-1', '1e3', '1.1234567', '']) {
      expect(OriginalPayment.decide({ currency: 'CHF', amount: 100 }, 'EUR', offered(rate)).error?.type).toBe(
        'NoRateOffered',
      );
    }
  });
});
