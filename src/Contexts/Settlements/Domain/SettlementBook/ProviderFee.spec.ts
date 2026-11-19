import { ProviderFee, payerPartOf, settledAmountOf } from './ProviderFee';
import { decideProviderFee, decideSetFeePolicy } from './SettlementBook.decision';

/** Request 38's example: Bob pays Ann 300 through the provider and the provider keeps 31. */
const fee = (borneBy: ProviderFee['borneBy']): ProviderFee => ({ amount: 31, borneBy });

describe('What a settlement through the provider settles (request 38)', () => {
  it('settles its whole amount when the payee bears the fee, the payer still owing none of it', () => {
    expect(settledAmountOf(300, fee('payee'))).toBe(300);
    expect(payerPartOf(fee('payee'))).toBe(0);
  });

  it('settles its amount less the fee when the payer bears it', () => {
    expect(settledAmountOf(300, fee('payer'))).toBe(269);
  });

  it('settles its amount less the payer half when the fee is shared, the payee bearing the extra hundredth of an odd fee', () => {
    expect(settledAmountOf(300, fee('shared'))).toBe(285);
    expect(payerPartOf({ amount: 30, borneBy: 'shared' })).toBe(15);
  });

  it('settles its amount when there is no fee, as a settlement asked for before the fee was known', () => {
    expect(settledAmountOf(300, undefined)).toBe(300);
  });
});

describe('The fee the provider said (request 38)', () => {
  it('keeps a whole fee from 0 up to less than the amount, with who bears it', () => {
    expect(decideProviderFee({ fee: 0, amount: 30, borneBy: 'payer' }).data).toEqual({ amount: 0, borneBy: 'payer' });
    expect(decideProviderFee({ fee: 29, amount: 30, borneBy: 'shared' }).data).toEqual({
      amount: 29,
      borneBy: 'shared',
    });
  });

  it('refuses a fee the provider did not say, one that is not a whole number, a negative one, or one not less than the amount', () => {
    for (const bad of [undefined, 1.5, -1, 30, 31]) {
      const decision = decideProviderFee({ fee: bad, amount: 30, borneBy: 'payee' });
      expect(decision.isFailure()).toBe(true);
    }
  });
});

describe('Who bears the fee, as the owner decides it (request 38)', () => {
  it('lets the owner decide one of the three, and refuses any other member, an archived group, and a value that is none', () => {
    expect(
      decideSetFeePolicy({ ownerId: 'ada', archived: false }, { caller: 'ada', borneBy: 'shared' }, new Date()).data,
    ).toEqual({ state: { borneBy: 'shared' }, facts: [] });
    expect(
      decideSetFeePolicy(
        { ownerId: 'ada', archived: false },
        { caller: 'grace', borneBy: 'payer' },
        new Date(),
      ).isFailure(),
    ).toBe(true);
    expect(
      decideSetFeePolicy(
        { ownerId: 'ada', archived: true },
        { caller: 'ada', borneBy: 'payer' },
        new Date(),
      ).isFailure(),
    ).toBe(true);
    expect(
      decideSetFeePolicy(
        { ownerId: 'ada', archived: false },
        { caller: 'ada', borneBy: 'half' },
        new Date(),
      ).isFailure(),
    ).toBe(true);
  });
});
