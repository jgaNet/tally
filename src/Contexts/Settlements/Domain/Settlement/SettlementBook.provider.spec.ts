import { describe, expect, it } from '@jest/globals';

import {
  GroupNotFoundException,
  MoreThanPayerOwesException,
  ProviderUnavailableException,
} from '@Contexts/Settlements/Domain/Settlement/SettlementExceptions';
import {
  PaymentRequestedEvent,
  SettlementBook,
  SettlementFailedEvent,
  SettlementPaidEvent,
} from '@Contexts/Settlements/Domain/Settlement/SettlementBook';
import { Settlement } from '@Contexts/Settlements/Domain/Settlement/Settlement';
import { PayoutAccount } from '@Contexts/Settlements/Domain/PayoutAccount/PayoutAccount';
import { PayeeHasNoPayoutAccountException } from '@Contexts/Settlements/Domain/PayoutAccount/PayoutAccountExceptions';

const NOW = new Date('2026-03-01T10:00:00.000Z');

/** Ann's payout account at the provider, as the payout account is read for a payment to her (request 16). */
const ANN_PAYOUT = PayoutAccount.fromSnapshot({
  id: 'payout-ann',
  version: 1,
  ownerId: 'ann',
  providerAccountId: 'acct-ann',
});

/** Ann is owed 1000 by Bob; Cy owes 500 and Dan 500 (the balances add up to 0). Members in the order they joined. */
const book = (waiting: { from: string; to: string; amount: number }[] = []) =>
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
    waiting,
  });

/** A pending settlement through the provider, as the book keeps it once the provider has given its link. */
const pending: Settlement = {
  id: 'settlement-1',
  groupId: 'group-1',
  from: 'bob',
  to: 'ann',
  amount: 400,
  method: 'provider',
  status: 'pending',
  at: '2026-03-01T10:00:00.000Z',
  payment: { id: 'pay-1', payUrl: 'https://pay.example/pay-1' },
};

describe('a payment through the provider, decided by the book in two steps', () => {
  it('proposes a settlement with its identity only, and records nothing until the provider has given a link', () => {
    const aggregate = book();

    const proposed = aggregate.proposePayment({ from: 'bob', to: 'ann', amount: 400 }, ANN_PAYOUT, false, false, NOW);

    expect(proposed.isFailure()).toBe(false);
    expect(proposed.data).toEqual({
      id: expect.any(String),
      payee: 'acct-ann',
      from: 'bob',
      to: 'ann',
      amount: 400,
      at: NOW.toISOString(),
    });
    expect(aggregate.pullDomainEvents()).toEqual([]);
  });

  it('refuses a payment to a payee with no payout account, by name, before the provider is asked (request 16)', () => {
    const aggregate = book();

    const refused = aggregate.proposePayment({ from: 'bob', to: 'ann', amount: 400 }, undefined, false, false, NOW);

    expect(refused.error).toBeInstanceOf(PayeeHasNoPayoutAccountException);
    expect(refused.error?.type).toBe('PayeeHasNoPayoutAccount');
    // The rules of the book still come first: a payee who is not a member is the group's 404, whatever their account.
    expect(
      aggregate.proposePayment({ from: 'bob', to: 'zed', amount: 400 }, undefined, false, false, NOW).error,
    ).toBeInstanceOf(GroupNotFoundException);
  });

  it('refuses a proposal by the rules of a cash settlement, before the provider is asked', () => {
    expect(
      book().proposePayment({ from: 'bob', to: 'zed', amount: 400 }, ANN_PAYOUT, false, false, NOW).error,
    ).toBeInstanceOf(GroupNotFoundException);
    expect(
      book().proposePayment({ from: 'bob', to: 'ann', amount: 1001 }, ANN_PAYOUT, false, false, NOW).error,
    ).toBeInstanceOf(MoreThanPayerOwesException);
  });

  it('keeps the payment pending with the link, and records PaymentRequested', () => {
    const aggregate = book();
    const proposal = aggregate.proposePayment(
      { from: 'bob', to: 'ann', amount: 400 },
      ANN_PAYOUT,
      false,
      false,
      NOW,
    ).data!;

    const recorded = aggregate.recordPayment(
      proposal,
      { id: 'pay-1', payUrl: 'https://pay.example/pay-1' },
      false,
      false,
    );

    expect(recorded.data).toEqual({
      id: proposal.id,
      groupId: 'group-1',
      from: 'bob',
      to: 'ann',
      amount: 400,
      method: 'provider',
      status: 'pending',
      at: NOW.toISOString(),
      payment: { id: 'pay-1', payUrl: 'https://pay.example/pay-1' },
    });
    const events = aggregate.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toBeInstanceOf(PaymentRequestedEvent);
    expect(events[0].payload).toEqual({
      settlementId: proposal.id,
      groupId: 'group-1',
      from: 'bob',
      to: 'ann',
      amount: 400,
      at: NOW.toISOString(),
    });
  });

  it('is refused, and nothing kept, when the provider gave no link or one without its id or link', () => {
    const aggregate = book();
    const proposal = aggregate.proposePayment(
      { from: 'bob', to: 'ann', amount: 400 },
      ANN_PAYOUT,
      false,
      false,
      NOW,
    ).data!;

    expect(aggregate.recordPayment(proposal, undefined, false, false).error).toBeInstanceOf(
      ProviderUnavailableException,
    );
    expect(
      aggregate.recordPayment(proposal, { id: '', payUrl: 'https://pay.example/x' }, false, false).error,
    ).toBeInstanceOf(ProviderUnavailableException);
    expect(aggregate.recordPayment(proposal, { id: 'pay-1', payUrl: '' }, false, false).error).toBeInstanceOf(
      ProviderUnavailableException,
    );
    expect(aggregate.pullDomainEvents()).toEqual([]);
  });

  it('counts a payment waiting at the provider as paid for what is still owed, in the rules and the suggestions', () => {
    const aggregate = book([{ from: 'bob', to: 'ann', amount: 400 }]);

    expect(aggregate.balanceOf('ann')).toBe(600);
    expect(aggregate.balanceOf('bob')).toBe(-600);
    expect(aggregate.stillOwed()).toEqual([
      { memberId: 'ann', balance: 600 },
      { memberId: 'bob', balance: -600 },
      { memberId: 'cy', balance: -500 },
      { memberId: 'dan', balance: -500 },
    ]);
    expect(
      aggregate.proposePayment({ from: 'bob', to: 'ann', amount: 601 }, ANN_PAYOUT, false, false, NOW).error,
    ).toBeInstanceOf(MoreThanPayerOwesException);
    expect(
      aggregate.proposePayment({ from: 'bob', to: 'ann', amount: 600 }, ANN_PAYOUT, false, false, NOW).isFailure(),
    ).toBe(false);
  });
});

describe("the provider's verdict on a pending payment", () => {
  it('a payment that succeeded is paid, and SettlementPaid is recorded', () => {
    const aggregate = book();

    const changed = aggregate.receive(pending, 'succeeded', false).data;

    expect(changed).toEqual({ ...pending, status: 'paid' });
    const events = aggregate.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toBeInstanceOf(SettlementPaidEvent);
    expect(events[0].payload).toEqual({
      settlementId: 'settlement-1',
      groupId: 'group-1',
      from: 'bob',
      to: 'ann',
      amount: 400,
    });
  });

  it('a payment that failed is failed, and SettlementFailed is recorded', () => {
    const aggregate = book();

    expect(aggregate.receive(pending, 'failed', false).data).toEqual({ ...pending, status: 'failed' });
    const events = aggregate.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toBeInstanceOf(SettlementFailedEvent);
  });

  it('changes nothing for a verdict that is still pending, one not named, or a payment that already ended', () => {
    const aggregate = book();

    expect(aggregate.receive(pending, 'pending', false).data).toBeUndefined();
    expect(aggregate.receive(pending, 'voided', false).data).toBeUndefined();
    expect(aggregate.receive({ ...pending, status: 'paid' }, 'failed', false).data).toBeUndefined();
    expect(aggregate.receive({ ...pending, status: 'failed' }, 'succeeded', false).data).toBeUndefined();
    expect(aggregate.pullDomainEvents()).toEqual([]);
  });
});
