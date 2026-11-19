import { convertAtRate } from '@SharedKernel/Domain';

import { decideProviderFee, decideRecordCashSettlement, decideRequestProviderPayment } from './SettlementBook.decision';

/** A settlement paid in another currency (request 39): the rate is the one offered, and the amount is the original times it, half up. */
const at = new Date('2026-01-01T00:00:00Z');
const members = ['ada', 'grace'];
const balances = new Map([
  ['ada', 30],
  ['grace', -30],
]);
const given = (offeredRate: string | undefined = '1.03') => ({
  archived: false,
  suspended: false,
  memberIds: members,
  balances,
  groupCurrency: 'EUR',
  offeredRate,
});
const refusedBy = (decision: { error?: unknown }) => (decision.error as { type: string }).type;

describe('the amount of a settlement in another currency (request 39)', () => {
  it('rounds the original amount times the rate to the nearest whole number, a half up, as an expense does', () => {
    expect(convertAtRate(5, '0.5', 'USD', 'EUR')).toBe(3);
    expect(convertAtRate(4, '0.5', 'USD', 'EUR')).toBe(2);
    expect(convertAtRate(29, '1.03', 'USD', 'EUR')).toBe(30);
    expect(convertAtRate(1, '0.000001', 'USD', 'EUR')).toBe(0);
  });

  it('is decided at the offered rate, and keeps the rate and both amounts', () => {
    const decision = decideRecordCashSettlement(
      given('1.03'),
      { payee: 'ada', from: 'grace', original: { currency: 'CHF', amount: 29 } },
      at,
    );
    expect(decision.isFailure()).toBe(false);
    expect(decision.data!.state).toEqual({
      from: 'grace',
      to: 'ada',
      amount: 30,
      original: { currency: 'CHF', amount: 29, rate: '1.03' },
    });
  });

  it('refuses a settlement when no rate is offered, by its name', () => {
    const decision = decideRecordCashSettlement(
      { ...given(), offeredRate: undefined },
      { payee: 'ada', from: 'grace', original: { currency: 'CHF', amount: 29 } },
      at,
    );
    expect(decision.isFailure()).toBe(true);
    expect(refusedBy(decision)).toBe('NoRateOffered');
  });

  it('refuses an offered rate that is not a rate', () => {
    const decision = decideRecordCashSettlement(
      given('0'),
      { payee: 'ada', from: 'grace', original: { currency: 'CHF', amount: 29 } },
      at,
    );
    expect(refusedBy(decision)).toBe('NoRateOffered');
  });

  it("refuses the group currency, a currency that is not Tally's, and an amount out of its range", () => {
    const sameCurrency = decideRecordCashSettlement(
      given(),
      { payee: 'ada', from: 'grace', original: { currency: 'EUR', amount: 29 } },
      at,
    );
    expect(refusedBy(sameCurrency)).toBe('OriginalCurrencyIsGroupCurrency');

    const unknownCurrency = decideRecordCashSettlement(
      given(),
      { payee: 'ada', from: 'grace', original: { currency: 'CNY', amount: 29 } },
      at,
    );
    expect(refusedBy(unknownCurrency)).toBe('InvalidOriginalCurrency');

    for (const amount of [0, 100_000_001, 1.5]) {
      const decision = decideRecordCashSettlement(
        given(),
        { payee: 'ada', from: 'grace', original: { currency: 'CHF', amount } },
        at,
      );
      expect(refusedBy(decision)).toBe('InvalidOriginalAmount');
    }
  });

  it('refuses a body with neither an amount nor an original payment, or with both', () => {
    const neither = decideRecordCashSettlement(given(), { payee: 'ada', from: 'grace' }, at);
    expect(refusedBy(neither)).toBe('InvalidSettlementAmount');

    const both = decideRecordCashSettlement(
      given(),
      { payee: 'ada', from: 'grace', amount: 30, original: { currency: 'CHF', amount: 29 } },
      at,
    );
    expect(refusedBy(both)).toBe('InvalidSettlementAmount');
  });

  it('applies the rules of a settlement to the amount in the group currency, after the conversion', () => {
    // 30 CHF at 1.03 is 31 in the group currency: more than the 30 grace owes.
    const more = decideRecordCashSettlement(
      given('1.03'),
      { payee: 'ada', from: 'grace', original: { currency: 'CHF', amount: 30 } },
      at,
    );
    expect(refusedBy(more)).toBe('SettlementMoreThanOwed');

    // 1 CHF at 0.1 is 0 in the group currency: nothing to settle.
    const nothing = decideRecordCashSettlement(
      given('0.1'),
      { payee: 'ada', from: 'grace', original: { currency: 'CHF', amount: 1 } },
      at,
    );
    expect(refusedBy(nothing)).toBe('InvalidSettlementAmount');
  });
});

describe('a payment through the provider in another currency (request 39)', () => {
  it('is decided at the offered rate and keeps it, and refuses one with no rate offered before anything is kept', () => {
    const granted = decideRequestProviderPayment(
      { ...given('1.03'), payeeAccount: 'acct_ada', deleted: false },
      { payer: 'grace', to: 'ada', original: { currency: 'CHF', amount: 29 } },
      at,
    );
    expect(granted.isFailure()).toBe(false);
    expect(granted.data!.state).toMatchObject({
      from: 'grace',
      to: 'ada',
      amount: 30,
      original: { currency: 'CHF', amount: 29, rate: '1.03' },
      payeeAccount: 'acct_ada',
    });

    const refused = decideRequestProviderPayment(
      { ...{ ...given(), offeredRate: undefined }, payeeAccount: 'acct_ada', deleted: false },
      { payer: 'grace', to: 'ada', original: { currency: 'CHF', amount: 29 } },
      at,
    );
    expect(refusedBy(refused)).toBe('NoRateOffered');
  });
});

describe('the provider fee of a settlement in another currency (request 39)', () => {
  it('is converted at the settlement rate, as its amount is, and refused as the fee of the payment when it is not less than it', () => {
    expect(
      decideProviderFee({ fee: 10, amount: 29, borneBy: 'payer', conversion: { rate: '1.5', from: 'USD', to: 'EUR' } })
        .data,
    ).toEqual({
      amount: 15,
      borneBy: 'payer',
    });
    expect(
      decideProviderFee({ fee: 2, amount: 29, borneBy: 'payee', conversion: { rate: '1.03', from: 'USD', to: 'EUR' } })
        .data,
    ).toEqual({
      amount: 2,
      borneBy: 'payee',
    });
    expect(
      decideProviderFee({
        fee: 29,
        amount: 29,
        borneBy: 'payee',
        conversion: { rate: '1.03', from: 'USD', to: 'EUR' },
      }).isFailure(),
    ).toBe(true);
  });

  it('keeps a fee in the group currency as it was said when there is no rate', () => {
    expect(decideProviderFee({ fee: 9, amount: 60, borneBy: 'shared' }).data).toEqual({ amount: 9, borneBy: 'shared' });
  });
});
