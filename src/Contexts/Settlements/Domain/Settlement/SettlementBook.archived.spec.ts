import { describe, expect, it } from '@jest/globals';

import { GroupArchivedException } from '@SharedKernel/Domain';
import { PayoutAccount } from '@Contexts/Settlements/Domain/PayoutAccount/PayoutAccount';
import { SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';
import { Settlement } from '@Contexts/Settlements/Domain/Settlement/Settlement';

const NOW = new Date('2026-03-01T10:00:00.000Z');

/** Ann is owed 1000 by Bob; Cy owes 500 and Dan 500. Members in the order they joined. */
const book = () =>
  SettlementBook.open({
    groupId: 'group-1',
    version: 0,
    members: ['ann', 'bob', 'cy', 'dan'],
    balances: [
      { memberId: 'ann', balance: 1000 },
      { memberId: 'bob', balance: -1000 },
      { memberId: 'cy', balance: -500 },
      { memberId: 'dan', balance: -500 },
    ],
  });

const ANN_PAYOUT = { providerAccountId: 'acct_ann' } as unknown as PayoutAccount;

/** A settlement from Bob to Ann through the provider, paid. */
const paid = (): Settlement => ({
  id: 's-1',
  groupId: 'group-1',
  from: 'bob',
  to: 'ann',
  amount: 400,
  method: 'provider',
  status: 'paid',
  at: NOW.toISOString(),
  payment: { id: 'pay-1', payUrl: 'https://pay.example/pay-1' },
});

describe('an archived group changes nothing in its settlement book (feature 27)', () => {
  it('refuses a cash settlement by GroupArchived, and records nothing', () => {
    const aggregate = book();

    const refused = aggregate.recordCash({ from: 'bob', to: 'ann', amount: 400 }, true, false, NOW);

    expect(refused.error).toBeInstanceOf(GroupArchivedException);
    expect(refused.error?.type).toBe('GroupArchived');
    expect(aggregate.pullDomainEvents()).toEqual([]);
  });

  it('refuses a payment request by GroupArchived before the provider is asked', () => {
    const aggregate = book();

    const refused = aggregate.proposePayment({ from: 'bob', to: 'ann', amount: 400 }, ANN_PAYOUT, true, false, NOW);

    expect(refused.error).toBeInstanceOf(GroupArchivedException);
    expect(aggregate.pullDomainEvents()).toEqual([]);
  });

  it('refuses the kept payment by GroupArchived, and keeps nothing', () => {
    const aggregate = book();
    const proposal = aggregate.proposePayment(
      { from: 'bob', to: 'ann', amount: 400 },
      ANN_PAYOUT,
      false,
      false,
      NOW,
    ).data!;

    const refused = aggregate.recordPayment(
      proposal,
      { id: 'pay-1', payUrl: 'https://pay.example/pay-1', fee: 0 },
      true,
      false,
    );

    expect(refused.error).toBeInstanceOf(GroupArchivedException);
    expect(aggregate.pullDomainEvents()).toEqual([]);
  });

  it('refuses a refund by GroupArchived before the provider is asked, and changes no settlement', () => {
    const aggregate = book();

    const refused = aggregate.proposeRefund(paid(), 'ann', true);

    expect(refused.error).toBeInstanceOf(GroupArchivedException);
    expect(aggregate.pullDomainEvents()).toEqual([]);
  });

  it('refuses a refund the provider accepted, when the group is archived, and records nothing', () => {
    const aggregate = book();

    const refused = aggregate.recordRefund(paid(), true, true);

    expect(refused.error).toBeInstanceOf(GroupArchivedException);
    expect(aggregate.pullDomainEvents()).toEqual([]);
  });

  it('refuses a webhook that would refund a paid settlement, and changes nothing', () => {
    const aggregate = book();

    const refused = aggregate.receive(paid(), 'refunded', true);

    expect(refused.error).toBeInstanceOf(GroupArchivedException);
    expect(aggregate.pullDomainEvents()).toEqual([]);
  });

  it('acknowledges a webhook that changes nothing in an archived group, without a refusal', () => {
    const aggregate = book();

    const unchanged = aggregate.receive(paid(), 'succeeded', true);

    expect(unchanged.isFailure()).toBe(false);
    expect(unchanged.data).toBeUndefined();
    expect(aggregate.pullDomainEvents()).toEqual([]);
  });
});
