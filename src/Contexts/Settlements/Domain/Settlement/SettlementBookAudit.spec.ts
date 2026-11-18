import { PendingSettlement, SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';

/** A book with one settlement through the provider, Bob paying Ann 30, its payment `pay-1` still pending, as the store would read it. */
const pendingPayment = (): PendingSettlement => ({
  id: 'settlement-1',
  from: 'bob',
  to: 'ann',
  amount: 30,
  providerPaymentId: 'pay-1',
});

const at = new Date('2026-11-17T10:00:00.000Z');

describe('the changes of money a settlement book makes (request 28, docs/adr/0027)', () => {
  it('a provider payment that succeeds is paid, by its payer, once', () => {
    const book = SettlementBook.fromSnapshot({ groupId: 'group-1', version: 2, pending: [pendingPayment()] });
    book.settleProviderPayment({ providerPaymentId: 'pay-1', status: 'succeeded', at });
    book.settleProviderPayment({ providerPaymentId: 'pay-1', status: 'succeeded', at });
    expect(book.audited).toEqual([
      {
        id: expect.any(String),
        action: 'settlement-paid',
        by: 'bob',
        subjectId: 'settlement-1',
        amount: 30,
        at: at.toISOString(),
      },
    ]);
  });

  it('a refund of a payment the balances counted is refunded, by its payee', () => {
    const book = SettlementBook.fromSnapshot({
      groupId: 'group-1',
      version: 3,
      paid: [{ ...pendingPayment(), status: 'paid' }],
    });
    book.settleProviderPayment({ providerPaymentId: 'pay-1', status: 'refunded', at });
    expect(book.audited).toEqual([
      {
        id: expect.any(String),
        action: 'settlement-refunded',
        by: 'ann',
        subjectId: 'settlement-1',
        amount: 30,
        at: at.toISOString(),
      },
    ]);
  });

  it('a refund that overtakes a pending payment is no change of money, as the balances never counted it', () => {
    const book = SettlementBook.fromSnapshot({ groupId: 'group-1', version: 2, pending: [pendingPayment()] });
    book.settleProviderPayment({ providerPaymentId: 'pay-1', status: 'refunded', at });
    expect(book.moved).toEqual([{ id: 'settlement-1', status: 'refunded', at: at.toISOString() }]);
    expect(book.audited).toEqual([]);
  });

  it('a payment that fails is no change of money', () => {
    const book = SettlementBook.fromSnapshot({ groupId: 'group-1', version: 2, pending: [pendingPayment()] });
    book.settleProviderPayment({ providerPaymentId: 'pay-1', status: 'failed', at });
    expect(book.audited).toEqual([]);
  });
});
