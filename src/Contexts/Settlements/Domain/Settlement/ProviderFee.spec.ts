import { payerShareOfFee, settledAmountOf } from '@Contexts/Settlements/Domain/Settlement/ProviderFee';

describe('who bears the provider fee (request 38)', () => {
  it('settles the whole amount when the payee bears the fee, the payer none of it', () => {
    expect(settledAmountOf({ amount: 300, fee: 31, borneBy: 'payee' })).toBe(300);
  });

  it('settles the amount less the fee when the payer bears it, the payer still owing the fee', () => {
    expect(settledAmountOf({ amount: 300, fee: 31, borneBy: 'payer' })).toBe(269);
  });

  it('splits the fee in halves when shared, the payee bearing the extra hundredth of an odd fee', () => {
    expect(payerShareOfFee(31, 'shared')).toBe(15);
    expect(settledAmountOf({ amount: 300, fee: 31, borneBy: 'shared' })).toBe(285);
    expect(payerShareOfFee(30, 'shared')).toBe(15);
  });

  it('settles nothing less for a fee of 0, whoever bears it', () => {
    for (const borneBy of ['payer', 'payee', 'shared'] as const) {
      expect(settledAmountOf({ amount: 30, fee: 0, borneBy })).toBe(30);
    }
  });
});
