import {
  SettlementBook,
  PaidSettlement,
  PendingSettlement,
  RefundSettlementCommand,
} from '@Contexts/Settlements/Domain/Settlement/SettlementBook';

/** A book with one settlement paid through the provider by Bob to Ann (30), its payment `pay-1`, as the store would read it. */
const paidPayment = (status: 'paid' | 'refunding' = 'paid'): PaidSettlement => ({
  id: 'settlement-1',
  from: 'bob',
  to: 'ann',
  amount: 30,
  providerPaymentId: 'pay-1',
  status,
});

const withPaid = (status?: 'paid' | 'refunding') =>
  SettlementBook.fromSnapshot({ groupId: 'group-1', version: 3, paid: [paidPayment(status)] });

const at = new Date('2026-11-17T10:00:00.000Z');

const refund = (overrides: Partial<RefundSettlementCommand> = {}): RefundSettlementCommand => ({
  by: 'ann',
  settlementId: 'settlement-1',
  members: ['ann', 'bob', 'cy'],
  ...overrides,
});

describe('refunding a settlement paid through the provider', () => {
  it('lets its payee ask, and answers the provider payment it is refunded by', () => {
    const book = withPaid();
    const asked = book.reserveRefund(refund());
    expect(asked.isSuccess() && asked.data.providerPaymentId).toBe('pay-1');
    expect(book.pullDomainEvents()).toEqual([]);
  });

  it('refuses another member, and says it is not allowed', () => {
    const refused = withPaid().reserveRefund(refund({ by: 'bob' }));
    expect(refused.isFailure() && refused.error.type).toBe('NotAllowed');
  });

  it('refuses a settlement that is not paid through the provider: a cash one, an unknown one, or one not paid', () => {
    expect(SettlementBook.fromSnapshot({ groupId: 'group-1', version: 0 }).reserveRefund(refund()).isFailure()).toBe(
      true,
    );
    expect(withPaid('refunding').reserveRefund(refund()).isFailure()).toBe(true);
    expect(
      withPaid()
        .reserveRefund(refund({ settlementId: 'settlement-9' }))
        .isFailure(),
    ).toBe(true);
  });

  it('refuses a settlement whose payer or payee has left the group, so the balances still add up to 0', () => {
    const payerLeft = withPaid().reserveRefund(refund({ members: ['ann', 'cy'] }));
    const payeeLeft = withPaid().reserveRefund(refund({ members: ['bob', 'cy'] }));
    expect(payerLeft.isFailure() && payerLeft.error.type).toBe('SettlementNotRefundable');
    expect(payeeLeft.isFailure() && payeeLeft.error.type).toBe('SettlementNotRefundable');
  });

  it('is refunding once the refund is recorded, asks the book for the event, and is still paid for the balances', () => {
    const book = withPaid();
    expect(book.recordRefund({ ...refund(), at }).isSuccess()).toBe(true);
    expect(book.moved).toEqual([{ id: 'settlement-1', status: 'refunding', at: at.toISOString() }]);
    expect(book.paid).toEqual([paidPayment('refunding')]);
    expect(book.pullDomainEvents()).toHaveLength(1);
  });

  it('refuses a second refund of the same settlement once it is refunding', () => {
    const book = withPaid();
    book.recordRefund({ ...refund(), at });
    expect(book.reserveRefund(refund()).isFailure()).toBe(true);
  });
});

describe('the provider says a settlement was refunded', () => {
  it('moves a paid settlement to refunded, once, and says so', () => {
    const book = withPaid();
    book.settleProviderPayment({ providerPaymentId: 'pay-1', status: 'refunded', at });
    expect(book.moved).toEqual([{ id: 'settlement-1', status: 'refunded', at: at.toISOString() }]);
    expect(book.paid).toEqual([]);
    expect(book.pullDomainEvents()).toHaveLength(1);

    book.settleProviderPayment({ providerPaymentId: 'pay-1', status: 'refunded', at });
    expect(book.moved).toHaveLength(1);
  });

  it('moves a refunding settlement to refunded when the refund is said to be done', () => {
    const book = withPaid('refunding');
    book.settleProviderPayment({ providerPaymentId: 'pay-1', status: 'refunded', at });
    expect(book.moved).toEqual([{ id: 'settlement-1', status: 'refunded', at: at.toISOString() }]);
  });

  it('lets a refunded that overtakes the success leave the settlement refunded: a success after it changes nothing', () => {
    const pending: PendingSettlement = {
      id: 'settlement-1',
      from: 'bob',
      to: 'ann',
      amount: 30,
      providerPaymentId: 'pay-1',
    };
    const book = SettlementBook.fromSnapshot({ groupId: 'group-1', version: 2, pending: [pending] });
    book.settleProviderPayment({ providerPaymentId: 'pay-1', status: 'refunded', at });
    book.settleProviderPayment({ providerPaymentId: 'pay-1', status: 'succeeded', at });
    book.settleProviderPayment({ providerPaymentId: 'pay-1', status: 'pending', at });
    expect(book.moved).toEqual([{ id: 'settlement-1', status: 'refunded', at: at.toISOString() }]);
    expect(book.pending).toEqual([]);
  });

  it('changes nothing for a payment it does not hold, or one already failed', () => {
    const book = withPaid();
    book.settleProviderPayment({ providerPaymentId: 'pay-9', status: 'refunded', at });
    expect(book.moved).toEqual([]);
    expect(book.pullDomainEvents()).toEqual([]);
  });

  it('refuses a snapshot whose paid settlement has another status', () => {
    expect(() =>
      SettlementBook.fromSnapshot({
        groupId: 'group-1',
        version: 0,
        paid: [{ ...paidPayment(), status: 'pending' as 'paid' }],
      }),
    ).toThrow();
  });
});
