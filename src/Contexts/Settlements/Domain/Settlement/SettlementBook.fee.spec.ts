import { describe, expect, it } from '@jest/globals';

import { FeePolicySetEvent, SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';
import {
  InvalidFeeBearerException,
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

/** Bob owes Ann 1000 (Ann is owed 1000): the balances add up to 0, members in the order they joined. */
const book = (feePolicy?: 'payer' | 'payee' | 'shared') =>
  SettlementBook.open({
    groupId: 'group-1',
    version: 3,
    members: ['ann', 'bob'],
    balances: [
      { memberId: 'ann', balance: 1000 },
      { memberId: 'bob', balance: -1000 },
    ],
    ...(feePolicy && { feePolicy }),
  });

const proposalOf = (aggregate: SettlementBook, amount = 300) =>
  aggregate.proposePayment({ from: 'bob', to: 'ann', amount }, ANN_PAYOUT, false, false, NOW).data!;

describe('a provider fee, borne as the group decided (request 38)', () => {
  it('is the payee, until the owner decides', () => {
    expect(book().feePolicy).toBe('payee');
  });

  it('is fixed with the payment when it is asked for, and settles what the bearer leaves', () => {
    const cases = [
      { policy: 'payee' as const, settles: 300 },
      { policy: 'payer' as const, settles: 269 },
      { policy: 'shared' as const, settles: 285 },
    ];
    for (const { policy, settles } of cases) {
      const aggregate = book(policy);
      const recorded = aggregate.recordPayment(
        proposalOf(aggregate),
        { id: 'pay-1', payUrl: 'https://pay.example/pay-1', fee: 31 },
        false,
        false,
      );
      expect(recorded.data?.fee).toEqual({ amount: 31, borneBy: policy });
      expect(recorded.data?.amount).toBe(300);
      expect(settledAmountOf(recorded.data!)).toBe(settles);
    }
  });

  it('splits an odd fee shared with the payee bearing the extra hundredth', () => {
    const aggregate = book('shared');
    const recorded = aggregate.recordPayment(
      proposalOf(aggregate),
      { id: 'pay-1', payUrl: 'https://pay.example/pay-1', fee: 1 },
      false,
      false,
    );
    expect(settledAmountOf(recorded.data!)).toBe(300);
  });

  it('refuses an answer whose fee is missing, negative, not whole, or not less than the amount, and keeps nothing', () => {
    const aggregate = book('payer');
    const proposal = proposalOf(aggregate);
    const bad = [-1, 1.5, 300, 301] as const;
    for (const fee of bad) {
      const result = aggregate.recordPayment(
        proposal,
        { id: 'pay-1', payUrl: 'https://pay.example/pay-1', fee },
        false,
        false,
      );
      expect(result.error).toBeInstanceOf(ProviderUnavailableException);
    }
    expect(aggregate.pullDomainEvents()).toHaveLength(0);
  });

  it('records the owner decision as FeePolicySet, and refuses a bearer that is none of the three', () => {
    const aggregate = book();
    expect(aggregate.setFeePolicy('nobody', false, NOW).error).toBeInstanceOf(InvalidFeeBearerException);
    expect(aggregate.feePolicy).toBe('payee');

    expect(aggregate.setFeePolicy('shared', false, NOW).data).toBe('shared');
    expect(aggregate.feePolicy).toBe('shared');
    const events = aggregate.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toBeInstanceOf(FeePolicySetEvent);
  });
});
