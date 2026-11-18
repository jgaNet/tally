import { describe, expect, it } from '@jest/globals';

import { NotAllowedException } from '@Architecture/Domain';

import {
  RefundPartyLeftException,
  RefundNotPayeeException,
  RefundUnavailableException,
  SettlementNotRefundableException,
} from '@Contexts/Settlements/Domain/Settlement/SettlementExceptions';
import {
  RefundRequestedEvent,
  SettlementBook,
  SettlementFailedEvent,
  SettlementPaidEvent,
  SettlementRefundedEvent,
} from '@Contexts/Settlements/Domain/Settlement/SettlementBook';
import { Settlement, SettlementStatus } from '@Contexts/Settlements/Domain/Settlement/Settlement';

/** Ann is owed 1000 by Bob; Cy owes 1000 and Dan is level (the balances add up to 0). Members in the order they joined. */
const book = (members = ['ann', 'bob', 'cy', 'dan']) =>
  SettlementBook.open({
    currency: 'EUR',
    groupId: 'group-1',
    version: 0,
    members,
    balances: [
      { memberId: 'ann', balance: 1000 },
      { memberId: 'bob', balance: -1000 },
      { memberId: 'cy', balance: 0 },
      { memberId: 'dan', balance: 0 },
    ],
  });

/** A settlement through the provider from Bob to Ann, in the given status. */
const provider = (status: SettlementStatus): Settlement => ({
  id: 'settlement-1',
  groupId: 'group-1',
  from: 'bob',
  to: 'ann',
  amount: 400,
  method: 'provider',
  status,
  at: '2026-03-01T10:00:00.000Z',
  payment: { id: 'pay-1', payUrl: 'https://pay.example/pay-1' },
});

/** A settlement recorded in cash from Bob to Ann. */
const cash: Settlement = {
  id: 'settlement-2',
  groupId: 'group-1',
  from: 'bob',
  to: 'ann',
  amount: 400,
  method: 'cash',
  status: 'paid',
  at: '2026-03-01T10:00:00.000Z',
};

describe('a refund asked by the payee of a settlement paid through the provider', () => {
  it('is proposed to the provider by the payment it was paid with, and recorded as refunding once the provider accepts it', () => {
    const aggregate = book();

    const proposed = aggregate.proposeRefund(provider('paid'), 'ann', false);
    expect(proposed.data).toEqual({ id: 'pay-1', payUrl: 'https://pay.example/pay-1' });

    const recorded = aggregate.recordRefund(provider('paid'), true, false);
    expect(recorded.data).toEqual({ ...provider('paid'), status: 'refunding' });
    const events = aggregate.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toBeInstanceOf(RefundRequestedEvent);
    expect(events[0].payload).toEqual({
      settlementId: 'settlement-1',
      groupId: 'group-1',
      from: 'bob',
      to: 'ann',
      amount: 400,
    });
  });

  it('is refused by the payer or any other member, with nothing proposed', () => {
    expect(book().proposeRefund(provider('paid'), 'bob', false).error).toBeInstanceOf(RefundNotPayeeException);
    expect(book().proposeRefund(provider('paid'), 'bob', false).error).toBeInstanceOf(NotAllowedException);
    expect(book().proposeRefund(provider('paid'), 'cy', false).error).toBeInstanceOf(RefundNotPayeeException);
  });

  it('is refused for a cash settlement, and for a payment that is not paid', () => {
    expect(book().proposeRefund(cash, 'ann', false).error).toBeInstanceOf(SettlementNotRefundableException);
    for (const status of ['pending', 'failed', 'refunding', 'refunded'] as const) {
      expect(book().proposeRefund(provider(status), 'ann', false).error).toBeInstanceOf(
        SettlementNotRefundableException,
      );
    }
  });

  it('is refused when its payer or its payee is no longer a member of the group', () => {
    expect(book(['ann', 'cy', 'dan']).proposeRefund(provider('paid'), 'ann', false).error).toBeInstanceOf(
      RefundPartyLeftException,
    );
    expect(book(['bob', 'cy', 'dan']).proposeRefund(provider('paid'), 'ann', false).error).toBeInstanceOf(
      RefundPartyLeftException,
    );
  });

  it('is refused, and nothing changes, when the provider did not accept it', () => {
    const aggregate = book();

    expect(aggregate.recordRefund(provider('paid'), false, false).error).toBeInstanceOf(RefundUnavailableException);
    expect(aggregate.pullDomainEvents()).toEqual([]);
  });
});

describe("the provider's verdict of refunded, with the payments moving forward only", () => {
  it('a payment that was paid, or refunding, is refunded, and SettlementRefunded is recorded', () => {
    for (const status of ['paid', 'refunding'] as const) {
      const aggregate = book();
      const changed = aggregate.receive(provider(status), 'refunded', false).data;

      expect(changed).toEqual({ ...provider(status), status: 'refunded' });
      const events = aggregate.pullDomainEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toBeInstanceOf(SettlementRefundedEvent);
    }
  });

  it('a refund that overtakes the success of its payment leaves it refunded, and a later success changes nothing', () => {
    const aggregate = book();

    const refunded = aggregate.receive(provider('pending'), 'refunded', false).data;
    expect(refunded).toEqual({ ...provider('pending'), status: 'refunded' });
    expect(aggregate.receive(refunded!, 'succeeded', false).data).toBeUndefined();
    expect(aggregate.receive(refunded!, 'pending', false).data).toBeUndefined();
  });

  it('a refunded said twice counts once, and a payment that failed is not refunded', () => {
    const aggregate = book();

    expect(aggregate.receive(provider('refunded'), 'refunded', false).data).toBeUndefined();
    expect(aggregate.receive(provider('failed'), 'refunded', false).data).toBeUndefined();
    expect(aggregate.pullDomainEvents()).toEqual([]);
  });

  it('a payment that succeeded still becomes paid, and only a pending one', () => {
    const aggregate = book();

    expect(aggregate.receive(provider('pending'), 'succeeded', false).data).toEqual({
      ...provider('pending'),
      status: 'paid',
    });
    expect(aggregate.pullDomainEvents()[0]).toBeInstanceOf(SettlementPaidEvent);
    expect(aggregate.receive(provider('paid'), 'succeeded', false).data).toBeUndefined();
    expect(aggregate.receive(provider('pending'), 'failed', false).data).toEqual({
      ...provider('pending'),
      status: 'failed',
    });
    expect(aggregate.pullDomainEvents()[0]).toBeInstanceOf(SettlementFailedEvent);
  });
});
