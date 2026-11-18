import { describe, expect, it } from '@jest/globals';

import { SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';
import {
  InvalidSettlementAmountException,
  MoreThanPayerOwesException,
  NoRateOfferedException,
  OriginalCurrencyIsGroupCurrencyException,
  ProviderUnavailableException,
} from '@Contexts/Settlements/Domain/Settlement/SettlementExceptions';
import { settledAmountOf } from '@Contexts/Settlements/Domain/Settlement/Settlement';
import { PayoutAccount } from '@Contexts/Settlements/Domain/PayoutAccount/PayoutAccount';

const NOW = new Date('2026-04-01T10:00:00.000Z');

const ANN_PAYOUT = PayoutAccount.fromSnapshot({
  id: 'payout-ann',
  version: 1,
  ownerId: 'ann',
  providerAccountId: 'acct-ann',
});

/** Bob owes Ann 1000 euros: the balances add up to 0. */
const book = () =>
  SettlementBook.open({
    currency: 'EUR',
    groupId: 'group-1',
    version: 3,
    members: ['ann', 'bob'],
    balances: [
      { memberId: 'ann', balance: 1000 },
      { memberId: 'bob', balance: -1000 },
    ],
  });

const CHF_AT_1_0625 = { currency: 'CHF', amount: 800, offered: '1.0625' };

describe('a settlement in cash in another currency (request 39)', () => {
  it('converts the amount at the rate offered, counts it in the group’s currency, and keeps the original and the rate', () => {
    const recorded = book().recordCash({ from: 'bob', to: 'ann', original: CHF_AT_1_0625 }, false, false, NOW);
    expect(recorded.data).toMatchObject({
      from: 'bob',
      to: 'ann',
      amount: 850,
      method: 'cash',
      status: 'paid',
      original: { currency: 'CHF', amount: 800, rate: '1.0625' },
    });
    expect(recorded.data?.fee).toBeUndefined();
  });

  it('refuses it when no rate is offered, and keeps nothing', () => {
    const aggregate = book();
    const refused = aggregate.recordCash(
      { from: 'bob', to: 'ann', original: { ...CHF_AT_1_0625, offered: undefined } },
      false,
      false,
      NOW,
    );
    expect(refused.error).toBeInstanceOf(NoRateOfferedException);
    expect(aggregate.pullDomainEvents()).toHaveLength(0);
  });

  it('refuses it when the converted amount is more than is still owed, by the rules of a settlement', () => {
    const refused = book().recordCash(
      { from: 'bob', to: 'ann', original: { currency: 'CHF', amount: 1000, offered: '1.0625' } },
      false,
      false,
      NOW,
    );
    expect(refused.error).toBeInstanceOf(MoreThanPayerOwesException);
  });

  it('refuses a currency that is the group’s own, and a draft with neither an amount nor an original', () => {
    expect(
      book().recordCash(
        { from: 'bob', to: 'ann', original: { currency: 'EUR', amount: 1, offered: '1' } },
        false,
        false,
        NOW,
      ).error,
    ).toBeInstanceOf(OriginalCurrencyIsGroupCurrencyException);
    expect(book().recordCash({ from: 'bob', to: 'ann' }, false, false, NOW).error).toBeInstanceOf(
      InvalidSettlementAmountException,
    );
  });

  it('keeps the amount in the group’s currency with no original when it is paid in the group’s currency', () => {
    const recorded = book().recordCash({ from: 'bob', to: 'ann', amount: 300 }, false, false, NOW);
    expect(recorded.data?.amount).toBe(300);
    expect(recorded.data?.original).toBeUndefined();
  });
});

describe('a payment through the provider in another currency (request 39)', () => {
  it('asks for the original amount, keeps the rate, and converts the fee the provider keeps in that currency', () => {
    const aggregate = book();
    const proposed = aggregate.proposePayment(
      { from: 'bob', to: 'ann', original: CHF_AT_1_0625 },
      ANN_PAYOUT,
      false,
      false,
      NOW,
    ).data!;
    expect(proposed.amount).toBe(850);
    expect(proposed.original?.toRecord()).toEqual({ currency: 'CHF', amount: 800, rate: '1.0625' });

    const recorded = aggregate.recordPayment(
      proposed,
      { id: 'pay-1', payUrl: 'https://pay.example/pay-1', fee: 40 },
      false,
      false,
    );
    expect(recorded.data).toMatchObject({
      status: 'pending',
      amount: 850,
      original: { currency: 'CHF', amount: 800, rate: '1.0625' },
      fee: { amount: 43, borneBy: 'payee' },
    });
    expect(settledAmountOf(recorded.data!)).toBe(850);
  });

  it('refuses a fee the provider keeps that is not less than the amount paid in its currency', () => {
    const aggregate = book();
    const proposed = aggregate.proposePayment(
      { from: 'bob', to: 'ann', original: CHF_AT_1_0625 },
      ANN_PAYOUT,
      false,
      false,
      NOW,
    ).data!;
    const refused = aggregate.recordPayment(
      proposed,
      { id: 'pay-1', payUrl: 'https://pay.example/pay-1', fee: 80_000 },
      false,
      false,
    );
    expect(refused.error).toBeInstanceOf(ProviderUnavailableException);
  });

  it('refuses it when no rate is offered, before any payment is proposed', () => {
    const refused = book().proposePayment(
      { from: 'bob', to: 'ann', original: { ...CHF_AT_1_0625, offered: undefined } },
      ANN_PAYOUT,
      false,
      false,
      NOW,
    );
    expect(refused.error).toBeInstanceOf(NoRateOfferedException);
  });
});
